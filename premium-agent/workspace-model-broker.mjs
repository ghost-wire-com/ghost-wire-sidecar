import http from 'node:http';
import https from 'node:https';
import {timingSafeEqual} from 'node:crypto';
import {statSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';

// The core module is mounted next to this file by enrollment. Workspaces
// enrolled before BYOK mount only this file: they keep the Ghost Wire route.
let core = null;
try { core = await import('./model-route-core.mjs'); } catch {}
// Optional like core: an older mount set without this file keeps working, minus Gemini 3 tool signatures.
let signatures = null;
try { signatures = await import('./gemini-signatures.mjs'); } catch {}

const FALLBACK_STATUS = new Set([401, 403, 408, 429]);
const HOUR = 3600_000;

function send(url, headers, body, firstByteMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {method: 'POST', headers: {...headers, 'content-type': 'application/json', 'content-length': body.length}}, resolve);
    const timer = setTimeout(() => request.destroy(Error('timeout')), firstByteMs);
    request.on('response', () => clearTimeout(timer));
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

export function createBroker({env, routeDir, masterKeyFile, providersFile, filterFile, registry, now = Date.now, pollMs = 2000, statsMs = 10_000, firstByteMs = 30_000, nonStreamMs = 300_000}) {
  const base = new URL(env.MODEL_ENDPOINT);
  const token = env.WORKSPACE_MODEL_TOKEN, key = env.MODEL_UPSTREAM_TOKEN, model = env.MODEL_ID, mode = env.WORKSPACE_MODE;
  if (!token || token.length < 32 || !key || key.length < 20 || token === key || !model) throw Error('Separate model credentials are required');
  const configuredOrigins = (env.GHOST_WIRE_API_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const origin = new URL(value);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Invalid configured Ghost Wire API origin');
    return origin.origin;
  });
  if (['api', 'sidecar'].includes(mode) && (!configuredOrigins.includes(base.origin) || base.pathname !== '/')) throw Error('API workspaces must use the Ghost Wire metered API');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Invalid model origin');

  // User route state, refreshed by polling file modification times.
  const enabled = Boolean(core && routeDir && masterKeyFile && (registry || providersFile) && filterFile);
  let providers = registry || null, filter = null, route = null, configError = false, brokenSource = null, seen = '';
  let failures = 0, openUntil = 0, authLocked = null;
  const stats = {hours: {}, last_route: null, last_error_class: null};
  const geminiSignatures = signatures ? signatures.createSignatureStore() : null;
  let statsTimer = null;
  const mtime = file => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  function refresh() {
    if (!enabled) return;
    const stamp = [mtime(join(routeDir, core.ROUTE_FILE)), mtime(filterFile), mtime(masterKeyFile), providersFile ? mtime(providersFile) : 0].join(':');
    if (stamp === seen) return;
    let stored = null;
    try {
      if (!registry) providers = core.loadRegistry(providersFile);
      filter = core.loadFilter(filterFile);
      stored = core.readRoute(routeDir);
      if (!stored || stored.source === 'ghostwire') { route = stored ? {source: 'ghostwire'} : null; configError = false; brokenSource = null; seen = stamp; return; }
      const provider = providers.get(stored.provider);
      if (!provider?.enabled || !core.SOURCES.includes(stored.source) || !core.validateModelId(stored.model)) throw Error('route');
      const userKey = core.decryptKey(core.readMasterKey(masterKeyFile), stored.key_enc);
      if (route?.key_enc !== stored.key_enc) { failures = 0; openUntil = 0; }
      route = {source: stored.source, provider, model: stored.model, key: userKey, key_enc: stored.key_enc};
      configError = false; brokenSource = null; seen = stamp;
    } catch { if (!configError) note(null, 'config'); route = null; configError = true; brokenSource = stored?.source || null; }
  }
  refresh();
  const poller = enabled ? setInterval(refresh, pollMs) : null;
  poller?.unref();

  function flushStats() {
    statsTimer = null;
    if (!enabled) return;
    const cutoff = Math.floor(now() / HOUR) - 23;
    for (const hour of Object.keys(stats.hours)) if (Number(hour) < cutoff) delete stats.hours[hour];
    try {
      const file = join(routeDir, core.STATS_FILE);
      writeFileSync(file + '.tmp', JSON.stringify({updated_at: Math.floor(now() / 1000), ...stats}));
      renameSync(file + '.tmp', file);
    } catch {}
  }
  function note(kind, errorClass, servedBy) {
    if (kind) {
      const hour = String(Math.floor(now() / HOUR));
      stats.hours[hour] ||= {user: 0, fallback: 0, error: 0};
      stats.hours[hour][kind]++;
    }
    if (servedBy) stats.last_route = servedBy;
    if (errorClass) stats.last_error_class = errorClass;
    else if (kind === 'user') stats.last_error_class = null;
    if (statsMs === 0) flushStats();
    else if (!statsTimer) { statsTimer = setTimeout(flushStats, statsMs); statsTimer.unref(); }
  }
  const classify = status => status === 401 || status === 403 ? 'auth' : status === 429 ? 'quota' : 'provider_down';

  function reply(res, upstream, servedBy) {
    res.writeHead(upstream.statusCode, {'content-type': upstream.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'x-ghostwire-route': servedBy});
    pipeline(upstream, res).catch(() => res.destroy());
  }
  async function ghostwire(res, payload, path) {
    payload.model = model;
    const body = Buffer.from(JSON.stringify(payload));
    const target = new URL((mode === 'sidecar' ? '/sidecar' : '') + path, base);
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(target, {method: 'POST', headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json', 'content-length': body.length}}, response => reply(res, response, 'ghostwire'));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  }
  // Read Gemini's thought signatures off the reply as it streams to the worker.
  function captureSignatures(upstream) {
    if (/text\/event-stream/i.test(upstream.headers['content-type'] || '')) {
      const capture = geminiSignatures.sseCapture();
      upstream.on('data', chunk => capture.write(chunk));
      return;
    }
    const chunks = []; let size = 0;
    upstream.on('data', chunk => { size += chunk.length; if (size <= 8 * 1024 * 1024) chunks.push(chunk); });
    upstream.on('end', () => { if (size <= 8 * 1024 * 1024) { try { geminiSignatures.captureJson(JSON.parse(Buffer.concat(chunks))); } catch {} } });
  }
  async function user(res, payload, path, current) {
    const fallback = current.source === 'user-then-ghostwire';
    const failed = (errorClass, upstream) => {
      if (fallback) { upstream?.resume(); note('fallback', errorClass, 'ghostwire'); return ghostwire(res, payload, path); }
      note('error', errorClass, 'user');
      if (upstream) return reply(res, upstream, 'user');
      res.writeHead(503, {'content-type': 'application/json', 'x-ghostwire-route': 'user'}); res.end(JSON.stringify({error: errorClass}));
    };
    if (!core.modelAllowed(filter, current.provider.id, current.model)) return failed('model_not_allowed');
    if (authLocked === current.key_enc || (failures >= 3 && now() < openUntil)) return failed(authLocked === current.key_enc ? 'auth' : 'provider_down');
    const gemini = current.provider.id === 'gemini' && geminiSignatures !== null;
    const sendPayload = gemini ? geminiSignatures.restore(payload) : payload;
    const body = Buffer.from(JSON.stringify({...sendPayload, model: current.model}));
    let upstream;
    try { upstream = await send(new URL(current.provider.base_url + '/chat/completions'), {authorization: 'Bearer ' + current.key}, body, payload.stream === true ? firstByteMs : nonStreamMs); }
    catch { failures++; if (failures >= 3) openUntil = now() + 60_000; return failed('provider_down'); }
    const status = upstream.statusCode;
    if (FALLBACK_STATUS.has(status) || status >= 500) {
      if (status === 401) authLocked = current.key_enc;
      else { failures++; if (failures >= 3) openUntil = now() + 60_000; }
      return failed(classify(status), upstream);
    }
    failures = 0;
    note(status < 400 ? 'user' : 'error', null, 'user');
    res.on('close', () => upstream.destroy());
    if (gemini && status < 400) captureSignatures(upstream);
    reply(res, upstream, 'user');
  }

  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({object: 'list', data: [{id: 'ghostwire', object: 'model', owned_by: 'ghost-wire'}]})); return; }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(req.url) || mode === 'sidecar' && req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const payload = JSON.parse(Buffer.concat(chunks));
      const current = route; // captured once: a route change applies to the next request
      if (req.url === '/v1/chat/completions' && current && current.source !== 'ghostwire') return await user(res, payload, req.url, current);
      if (configError && brokenSource === 'user' && req.url === '/v1/chat/completions') {
        note('error', 'config', 'user');
        res.writeHead(503, {'content-type': 'application/json', 'x-ghostwire-route': 'user'}); res.end(JSON.stringify({error: 'config'})); return;
      }
      if (configError) note(null, 'config', 'ghostwire'); else if (enabled) note(null, null, 'ghostwire');
      return await ghostwire(res, payload, req.url);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.on('close', () => { if (poller) clearInterval(poller); if (statsTimer) { clearTimeout(statsTimer); flushStats(); } });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  createBroker({env, routeDir: env.MODEL_ROUTE_DIR, masterKeyFile: env.MODEL_ROUTE_KEY, providersFile: env.MODEL_PROVIDERS, filterFile: env.MODEL_FILTER}).listen(8791, '0.0.0.0');
}
