import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { onRequest } from '../functions/api/rooms.js';
import { inMemoryBucket } from './server.mjs';

function classic(name) {
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL('../public/' + name, import.meta.url), 'utf8'),
    { module, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, btoa, atob, crypto, Date, setTimeout, clearTimeout, isSecureContext: true });
  return module.exports;
}

const rooms = classic('aircast-rooms.js');
const stats = classic('aircast-diagnostics.js');
const sealed = classic('aircast-sealed.js');

test('legacy and extended camera URLs retain their room and slot', () => {
  for (const [value, room, slot] of [
    ['?obs=ROOM&c=1','ROOM','CAM1'],['?room=ROOM&obs=1&cam=CAM1','ROOM','CAM1'],
    ['?room=ROOM&obs=direct','ROOM','CAM1'],['?room=ROOM&clean=true','ROOM',''],['?obs=ROOM&c=24','ROOM','CAM24']
  ]) {
    const output = rooms.output(new URLSearchParams(value));
    assert.equal(output.room, room);
    assert.equal(output.slot, slot);
    assert.equal(output.invalidSlot, false);
  }
  assert.equal(rooms.output(new URLSearchParams('?obs=ROOM&c=25')).invalidSlot, true);
  assert.equal(rooms.joinTarget('https://elsewhere.invalid/?obs=ROOM','https://example.test/index.html','viewer'), null);
  assert.equal(rooms.joinTarget('ROOM','https://example.test/index.html','contributor','CAM20').searchParams.get('cam'), 'CAM20');
});

test('stats calculate interval bitrate and loss only from valid deltas', () => {
  const report = (timestamp, bytesReceived, packetsReceived, packetsLost) => new Map([
    ['v', { id: 'v', type: 'inbound-rtp', kind: 'video', ssrc: 1, timestamp, bytesReceived, packetsReceived, packetsLost }],
    ['t', { type:'transport', selectedCandidatePairId:'p' }], ['p', { localCandidateId:'l', currentRoundTripTime:.04 }],
    ['l', { candidateType:'relay' }]
  ]);
  const first = stats.sample(report(1000,10,10,0));
  const next = stats.sample(report(2000,100010,105,5), first.base);
  assert.equal(next.kbps, 800);
  assert.equal(next.loss, 5);
  assert.equal(next.path, 'Relayed');
  assert.equal(next.rtt, .04);
  assert.equal(stats.sample(report(3000,3,1,1),next.base).loss, null);
});

test('room encryption uses independent nonces and authenticates password, room ID, and ciphertext', async () => {
  const room = 'AIRCASTROOM22222';
  const password = 'private broadcast passphrase';
  const first = await sealed.create(room, password, 0);
  const second = await sealed.create(room, password, 0);
  const [, , salt, iv, ciphertext] = first.envelope.split('.');
  assert.notEqual(salt, second.envelope.split('.')[2]);
  assert.notEqual(iv, second.envelope.split('.')[3]);
  assert.notEqual(iv, first.recovery.split('.')[0]);
  const fromGuest = await sealed.unlock(room, first.envelope, password);
  const fromHost = await sealed.unlock(room, first.envelope, password, first.recovery);
  assert.equal(fromGuest.namespace, first.access.namespace);
  assert.equal(fromHost.namespace, first.access.namespace);
  assert.notEqual(first.access.namespace, second.access.namespace);
  const tampered = first.envelope.replace(ciphertext, (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1));
  const failed = { message: 'Incorrect password or corrupted room data.', code: 'ROOM_PASSWORD' };
  await assert.rejects(sealed.unlock(room, first.envelope, 'incorrect passphrase'), failed);
  await assert.rejects(sealed.unlock(room, tampered, password), failed);
  await assert.rejects(sealed.unlock('AIRCASTROOM33333', first.envelope, password), failed);
  const output = new URL(await first.access.watchLink(new URL('https://aircast.test/?obs=' + room + '&c=1'), 'CAM1'));
  const ticket = new URLSearchParams(output.hash.slice(1)).get('watch');
  const camera = await sealed.watch(room, ticket, first.envelope, 'CAM1');
  assert.equal(camera.scope, 'CAM1');
  assert.equal(camera.watchLink, undefined);
  await assert.rejects(sealed.watch(room, ticket, first.envelope, 'CAM2'), { message: 'This OBS link cannot open that camera.' });
});

