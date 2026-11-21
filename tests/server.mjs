import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { onRequest } from '../functions/api/rooms.js';
import { RoomAuthority } from '../infra/room-authority.mjs';

export function inMemoryAuthority() {
  const objects = new Map();
  return { idFromName: (name) => name, get(name) {
    if (!objects.has(name)) {
      const records = new Map();
      let pending = Promise.resolve();
      const tx = { get: async (key) => structuredClone(records.get(key)), put: async (key, value) => records.set(key, structuredClone(value)) };
      const storage = { transaction(callback) {
        const result = pending.then(() => callback(tx));
        pending = result.catch(() => {});
        return result;
      } };
      const authority = new RoomAuthority({ storage });
      objects.set(name, { fetch: (url, init) => authority.fetch(new Request(url, init)) });
    }
    return objects.get(name);
  } };
}

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  webmanifest: 'application/manifest+json', png: 'image/png' };
const port = Number(process.env.AIRCAST_TEST_PORT || 4173);
const origin = 'http://127.0.0.1:' + port;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = { ROOMS: process.argv.includes('--static') ? null : inMemoryAuthority() };
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === '/api/rooms') {
        const result = await onRequest({ request: new Request(url, { method: request.method, headers: request.headers,
          ...(request.method === 'POST' ? { body: Readable.toWeb(request), duplex: 'half' } : {}) }), env });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const file = resolve(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(resolve(publicRoot) + sep) || !(await stat(file)).isFile()) throw new Error('not found');
      response.writeHead(200, { 'Content-Type': mime[file.split('.').at(-1)] || 'application/octet-stream' });
      response.end(await readFile(file));
    } catch { response.writeHead(404).end('Not found'); }
  }).listen(port, '127.0.0.1', () => console.log('AirCast test server on ' + origin));
}
