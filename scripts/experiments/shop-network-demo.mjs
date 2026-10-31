// Read-only local shop used by the networking and load-balancing articles.
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '18081' },
  name: { type: 'string', default: 'product-a' },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('--port must be an integer between 1 and 65535');
}
const backend = values.name;
const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小店商品 42</title><link rel="stylesheet" href="/assets/shop.css">
<main><p>网络与负载均衡实验</p><h1>马克杯</h1>
<p id="price">正在查询价格……</p><p id="backend"></p>
<a href="/api/products/42">直接查看 JSON</a></main>
<script src="/assets/shop.js" defer></script></html>`;
const css = 'body{font:18px/1.8 system-ui;background:#fdfaf3;color:#2b2620}main{max-width:640px;margin:80px auto;padding:24px}a{color:#466b48}';
const script = `fetch('/api/products/42')
  .then(response => {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  })
  .then(product => {
    document.querySelector('#price').textContent = product.price + ' 元';
    document.querySelector('#backend').textContent = '数据来自：' + product.backend;
  })
  .catch(error => {
    document.querySelector('#price').textContent = '查询失败：' + error.message;
  });`;

const server = createServer((request, response) => {
  let path;
  try { path = new URL(request.url, 'http://localhost').pathname; }
  catch { response.writeHead(400).end(); return; }
  let status = 200;
  let type = 'text/plain';
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) {
    status = 405; body = 'Read-only demo'; response.setHeader('Allow', 'GET, HEAD');
  } else if (path === '/products/42') {
    type = 'text/html'; body = html;
  } else if (path === '/assets/shop.css') {
    type = 'text/css'; body = css;
  } else if (path === '/assets/shop.js') {
    type = 'text/javascript'; body = script;
  } else if (path === '/api/products/42') {
    type = 'application/json'; body = JSON.stringify({ id: 42, name: '马克杯', price: 29, backend }) + '\n';
  } else if (path === '/healthz') {
    body = 'ready\n';
  } else {
    status = 404; body = 'Not found\n';
  }
  response.writeHead(status, {
    'content-type': type + '; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-demo-backend': backend,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
  console.log(`${backend} ${request.method} ${path} -> ${status}`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`${backend}: http://127.0.0.1:${port}/products/42`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}
