import { json } from '../../infra/room-authority.mjs';

export async function onRequest({ request, env }) {
  if (!env.ROOMS) return json({ error: 'Private rooms require the optional room authority.' }, 503);
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'Use the AirCast site to access private rooms.' }, 403);
  const limit = 8192;
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'A request body is required.' }, 400);
  let body = '';
  let size = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return json({ error: 'Request too large.' }, 413);
    }
    body += decoder.decode(value, { stream: true });
  }
  let data;
  try { data = JSON.parse(body + decoder.decode()); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  if (!data || typeof data !== 'object' || !['create','enter','verify','invite','list','revoke','alive','turn'].includes(data.op)) return json({ error: 'Invalid room operation.' }, 400);
  const send = (name, payload) => env.ROOMS.get(env.ROOMS.idFromName(name)).fetch('https://room.internal/', { method: 'POST', body: JSON.stringify(payload) });
  if (data.op === 'create' || data.op === 'enter') {
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const limited = await send('rate:' + ip, { op: 'rate', burst: data.op === 'enter' });
    if (!limited.ok) return limited;
  }
  if (data.op === 'create') {
    data.room = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  if (typeof data.room !== 'string' || !/^[A-F0-9]{16}$/.test(data.room)) return json({ error: 'Invalid private room ID.' }, 400);
  if (data.op === 'turn') {
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'Managed TURN is not configured.' }, 404);
    const permit = await send('room:' + data.room, { ...data, op: 'turn-permit' });
    if (!permit.ok) return permit;
    const url = 'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(env.TURN_KEY_ID) + '/credentials/generate-ice-servers';
    try {
      const ttl = 86400;
      const result = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3500), headers: {
        Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json'
      }, body: JSON.stringify({ ttl }) });
      if (!result.ok) return json({ error: 'The TURN provider could not issue credentials.' }, 502);
      const { iceServers } = await result.json();
      if (!Array.isArray(iceServers)) return json({ error: 'The TURN provider returned an invalid configuration.' }, 502);
      return json({ iceServers, ttl });
    } catch { return json({ error: 'The TURN provider is unavailable.' }, 502); }
  }
  return send('room:' + data.room, data);
}
