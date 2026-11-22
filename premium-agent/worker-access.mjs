import http from 'node:http';
import { pipeline } from 'node:stream/promises';
// Loopback-only operator access to the isolated engine. No host files or credentials are mounted here.
http.createServer((req, res) => {
  const mining = /^\/(?:mining|payouts)(?:\/|$)/.test(req.url);
  const upstream = http.request({ hostname: mining ? 'mining-node' : process.env.WORKER_HOST || 'worker', port: mining ? 8792 : 8787, path: req.url, method: req.method,
    headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json', 'x-request-id': req.headers['x-request-id'] || '' } }, response => {
    res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json' });
    pipeline(response, res).catch(() => res.destroy());
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
  req.on('aborted', () => upstream.destroy());
  pipeline(req, upstream).catch(() => upstream.destroy());
}).listen(8787, '0.0.0.0');
