'use strict';

const AirCastRooms = (() => {
  const room = (value) => typeof value === 'string' && /^[A-Z0-9]{3,16}$/i.test(value) ? value.toUpperCase() : '';
  const slot = (value) => typeof value === 'string' && /^CAM(?:[1-9]|1\d|2[0-4])$/i.test(value) ? value.toUpperCase() : '';
  const capability = (value) => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value) ? value : '';

  function output(query) {
    const roomParam = query.get('room');
    const legacy = roomParam !== null && query.get('obs') === 'direct';
    const cameraNumber = query.get('c');
    const rawSlot = query.get('cam') || (cameraNumber !== null ? 'CAM' + cameraNumber : legacy ? 'CAM1' : '');
    const camera = slot(rawSlot);
    return { room: room(roomParam ?? query.get('obs')), slot: camera, invalidSlot: Boolean(rawSlot && !camera) };
  }

  function joinTarget(input, base, role, camera) {
    const code = room(input.trim());
    let url;
    if (code) {
      url = new URL(base);
      url.search = '';
      url.hash = '';
      if (role === 'contributor') {
        url.searchParams.set('mode', 'sender');
        url.searchParams.set('room', code);
        url.searchParams.set('cam', camera || 'CAM1');
      } else {
        url.searchParams.set('obs', code);
      }
      return url;
    }
    try { url = new URL(input.trim(), base); } catch { return null; }
    const current = new URL(base);
    const scope = new URL('.', current).pathname;
    if (url.origin !== current.origin || url.username || url.password || ![scope, scope + 'index.html'].includes(url.pathname)) return null;
    const query = url.searchParams;
    const sender = query.get('mode') === 'sender' && room(query.get('room'));
    const receiver = (query.has('obs') || query.get('clean') === 'true') && output(query).room && !output(query).invalidSlot;
    return sender || receiver ? url : null;
  }

  function endpoint(code, camera, managed = false) {
    if (managed) return camera ? 'AIRCAST-PRIVATE-CAM-' + code + '-' + camera : 'AIRCAST-PRIVATE-HUB-' + code;
    return camera ? 'AIRCAST-CAMERA-' + code + '-' + camera : 'AIRCAST-HUB3-' + code;
  }

  const key = (code) => 'aircast-private:' + code;
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const random = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
  const encoder = new TextEncoder();
  function fingerprints(description) {
    const values = [...(description?.sdp || '').matchAll(/^a=fingerprint:(.+)$/gm)].map((match) => match[1].trim());
    if (!values.length) throw new Error('The private connection has no transport identity.');
    return [...new Set(values)].sort();
  }

  function encodeProof(connection, id, first, second, remote) {
    const local = connection.provider?.id || connection.localId;
    const pc = connection.peerConnection;
    const sender = remote ? [connection.peer, fingerprints(pc?.remoteDescription)] : [local, fingerprints(pc?.localDescription)];
    const receiver = remote ? [local, fingerprints(pc?.localDescription)] : [connection.peer, fingerprints(pc?.remoteDescription)];
    return encoder.encode(JSON.stringify(['aircast-room-v1', id, first, second, sender, receiver]));
  }

  async function request(op, args = {}, keepalive = false) {
    const response = await fetch(new URL('api/rooms', location.href), {
      method: 'POST', cache: 'no-store', redirect: 'error', keepalive, signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...args })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'Room services are unavailable on this deployment.'), { code: result.code, status: response.status });
    return result;
  }

  function remember(code, secret) { sessionStorage.setItem(key(code), secret); }

  async function managed(code) {
    if (!/^[A-F0-9]{16}$/.test(code)) return false;
    try { return (await request('info', { room: code })).exists === true; }
    catch (error) {
      if (error.status === 410) throw error;
      return false;
    }
  }

  async function enter(code, role, camera, password) {
    const url = new URL(location.href);
    const inLink = capability(new URLSearchParams(url.hash.slice(1)).get('ticket'));
    const sessionKey = role === 'host' ? key(code) : key(code) + ':' + role;
    let secret = password === undefined ? inLink || capability(sessionStorage.getItem(sessionKey)) : '';
    if (!code || (role === 'host' && !secret)) throw new Error('Return to the original Studio tab to manage this room.');
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const details = { room: code, password, role, slot: camera, publicKey };
    let access;
    try {
      access = await request('enter', { ...details, secret });
    } catch (error) {
      if (role !== 'viewer' || inLink || !secret || error.status !== 403) throw error;
      secret = '';
      sessionStorage.removeItem(sessionKey);
      access = await request('enter', details);
    }
    if (access.resume || secret) sessionStorage.setItem(sessionKey, access.resume || secret);
    if (inLink && role !== 'viewer') {
      url.hash = '';
      history.replaceState(null, '', url);
    }
    const touch = setInterval(() => request('alive', { room: code, session: access.session }).catch(() => {}), 240000);
    window.addEventListener('pagehide', () => {
      clearInterval(touch);
      request('leave', { room: code, session: access.session }, true).catch(() => {});
    }, { once: true });
    return {
      ...access,
      request: (op, payload = {}) => request(op, { ...payload, room: code, session: access.session }),
      gate: (connection, allow, onDenied) => gate(connection, allow, access, code, keys.privateKey, onDenied)
    };
  }

  function gate(connection, allow, access, code, privateKey, onDenied = () => {}) {
    const nonce = random(24);
    const incoming = new Promise((resolve, reject) => {
      let verified = false;
      let sent = false;
      let ready = false;
      let grant;
      let challenge = false;
      const queue = [];
      let receive;
      let poll;
      const timeout = setTimeout(() => fail(new Error('Private room verification timed out.')), 8500);
      const fail = (error) => {
        clearTimeout(timeout);
        clearInterval(poll);
        reject(error);
        onDenied(error);
        connection.close();
      };
      const finish = (remoteId) => {
        if (!verified || !sent || !ready || poll) return;
        clearTimeout(timeout);
        let reading = false;
        poll = setInterval(async () => {
          if (reading) return;
          reading = true;
          try {
            const peer = await request('verify', { room: code, session: access.session, remoteId, peer: connection.peer });
            if (!allow(peer)) throw new Error('Private room access was revoked.');
          } catch (error) { fail(error); }
          finally { reading = false; }
        }, 12000);
        const admitted = {
          get open() { return connection.open; },
          get peerConnection() { return connection.peerConnection; },
          metadata: connection.metadata,
          peer: connection.peer,
          grant,
          on(event, callback) {
            if (event !== 'data') return connection.on(event, callback);
            receive = callback;
            setTimeout(() => queue.splice(0).forEach(receive), 0);
          },
          send: (value) => connection.send(value),
          close: () => connection.close()
        };
        resolve(admitted);
      };
      let remoteId;
      connection.on('close', () => {
        clearTimeout(timeout);
        clearInterval(poll);
        reject(new Error('Private connection closed.'));
      });
      const hello = () => connection.send({ type: 'room-challenge', nonce });
      if (connection.open) hello();
      else connection.on('open', hello);
      connection.on('data', async (message) => {
        try {
          if (message?.type === 'room-challenge' && !challenge && capability(message.nonce)) {
            challenge = true;
            const proof = encodeProof(connection, access.id, message.nonce, nonce, false);
            const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, proof);
            connection.send({ type: 'room-proof', id: access.id, nonce, signature: hex(new Uint8Array(signature)) });
            sent = true;
            finish(remoteId);
          } else if (message?.type === 'room-proof' && !remoteId && capability(message.id) && capability(message.nonce) && /^[a-f0-9]{128}$/.test(message.signature)) {
            remoteId = message.id;
            const peer = await request('verify', { room: code, session: access.session, remoteId, peer: connection.peer });
            if (!allow(peer)) throw new Error('This invitation does not allow that connection.');
            const pub = await crypto.subtle.importKey('jwk', peer.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const proof = encodeProof(connection, message.id, nonce, message.nonce, true);
            if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Uint8Array.from(message.signature.match(/../g), (byte) => parseInt(byte, 16)), proof)) {
              throw new Error('The remote private-room identity could not be verified.');
            }
            verified = true;
            grant = peer.grant;
            connection.send({ type: 'room-ready' });
            finish(remoteId);
          } else if (message?.type === 'room-ready') {
            ready = true;
            finish(remoteId);
          } else if (verified && ready && sent) {
            if (receive) receive(message);
            else if (queue.length < 32) queue.push(message);
          }
        } catch (error) { fail(error); }
      });
    });
    return incoming;
  }

  return { room, slot, output, joinTarget, endpoint, request, remember, managed, enter };
})();

if (typeof module !== 'undefined') module.exports = AirCastRooms;
