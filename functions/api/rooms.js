const manifestType = 'application/vnd.aircast.room';
const maxBytes = 256;
const week = 7 * 24 * 60 * 60 * 1000;
const objectPrefix = 'aircast/room-v1/';

function reply(body = null, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': manifestType, 'Cache-Control': 'no-store' } });
}

function expiry(manifest) {
  const match = /^(?:0\.([1-9]\d{12})|1\.(0|[1-9]\d{12})\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{151}|2\.(0|[1-9]\d{12})\.[A-Z2-9]{16})$/.exec(manifest);
  return match ? Number(match[1] ?? match[2] ?? match[3]) : null;
}

async function readManifest(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return new TextDecoder().decode(bytes.subarray(0, size));
    if (size + value.byteLength > maxBytes) { await reader.cancel(); return ''; }
    bytes.set(value, size);
    size += value.byteLength;
  }
}

export async function onRequest({ request, env }) {
  const bucket = env.ROOM_ENVELOPES;
  if (!bucket) return reply(null, 501);
  const url = new URL(request.url);
  const room = url.searchParams.get('room');
  if (!room || !/^[A-Z0-9]{3,16}$/.test(room)) return reply(null, 400);
  const key = objectPrefix + room;
  if (request.method === 'GET') {
    const object = await bucket.get(key);
    if (!object) return reply(null, 404);
    const manifest = await object.text();
    const until = expiry(manifest);
    if (until === null) return reply(null, 500);
    if (until && until <= Date.now()) return reply(null, 410);
    return reply(manifest);
  }
  if (request.method !== 'POST') return reply(null, 405);
  if (request.headers.get('Origin') !== url.origin) return reply(null, 403);
  const manifest = await readManifest(request);
  const until = expiry(manifest);
  const now = Date.now();
  if (until === null || (until && (until <= now || until > now + week + 60000))) return reply(null, 400);
  const created = await bucket.put(key, manifest, { onlyIf: { etagDoesNotMatch: '*' } });
  return reply(null, created ? 201 : 409);
}
