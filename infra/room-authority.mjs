const week = 7 * 24 * 60 * 60 * 1000;
const sessionIdle = 30 * 60 * 1000;
const roles = new Set(['viewer', 'contributor']);
const slotId = /^CAM(?:[1-9]|1\d|2[0-4])$/;
const secretId = /^[a-f0-9]{48}$/;
const random = (size) => Array.from(crypto.getRandomValues(new Uint8Array(size)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const fingerprint = async (secret) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
async function passwordHash(password, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}

export const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const error = (message, status = 400) => json({ error: message }, status);

function peerMatches(peer, id, role) {
  if (typeof peer !== 'string' || peer.length > 90) return false;
  return role === 'viewer' ? peer.startsWith(id + '-') && /^[A-Z0-9]{12}$/.test(peer.slice(id.length + 1)) : peer === id;
}

export class RoomAuthority {
  constructor(ctx) { this.storage = ctx.storage; }

  async fetch(request) {
    const data = await request.json();
    return this.storage.transaction(async (tx) => {
      const now = Date.now();
      if (data.op === 'rate') {
        const seconds = data.burst || data.password ? 60 : 300;
        const bucket = 'rate:' + (data.password ? 'password' : seconds);
        const limit = data.password ? 10 : data.burst ? 180 : 5;
        const current = await tx.get(bucket);
        const next = current && current.until > now ? current : { until: now + seconds * 1000, count: 0 };
        if (++next.count > limit) return error('Too many room requests. Try again shortly.', 429);
        await tx.put(bucket, next);
        return json({ ok: true });
      }

      const state = await tx.get('room');
      if (data.op === 'create') {
        if (state) return error('Room already exists.', 409);
        const secret = random(24);
        const grant = { id: random(12), role: 'host', slot: '', hash: await fingerprint(secret) };
        const openJoin = data.openJoin === true;
        const password = data.password ?? '';
        if (typeof password !== 'string' || password.length > 128 || (password && password.length < 6)) return error('Use 6–128 characters for a room password.');
        if (openJoin && ![0, 1, 4, 12, 24, 168].includes(data.hours)) return error('Choose a valid room expiration.');
        const salt = password ? random(16) : '';
        const expires = openJoin ? (data.hours ? now + data.hours * 3600000 : null) : now + week;
        await tx.put('room', { expires, openJoin, salt, password: password ? await passwordHash(password, salt) : '', grants: [grant], sessions: [] });
        return json({ room: data.room, secret });
      }
      if (data.op === 'info' && !state) return json({ exists: false });
      if (!state) return error('This room does not exist.', 404);
      if (state.expires && state.expires <= now) return json({ error: 'This room has expired.', code: 'ROOM_EXPIRED' }, 410);
      if (data.op === 'info') return json({ exists: true, openJoin: Boolean(state.openJoin), passwordRequired: Boolean(state.password), expires: state.expires });
      state.sessions = state.sessions.filter((entry) => now - entry.seen < sessionIdle);
      state.grants = state.grants.filter((entry) => !entry.guest || now - entry.seen < sessionIdle
        || state.sessions.some((session) => session.grant === entry.id));

      if (data.op === 'enter') {
        const jwk = data.publicKey;
        if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !/^[\w-]{43}$/.test(jwk.x) || !/^[\w-]{43}$/.test(jwk.y) || jwk.d) return error('Invalid public key.');
        let grant;
        let resume;
        if (typeof data.secret === 'string' && secretId.test(data.secret)) {
          const hash = await fingerprint(data.secret);
          grant = state.grants.find((entry) => entry.hash === hash && entry.role === data.role);
        } else if (state.openJoin && roles.has(data.role)) {
          if (data.role === 'contributor' && (typeof data.slot !== 'string' || !slotId.test(data.slot))) return error('Choose a camera slot.');
          const password = data.password ?? '';
          if (state.password && (typeof password !== 'string' || password.length > 128 || !password || await passwordHash(password, state.salt) !== state.password)) {
            return json({ error: password ? 'That room password is incorrect.' : 'This room requires a password.', code: 'ROOM_PASSWORD' }, 403);
          }
          grant = { id: random(12), role: data.role, slot: data.role === 'contributor' ? data.slot : '', guest: true, seen: now };
          if (data.role === 'viewer') { resume = random(24); grant.hash = await fingerprint(resume); }
          state.grants.push(grant);
        }
        if (!grant || (grant.slot && grant.slot !== data.slot)) return error('This invitation does not allow that role or camera.', 403);
        if (grant.role !== 'viewer') state.sessions = state.sessions.filter((entry) => entry.grant !== grant.id);
        if (state.sessions.length >= 96 || state.sessions.filter((entry) => entry.grant === grant.id).length >= 48) return error('Too many active room sessions.', 429);
        const id = random(24);
        const session = random(24);
        const peer = grant.role === 'host' ? 'AIRCAST-PRIVATE-HUB-' + data.room : grant.role === 'contributor'
          ? 'AIRCAST-PRIVATE-CAM-' + data.room + '-' + grant.slot : 'AIRCAST-PRIVATE-V-' + random(12).toUpperCase();
        const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
        state.sessions.push({ id, hash: await fingerprint(session), grant: grant.id, peer, publicKey: pub, seen: now });
        await tx.put('room', state);
        return json({ id, session, peer, role: grant.role, slot: grant.slot, expires: state.expires, openJoin: Boolean(state.openJoin), resume });
      }

      if (typeof data.session !== 'string' || !secretId.test(data.session)) return error('Session is invalid.', 403);
      const hash = await fingerprint(data.session);
      const current = state.sessions.find((entry) => entry.hash === hash);
      const grant = current && state.grants.find((entry) => entry.id === current.grant);
      if (!grant) return error('Private room access expired or was revoked.', 403);
      current.seen = now;
      if (grant.guest) grant.seen = now;
      if (data.op === 'leave') {
        state.sessions = state.sessions.filter((entry) => entry.id !== current.id);
        if (grant.guest && grant.role === 'contributor') state.grants = state.grants.filter((entry) => entry.id !== grant.id);
        await tx.put('room', state);
        return json({ ok: true });
      }
      if (data.op === 'alive') {
        await tx.put('room', state);
        return json({ ok: true });
      }
      if (data.op === 'turn-permit') {
        if ((current.lastRelay || 0) > now - 15000) return error('Relay credentials were issued recently.', 429);
        current.lastRelay = now;
        await tx.put('room', state);
        return json({ ok: true });
      }

      if (data.op === 'verify') {
        const peer = state.sessions.find((entry) => entry.id === data.remoteId);
        const other = peer && state.grants.find((entry) => entry.id === peer.grant);
        if (!other || !peerMatches(data.peer, peer.peer, other.role)) return error('The remote room session was not found.', 403);
        await tx.put('room', state);
        return json({ role: other.role, slot: other.slot, publicKey: peer.publicKey, grant: other.id });
      }

      if (grant.role !== 'host') return error('Only the host can manage invitations.', 403);
      if (data.op === 'list') return json({ grants: state.grants.filter((entry) => entry.role !== 'host').map(({ id, role, slot }) => ({ id, role, slot })) });
      if (data.op === 'invite') {
        if (!roles.has(data.role) || typeof data.slot !== 'string' || (data.slot ? !slotId.test(data.slot) : data.role === 'contributor')) return error('Choose a valid role and camera slot.');
        if (state.grants.length >= 48) return error('Revoke an unused invitation before creating more.', 429);
        if (data.role === 'contributor' && state.grants.some((entry) => entry.role === 'contributor' && entry.slot === data.slot)) return error('Revoke the contributor’s existing invitation for this slot first.', 409);
        const secret = random(24);
        const id = random(12);
        state.grants.push({ id, role: data.role, slot: data.slot, hash: await fingerprint(secret) });
        await tx.put('room', state);
        return json({ secret, id });
      }
      if (data.op === 'revoke') {
        if (!state.grants.some((entry) => entry.id === data.id && entry.role !== 'host')) return error('Invitation not found.', 404);
        state.grants = state.grants.filter((entry) => entry.id !== data.id);
        state.sessions = state.sessions.filter((entry) => entry.grant !== data.id);
        await tx.put('room', state);
        return json({ ok: true });
      }
      return error('Unknown operation.');
    });
  }
}

export default { fetch: () => new Response('Room authority available through its Pages binding.', { status: 404 }) };
