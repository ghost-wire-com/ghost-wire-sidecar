import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
// Loopback-only operator access to the isolated engine. No host files or credentials are mounted here,
// except the workspace model token (env) used only for the two broker routes below.
//
//   /mining*, /payouts*                 → mining-node:8792
//   GET /model/v1/models                → model-broker:8791/v1/models            (workspace token added)
//   POST /model/v1/chat/completions     → model-broker:8791/v1/chat/completions  (workspace token added)
//   everything else                     → worker:8787
const MODEL_ROUTES = new Map([['GET /model/v1/models', '/v1/models'], ['POST /model/v1/chat/completions', '/v1/chat/completions']]);

export function createAccess(env = process.env) {
  return http.createServer((req, res) => {
    const url = req.url || '/';
    let target;
    if (url === '/model' || url.startsWith('/model/')) {
      const path = MODEL_ROUTES.get(`${req.method} ${url}`);
      if (!path || !env.WORKSPACE_MODEL_TOKEN) { res.writeHead(404); res.end(); return; }
      target = { hostname: env.MODEL_BROKER_HOST || 'model-broker', port: Number(env.MODEL_BROKER_PORT || 8791), path,
        headers: { authorization: 'Bearer ' + env.WORKSPACE_MODEL_TOKEN, 'content-type': 'application/json' } };
    } else if (/^\/(?:mining|payouts)(?:\/|$)/.test(url)) {
      target = { hostname: env.MINING_HOST || 'mining-node', port: Number(env.MINING_PORT || 8792), path: url };
    } else {
      target = { hostname: env.WORKER_HOST || 'worker', port: Number(env.WORKER_PORT || 8787), path: url };
    }
    const headers = target.headers || { authorization: req.headers.authorization || '', 'content-type': 'application/json' };
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: target.path, method: req.method,
      headers: { ...headers, 'x-request-id': req.headers['x-request-id'] || '' } }, response => {
      res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json' });
      pipeline(response, res).catch(() => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    req.on('aborted', () => upstream.destroy());
    pipeline(req, upstream).catch(() => upstream.destroy());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createAccess().listen(8787, '0.0.0.0');
