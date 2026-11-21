import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { onRequest } from '../functions/api/rooms.js';
import { inMemoryAuthority } from './server.mjs';

function classic(name) {
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL('../public/' + name, import.meta.url), 'utf8'), { module, URL, TextEncoder });
  return module.exports;
}

const rooms = classic('aircast-rooms.js');
const stats = classic('aircast-diagnostics.js');

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
  assert.notEqual(rooms.endpoint('ROOM','CAM1'), rooms.endpoint('ROOM','CAM1',true));
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

test('authority separates host, contributor, and viewer and revokes both session and invite', async () => {
  const env = { ROOMS: inMemoryAuthority() };
  const origin = 'https://aircast.test';
  const call = async (data, status = 200, headers = {}) => {
    const response = await onRequest({ env, request: new Request(origin + '/api/rooms', { method:'POST',
      headers:{ Origin: origin, 'Content-Type':'application/json', ...headers }, body:JSON.stringify(data) }) });
    assert.equal(response.status, status, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    return response.json();
  };
  const { room, secret } = await call({ op:'create' });
  const keys = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, false, ['sign','verify']);
  const publicKey = await crypto.subtle.exportKey('jwk',keys.publicKey);
  const enter = (secret,role,slot,status) => call({ op:'enter',room,secret,role,slot,publicKey },status);
  const host = await enter(secret,'host','');
  const contributor = await call({ op:'invite',room,session:host.session,role:'contributor',slot:'CAM10' });
  const viewer = await call({ op:'invite',room,session:host.session,role:'viewer',slot:'CAM10' });
  await enter(viewer.secret,'contributor','CAM10',403);
  await enter(viewer.secret,'viewer','CAM1',403);
  const camera = await enter(contributor.secret,'contributor','CAM10');
  const obs = await enter(viewer.secret,'viewer','CAM10');
  await call({ op:'invite',room,session:obs.session,role:'viewer',slot:'' },403);
  const remote = await call({ op:'verify',room,session:obs.session,remoteId:camera.id,peer:camera.peer });
  assert.equal(remote.role,'contributor');
  assert.equal(remote.slot,'CAM10');
  await call({ op:'verify',room,session:obs.session,remoteId:camera.id,peer:host.peer },403);
  await call({ op:'revoke',room,session:host.session,id:viewer.id });
  await call({ op:'verify',room,session:obs.session,remoteId:camera.id,peer:camera.peer },403);
  await enter(viewer.secret,'viewer','CAM10',403);
  await call({ op:'list',room,session:host.session },403,{ Origin:'https://outside.invalid' });
});
