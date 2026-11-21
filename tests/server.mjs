import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { onRequest } from '../functions/api/rooms.js';

export function inMemoryBucket() {
  const records = new Map();
  return {
    async get(key) { return records.has(key) ? { text: async () => records.get(key) } : null; },
    async put(key, value, options) {
      if (options?.onlyIf?.etagDoesNotMatch === '*' && records.has(key)) return null;
      records.set(key, value);
      return {};
    }
  };
}

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  webmanifest: 'application/manifest+json', png: 'image/png' };
const port = Number(process.env.AIRCAST_TEST_PORT || 4173);
const origin = 'http://127.0.0.1:' + port;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = { ROOM_ENVELOPES: process.argv.includes('--static') ? null : inMemoryBucket() };
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