test('encrypted links authenticate the live transport and require the creator signature for Studio', async () => {
  const code = 'AIRCASTROOM22222';
  const password = 'private broadcast passphrase';
  const { access: host, envelope } = await sealed.create(code, password, 0);
  const viewer = await sealed.unlock(code, envelope, password);
  const link = (local, remote, received = remote) => Object.assign(new EventEmitter(), {
    open: true, provider: { id: local }, peer: remote,
    metadata: { role: 'output', slot: '', programLayout: true },
    peerConnection: {
      localDescription: { sdp: 'a=fingerprint:fixture ' + local },
      remoteDescription: { sdp: 'a=fingerprint:fixture ' + received }
    }
  });
  async function connect(publisher, hostFingerprint = 'studio') {
    const studio = link('studio', 'obs');
    const obs = link('obs', 'studio', hostFingerprint);
    for (const [from, to] of [[studio, obs], [obs, studio]]) {
      from.send = (message) => queueMicrotask(() => to.emit('data', message));
      from.close = () => {
        if (!from.open) return;
        from.open = to.open = false;
        from.emit('close');
        to.emit('close');
      };
    }
    return Promise.allSettled([
      publisher.gate(studio, { role: 'host', slot: '' }, (peer) => peer.role === 'viewer'),
      viewer.gate(obs, { role: 'viewer', slot: '' }, (peer) => peer.role === 'host')
    ]);
  }
  const result = await connect(host);
  assert.ok(result.every((endpoint) => endpoint.status === 'fulfilled'));
  result[0].value.close();
  assert.ok((await connect(viewer)).every((endpoint) => endpoint.status === 'rejected'));
  assert.ok((await connect(host, 'substituted')).every((endpoint) => endpoint.status === 'rejected'));
});

test('R2 accepts only encrypted manifests or public expiry metadata, with immutable writes and expiring reads', async (t) => {
  const origin = 'https://aircast.test';
  const room = 'AIRCASTROOM22222';
  const address = origin + '/api/rooms?room=' + room;
  const expires = Date.now() + 3600000;
  const env = { ROOM_ENVELOPES: inMemoryBucket() };
  const send = (method, body, site = origin, runtime = env) => onRequest({
    env: runtime, request: new Request(address, { method, body, headers: { Origin: site } })
  });
  const { envelope } = await sealed.create(room, 'private broadcast passphrase', expires);
  assert.equal((await send('POST', envelope, origin, {})).status, 501);
  assert.equal((await send('POST', '{"password":"plaintext"}')).status, 400);
  assert.equal((await send('POST', envelope, 'https://elsewhere.invalid')).status, 403);
  assert.equal((await send('POST', envelope)).status, 201);
  assert.equal((await send('POST', '0.' + expires)).status, 409);
  assert.equal((await send('DELETE')).status, 405);
  const stored = await send('GET');
  assert.equal(await stored.text(), envelope);
  assert.equal(stored.headers.get('Cache-Control'), 'no-store');
  t.mock.method(Date, 'now', () => expires + 1);
  assert.equal((await send('GET')).status, 410);
  await assert.rejects(sealed.unlock(room, envelope, 'private broadcast passphrase'), { code: 'ROOM_EXPIRED' });
});

test('R2 reserves an exact custom ID for an open room without expiry', async () => {
  const origin = 'https://aircast.test';
  const env = { ROOM_ENVELOPES: inMemoryBucket() };
  const address = origin + '/api/rooms?room=STAGE1';
  const send = (method, body) => onRequest({ env, request: new Request(address, { method, body, headers: { Origin: origin } }) });
  const record = '2.0.AIRCASTROOM22222';
  assert.equal((await send('POST', record)).status, 201);
  assert.equal((await send('POST', '2.0.AIRCASTROOM33333')).status, 409);
  assert.equal(await (await send('GET')).text(), record);
});
