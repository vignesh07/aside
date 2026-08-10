import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const port = Number.parseInt(process.argv[2] ?? '4328', 10);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(root, 'menubar/index.html'), 'utf8')
      .replace(
        '<script type="module" src="./build/renderer.js"></script>',
        '<script src="/model-picker-browser-bridge.js"></script>\n    <script type="module" src="/build/renderer.js"></script>',
      );
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(html);
    return;
  }
  const assets = new Map([
    [
      '/model-picker-browser-bridge.js',
      path.join(here, 'model-picker-browser-bridge.js'),
    ],
    ['/build/renderer.js', path.join(root, 'menubar/build/renderer.js')],
  ]);
  const asset = assets.get(pathname);
  if (!asset) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(fs.readFileSync(asset));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`model picker preview -> http://127.0.0.1:${port}`);
});
