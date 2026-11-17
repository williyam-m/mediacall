import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const assetRoot = resolve('dist/client');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  let path = resolve(assetRoot, `.${decodeURIComponent(pathname)}`);
  if (path !== assetRoot && !path.startsWith(assetRoot + sep)) { response.writeHead(403); response.end(); return; }
  let info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    if (extname(pathname)) { response.writeHead(404); response.end('Not found'); return; }
    path = resolve(assetRoot, 'index.html');
    info = await stat(path).catch(() => undefined);
  }
  if (!info?.isFile()) { response.writeHead(503); response.end('Run npm run build first.'); return; }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(path).on('error', () => response.destroy()).pipe(response);
}