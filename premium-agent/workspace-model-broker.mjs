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
// Optional like core: an older mount set without this file keeps working, minus the per-provider fixes.
let adapters = null;
try { adapters = await import('./provider-adapters.mjs'); } catch {}
const ECHO_PROVIDERS = new Set(['gemini', 'deepseek', 'openrouter']);

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
  // Saved routes by id (several keys, one default). Health is kept per route and reset when its key changes.
  let providers = registry || null, filter = null, routes = new Map(), defaultId = 'ghostwire', configError = false, brokenSource = null, seen = '';
  const stats = {hours: {}, route_hours: {}, routes: {}, last_route: null, last_error_class: null};
  const replies = adapters ? adapters.createReplyStore() : null;
  let statsTimer = null;
  const mtime = file => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  function refresh() {
    if (!enabled) return;
    const stamp = [mtime(join(routeDir, core.ROUTES_FILE)), mtime(join(routeDir, core.ROUTE_FILE)), mtime(filterFile), mtime(masterKeyFile), providersFile ? mtime(providersFile) : 0].join(':');
    if (stamp === seen) return;
    try {
      if (!registry) providers = core.loadRegistry(providersFile);
      filter = core.loadFilter(filterFile);
      const store = core.readRoutes(routeDir);
      const master = store.routes.length ? core.readMasterKey(masterKeyFile) : null;
      const next = new Map();
      let broken = null;
      for (const stored of store.routes) {
        const source = stored.fallback ? 'user-then-ghostwire' : 'user';
        try {
          const provider = providers.get(stored.provider);
          if (!provider?.enabled || !core.validateModelId(stored.model)) throw Error('route');
          const userKey = core.decryptKey(master, stored.key_enc);
          const previous = routes.get(stored.id);
          const health = previous?.key_enc === stored.key_enc && previous.health ? previous.health : {failures: 0, openUntil: 0, authLocked: false};
          next.set(stored.id, {id: stored.id, label: stored.label, source, provider, model: stored.model, key: userKey, key_enc: stored.key_enc, health});
        } catch {
          next.set(stored.id, {id: stored.id, label: stored.label, source, broken: true, provider: providers.get(stored.provider) || {id: stored.provider}, model: stored.model});
          if (stored.id === store.default_id) broken = source;
        }
      }
      routes = next; defaultId = store.default_id;
      if (broken !== null) { if (!configError) note(null, 'config'); configError = true; brokenSource = broken; return; }
      configError = false; brokenSource = null; seen = stamp;
    } catch { if (!configError) note(null, 'config'); routes = new Map(); configError = true; brokenSource = null; }
  }
  // byok:<id> names a saved route; anything else (the worker sends "ghostwire") means the default.
  function pick(name) {
    const match = typeof name === 'string' ? /^byok:([a-z2-7]{8})$/.exec(name) : null;
    if (match && routes.has(match[1])) return routes.get(match[1]);
    return defaultId === 'ghostwire' ? null : routes.get(defaultId) || null;
  }
  refresh();
  const poller = enabled ? setInterval(refresh, pollMs) : null;
  poller?.unref();

  function flushStats() {
    statsTimer = null;
    if (!enabled) return;
    const cutoff = Math.floor(now() / HOUR) - 23;
    for (const hour of Object.keys(stats.hours)) if (Number(hour) < cutoff) delete stats.hours[hour];
    for (const hour of Object.keys(stats.route_hours)) if (Number(hour) < cutoff) delete stats.route_hours[hour];
    // Per-route totals over the same last 24 hours (hourly detail kept apart so the legacy "hours" shape is unchanged).
    stats.routes = {};
    for (const bucket of Object.values(stats.route_hours)) for (const [id, counts] of Object.entries(bucket)) {
      const total = (stats.routes[id] ||= {user: 0, fallback: 0, error: 0});
      for (const kind of ['user', 'fallback', 'error']) total[kind] += counts[kind] || 0;
    }
    try {
      const file = join(routeDir, core.STATS_FILE);
      writeFileSync(file + '.tmp', JSON.stringify({updated_at: Math.floor(now() / 1000), ...stats}));
      renameSync(file + '.tmp', file);
    } catch {}
  }
  function note(kind, errorClass, servedBy, routeId) {
    if (kind) {
      const hour = String(Math.floor(now() / HOUR));
      stats.hours[hour] ||= {user: 0, fallback: 0, error: 0};
      stats.hours[hour][kind]++;
      if (routeId) { const byRoute = (stats.route_hours[hour] ||= {}); byRoute[routeId] ||= {user: 0, fallback: 0, error: 0}; byRoute[routeId][kind]++; }
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
  // Remember what the provider needs echoed back, read off the reply as it streams to the worker.
  function captureReply(upstream) {
    if (/text\/event-stream/i.test(upstream.headers['content-type'] || '')) {
      const capture = replies.sseCapture();
      upstream.on('data', chunk => capture.write(chunk));
      return;
    }
    const chunks = []; let size = 0;
    upstream.on('data', chunk => { size += chunk.length; if (size <= 8 * 1024 * 1024) chunks.push(chunk); });
    upstream.on('end', () => { if (size <= 8 * 1024 * 1024) { try { replies.captureJson(JSON.parse(Buffer.concat(chunks))); } catch {} } });
  }
  async function user(res, payload, path, current) {
    const fallback = current.source === 'user-then-ghostwire';
    const failed = (errorClass, upstream) => {
      if (fallback) { upstream?.resume(); note('fallback', errorClass, 'ghostwire', current.id); return ghostwire(res, payload, path); }
      note('error', errorClass, 'user', current.id);
      if (upstream) return reply(res, upstream, 'user');
      res.writeHead(503, {'content-type': 'application/json', 'x-ghostwire-route': 'user'}); res.end(JSON.stringify({error: errorClass}));
    };
    if (!core.modelAllowed(filter, current.provider.id, current.model)) return failed('model_not_allowed');
    const health = current.health;
    if (health.authLocked || (health.failures >= 3 && now() < health.openUntil)) return failed(health.authLocked ? 'auth' : 'provider_down');
    const providerId = current.provider.id;
    const echo = replies !== null && ECHO_PROVIDERS.has(providerId);
    const sendPayload = adapters ? adapters.adaptRequest(providerId, echo ? replies.restore(providerId, payload) : payload) : payload;
    const body = Buffer.from(JSON.stringify({...sendPayload, model: current.model}));
    let upstream;
    try { upstream = await send(new URL(current.provider.base_url + '/chat/completions'), {authorization: 'Bearer ' + current.key}, body, payload.stream === true ? firstByteMs : nonStreamMs); }
    catch { health.failures++; if (health.failures >= 3) health.openUntil = now() + 60_000; return failed('provider_down'); }
    const status = upstream.statusCode;
    if (FALLBACK_STATUS.has(status) || status >= 500) {
      if (status === 401) health.authLocked = true;
      else { health.failures++; if (health.failures >= 3) health.openUntil = now() + 60_000; }
      return failed(classify(status), upstream);
    }
    health.failures = 0;
    note(status < 400 ? 'user' : 'error', null, 'user', current.id);
    res.on('close', () => upstream.destroy());
    if (echo && status < 400) captureReply(upstream);
    reply(res, upstream, 'user');
  }

  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/v1/models') {
      const saved = [...routes.values()].map(r => ({id: 'byok:' + r.id, object: 'model', owned_by: 'user', label: r.label, provider: r.provider?.id, model: r.model, ...(r.broken ? {broken: true} : {})}));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({object: 'list', default_id: defaultId, data: [{id: 'ghostwire', object: 'model', owned_by: 'ghost-wire'}, ...saved]}));
      return;
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(req.url) || mode === 'sidecar' && req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const payload = JSON.parse(Buffer.concat(chunks));
      const current = pick(payload?.model); // captured once: a route change applies to the next request
      if (req.url === '/v1/chat/completions' && current && !current.broken) return await user(res, payload, req.url, current);
      if (req.url === '/v1/chat/completions' && ((current?.broken && current.source === 'user') || (!current && configError && brokenSource === 'user'))) {
        note('error', 'config', 'user', current?.id);
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
