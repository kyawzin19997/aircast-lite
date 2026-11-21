'use strict';

const AirCastSealed = (() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const authenticationError = 'Incorrect password or corrupted room data.';
  const iterations = 600000;
  const signatureAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
  const ellipticCurve = { name: 'ECDSA', namedCurve: 'P-256' };
  const random = (length) => crypto.getRandomValues(new Uint8Array(length));
  const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const decode = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
  const error = (message, code) => Object.assign(new Error(message), { code });
  const recoveryKey = (room) => 'aircast-sealed-host:' + room;

  function requireCrypto() {
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || globalThis.location?.protocol === 'file:') {
      throw new Error('Encrypted rooms require HTTPS or localhost.');
    }
  }

  async function derive(password, salt) {
    const bytes = encoder.encode(password);
    try {
      const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
      return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally { bytes.fill(0); }
  }

  function cipher(iv, room, expires, scope) {
    return { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(['aircast-room-v1', scope, room, expires])) };
  }

  async function create(room, password, expires) {
    requireCrypto();
    if (password.length < 12 || password.length > 128) throw new Error('Use 12–128 characters for the room password.');
    const salt = random(16);
    const key = await derive(password, salt);
    const host = await crypto.subtle.generateKey(ellipticCurve, true, ['sign', 'verify']);
    const seed = random(32);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', host.publicKey));
    const manifest = new Uint8Array(97);
    manifest.set(seed);
    manifest.set(publicKey, 32);
    const roomIV = random(12);
    const hostIV = random(12);
    const hostBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', host.privateKey));
    try {
      const encrypted = await crypto.subtle.encrypt(cipher(roomIV, room, expires, 'manifest'), key, manifest);
      const recovery = await crypto.subtle.encrypt(cipher(hostIV, room, expires, 'host'), key, hostBytes);
      return {
        envelope: ['1', expires, encode(salt), encode(roomIV), encode(encrypted)].join('.'),
        recovery: [encode(hostIV), encode(recovery)].join('.'),
        access: await credentials(room, expires, seed, host.publicKey, host.privateKey)
      };
    } finally { seed.fill(0); manifest.fill(0); hostBytes.fill(0); }
  }

  async function unlock(room, envelope, password, recovery) {
    requireCrypto();
    const parsed = parse(envelope);
    if (password === undefined) {
      if (parsed) checkExpiry(parsed.expires);
      throw error('Enter the password to decrypt this room.', 'ROOM_PASSWORD');
    }
    try {
      if (!parsed || password.length > 128) throw new Error(authenticationError);
      const { expires, salt, iv, encrypted } = parsed;
      const key = await derive(password, decode(salt));
      const manifest = new Uint8Array(await crypto.subtle.decrypt(cipher(decode(iv), room, expires, 'manifest'), key, decode(encrypted)));
      try {
        const host = await crypto.subtle.importKey('raw', manifest.subarray(32), ellipticCurve, false, ['verify']);
        let signingKey;
        if (recovery) {
          const [recoveryIV, ciphertext] = recovery.split('.');
          const bytes = new Uint8Array(await crypto.subtle.decrypt(cipher(decode(recoveryIV), room, expires, 'host'), key, decode(ciphertext)));
          try { signingKey = await crypto.subtle.importKey('pkcs8', bytes, ellipticCurve, false, ['sign']); }
          finally { bytes.fill(0); }
        }
        return await credentials(room, expires, manifest.subarray(0, 32), host, signingKey);
      } finally { manifest.fill(0); }
    } catch (failure) {
      if (failure.code === 'ROOM_EXPIRED') throw failure;
      throw error(authenticationError, 'ROOM_PASSWORD');
    }
  }

  function parse(envelope) {
    const match = typeof envelope === 'string' && /^1\.(0|[1-9]\d{12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{151})$/.exec(envelope);
    if (!match) return null;
    return { expires: Number(match[1]), salt: match[2], iv: match[3], encrypted: match[4] };
  }

  async function credentials(room, expires, seed, publicKey, signingKey) {
    checkExpiry(expires);
    const key = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const route = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('aircast-routing-v1:' + room)));
    const namespace = Array.from(route.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { room, expires, namespace, gate: (connection, local, allow, denied) =>
      authenticate(connection, local, allow, denied, { key, expires, publicKey, signingKey }) };
  }

  function checkExpiry(expires) {
    if (expires && expires <= Date.now()) throw error('This room has expired.', 'ROOM_EXPIRED');
  }

  function fingerprints(description) {
    const values = [...(description?.sdp || '').matchAll(/^a=fingerprint:(.+)$/gm)].map((match) => match[1].trim());
    if (!values.length) throw new Error('The connection has no transport identity.');
    return [...new Set(values)].sort();
  }

  function transcript(connection, identity, first, second, remote) {
    const pc = connection.peerConnection;
    const local = [connection.provider?.id || connection.localId, fingerprints(pc?.localDescription)];
    const peer = [connection.peer, fingerprints(pc?.remoteDescription)];
    const metadata = connection.metadata || {};
    return encoder.encode(JSON.stringify(['aircast-peer-proof-v1', remote ? peer : local, remote ? local : peer, first, second,
      identity.role, identity.slot, metadata.role, metadata.slot, metadata.identity, metadata.smoothProgram, metadata.programLayout]));
  }

  function authenticate(connection, local, allow, denied = () => {}, access) {
    return new Promise((resolve, reject) => {
      const nonce = encode(random(24));
      const pending = [];
      let sendNonce;
      let sent;
      let verified;
      let ready;
      let admitted;
      let closed;
      let receive;
      let handshakePackets = 0;
      const timeout = setTimeout(() => fail(new Error('Encrypted room verification timed out.')), 8500);
      function fail(failure) {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        reject(failure);
        denied(failure);
        connection.close();
      }
      function finish() {
        if (!sent || !verified || !ready || admitted || closed) return;
        admitted = true;
        clearTimeout(timeout);
        resolve({
          get open() { return connection.open; },
          get peerConnection() { return connection.peerConnection; },
          metadata: connection.metadata,
          peer: connection.peer,
          on(event, callback) {
            if (event !== 'data') return connection.on(event, callback);
            receive = callback;
            setTimeout(() => pending.splice(0).forEach(receive), 0);
          },
          send: (message) => connection.send(message),
          close: () => connection.close()
        });
      }
      const hello = () => connection.send({ type: 'sealed-hello', nonce });
      const verify = async (message) => {
        checkExpiry(access.expires);
        if (message?.type === 'sealed-hello' && !sendNonce && /^[\w-]{32}$/.test(message.nonce)) {
          sendNonce = message.nonce;
          const bytes = transcript(connection, local, sendNonce, nonce, false);
          const mac = encode(await crypto.subtle.sign('HMAC', access.key, bytes));
          const signature = local.role === 'host' ? encode(await crypto.subtle.sign(signatureAlgorithm, access.signingKey, bytes)) : undefined;
          connection.send({ type: 'sealed-proof', ...local, mac, signature });
          sent = true;
        } else if (message?.type === 'sealed-proof' && sendNonce && !verified && /^[\w-]{43}$/.test(message.mac) && allow(message)) {
          const bytes = transcript(connection, message, nonce, sendNonce, true);
          if (!await crypto.subtle.verify('HMAC', access.key, decode(message.mac), bytes)) throw new Error('Encrypted room peer verification failed.');
          if (message.role === 'host' && (!/^[\w-]{86}$/.test(message.signature) ||
              !await crypto.subtle.verify(signatureAlgorithm, access.publicKey, decode(message.signature), bytes))) {
            throw new Error('The Studio host could not be verified.');
          }
          verified = true;
          connection.send({ type: 'sealed-ready' });
        } else if (message?.type === 'sealed-ready' && verified) {
          ready = true;
        } else {
          throw new Error('Encrypted room peer verification failed.');
        }
        finish();
      };
      let handshake = Promise.resolve();
      connection.on('data', (message) => {
        if (closed) return;
        if (admitted) {
          if (receive) receive(message);
          else if (pending.length < 32) pending.push(message);
          return;
        }
        if (++handshakePackets > 8) { fail(new Error('Too many encrypted room handshake messages.')); return; }
        handshake = handshake.then(() => { if (!closed) return verify(message); }).catch(fail);
      });
      connection.on('close', () => {
        closed = true;
        clearTimeout(timeout);
        reject(new Error('Encrypted connection closed.'));
      });
      try {
        if (connection.open) hello();
        else connection.on('open', hello);
      } catch (failure) { fail(failure); }
    });
  }

  async function request(method, room, envelope) {
    if (!/^https?:$/.test(location.protocol)) return null;
    const url = new URL('api/rooms', location.href);
    url.searchParams.set('room', room);
    const response = await fetch(url, { method, body: envelope, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3500) });
    if ([404, 405, 501].includes(response.status)) return null;
    if (response.status === 410) throw error('This room has expired.', 'ROOM_EXPIRED');
    if (!response.ok) throw new Error('Encrypted room storage is temporarily unavailable.');
    if (method === 'POST') return response.status === 201;
    if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/vnd.aircast.room') return null;
    return response.text();
  }

  function link(address, envelope, stored) {
    const url = new URL(address);
    url.searchParams.set('sealed', '1');
    if (!stored) url.hash = new URLSearchParams({ room: envelope }).toString();
    return url.href;
  }

  return { create, unlock, request, link, checkExpiry, recoveryKey };
})();

if (typeof module !== 'undefined') module.exports = AirCastSealed;
