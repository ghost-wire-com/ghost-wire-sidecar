// Workspace model-route settings: save, test and remove the user's own provider
// API key. Keys are encrypted at rest and never returned or logged.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadRegistry, loadFilter, modelAllowed, validateKey, validateModelId, readMasterKey, normalizeKey,
  encryptKey, decryptKey, modelIds, SOURCES, STATS_FILE,
  readRoutes, writeRoutes, newRouteId, publicRoutes, MAX_ROUTES, ROUTE_ID,
} from './model-route-core.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
class RouteError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (code, message, status = 400) => { throw new RouteError(status, code, message); };

export function createModelRouteHandler(config, json, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const providersFile = config.modelProvidersFile || join(here, 'model-providers.json');
  const filterFile = config.modelFilterFile || join(here, 'model-filter.json');

  async function readBody(req) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) fail('request_too_large', 'Request too large', 413); chunks.push(chunk); }
    let value;
    try { value = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { fail('invalid_request', 'Invalid request'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request', 'Invalid request');
    return value;
  }
  function provider(registry, id) {
    const entry = registry.get(id);
    if (!entry?.enabled) fail('unknown_provider', 'Choose a provider from the list.');
    return entry;
  }
  function checkKey(entry, key) {
    const result = validateKey(entry, key);
    if (!result.ok) fail(result.code, result.code === 'subscription_token' ? 'API keys only. Subscriptions can\'t be used.' : 'This does not look like an API key for that provider.');
  }
  function checkModel(filter, entry, model) {
    if (!validateModelId(model)) fail('invalid_model', 'Enter a valid model name.');
    if (!modelAllowed(filter, entry.id, model)) fail('model_not_allowed', 'Ghost Wire doesn\'t allow this model.');
  }
  async function testCall(entry, model, key) {
    let response;
    try {
      response = await fetchImpl(entry.base_url + '/chat/completions', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
        body: JSON.stringify({model, messages: [{role: 'user', content: 'Reply with OK.'}], stream: false})});
    } catch { fail('provider_unavailable', 'The provider couldn\'t be reached. Try again.', 502); }
    await response.body?.cancel().catch(() => {});
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) fail('key_rejected', 'The provider rejected this key.');
    if (response.status === 429) fail('quota', 'Your provider account is out of quota.');
    if ([400, 404, 422].includes(response.status)) fail('model_unavailable', 'This model isn\'t available for your key.');
    fail('provider_unavailable', 'The provider couldn\'t be reached. Try again.', 502);
  }
  async function listModels(entry, key, filter) {
    try {
      const headers = entry.models_auth === 'anthropic' ? {'x-api-key': key, 'anthropic-version': '2023-06-01'} : {authorization: 'Bearer ' + key};
      const response = await fetchImpl(entry.base_url + '/models', {headers, redirect: 'error', signal: AbortSignal.timeout(15000)});
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return {models: [], listing: 'unavailable'}; }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) { await response.body.cancel().catch(() => {}); return {models: [], listing: 'unavailable'}; }
        chunks.push(chunk);
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')), list = Array.isArray(raw) ? raw : raw?.data || [];
      const context = new Map(list.map(item => [item?.id, Number(item?.context_length ?? item?.context_window) || undefined]));
      return {models: modelIds(raw).filter(id => modelAllowed(filter, entry.id, id, context.get(id)))};
    } catch { return {models: [], listing: 'unavailable'}; }
  }
  function readStats(dir) {
    try { return JSON.parse(readFileSync(join(dir, STATS_FILE), 'utf8')); } catch { return null; }
  }
  function unreadable(keyFile, route) {
    if (!route?.key_enc) return false;
    try { decryptKey(readMasterKey(keyFile), route.key_enc); return false; } catch { return true; }
  }
  // Legacy single-route view: the default route (or, when Ghost Wire is the default, the first saved key).
  function view(dir, keyFile) {
    const store = readRoutes(dir);
    const chosen = store.routes.find(route => route.id === store.default_id), shown = chosen || store.routes[0];
    const source = !chosen ? 'ghostwire' : chosen.fallback ? 'user-then-ghostwire' : 'user';
    return {configured: Boolean(shown), source, provider: shown?.provider || null, model: shown?.model || null,
      key_last4: shown?.key_last4 || null, key_unreadable: unreadable(keyFile, shown), stats: readStats(dir), mode: config.workspaceMode || 'premium'};
  }
  function routesView(dir, keyFile) {
    const store = readRoutes(dir), result = publicRoutes(store);
    result.routes = result.routes.map(route => ({...route, key_unreadable: unreadable(keyFile, store.routes.find(r => r.id === route.id))}));
    return {...result, stats: readStats(dir), mode: config.workspaceMode || 'premium'};
  }
  const cleanLabel = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : fallback);
  // Test (when needed) then encrypt; returns the stored fields.
  async function prepareKey(registry, filter, keyFile, {provider: providerId, model, key}, existing) {
    const entry = provider(registry, providerId); checkModel(filter, entry, model);
    const master = readMasterKey(keyFile);
    let plain = key, keyEnc;
    if (plain === undefined && existing?.key_enc && existing.provider === entry.id) {
      try { plain = decryptKey(master, existing.key_enc); keyEnc = existing.key_enc; } catch { plain = undefined; }
    }
    checkKey(entry, plain);
    if (!keyEnc || existing.model !== model) await testCall(entry, model, plain);
    return {entry, key_enc: keyEnc || encryptKey(master, plain), key_last4: plain.slice(-4)};
  }
  const tooMany = () => fail('too_many_routes', 'You can save up to ' + MAX_ROUTES + ' keys. Remove one first.', 409);

  return async (req, res) => {
    const path = req.url.split('?')[0];
    if (path !== '/engine/model-route' && !path.startsWith('/engine/model-route/')) return false;
    try {
      if (!config.hostedWorkspace || req.headers['x-ghostwire-mode'] !== (config.workspaceMode || 'premium')) fail('forbidden', 'Workspace access is unavailable', 403);
      const dir = config.modelRouteDir, keyFile = config.modelRouteKeyFile;
      if (!dir || !keyFile || !existsSync(dir) || !existsSync(keyFile)) fail('model_route_unavailable', 'Your workspace needs an update before you can add your own key.', 503);
      const sub = path.slice('/engine/model-route'.length), method = req.method;
      const body = ['POST', 'PUT'].includes(method) ? await readBody(req) : {};
      if (Object.hasOwn(body, 'key')) body.key = normalizeKey(body.key);
      if (Object.hasOwn(body, 'base_url')) fail('base_url_not_allowed', 'Custom provider URLs are not allowed.');
      const registry = loadRegistry(providersFile), filter = loadFilter(filterFile);
      if (method === 'GET' && sub === '/providers') return json(res, 200, {providers: [...registry.values()].filter(p => p.enabled).map(p => ({id: p.id, name: p.name}))}), true;
      if (method === 'POST' && sub === '/models') {
        const entry = provider(registry, body.provider); checkKey(entry, body.key);
        return json(res, 200, await listModels(entry, body.key, filter)), true;
      }
      if (method === 'POST' && sub === '/test') {
        const entry = provider(registry, body.provider); checkModel(filter, entry, body.model); checkKey(entry, body.key);
        await testCall(entry, body.model, body.key);
        return json(res, 200, {ok: true}), true;
      }
      if (sub === '/routes' || sub.startsWith('/routes/') || sub === '/default') {
        const store = readRoutes(dir);
        const id = sub.startsWith('/routes/') ? sub.slice('/routes/'.length) : null;
        if (sub === '/routes' && method === 'GET') return json(res, 200, routesView(dir, keyFile)), true;
        if (sub === '/routes' && method === 'POST') {
          if (store.routes.length >= MAX_ROUTES) tooMany();
          const prepared = await prepareKey(registry, filter, keyFile, body, null);
          const route = {id: newRouteId(), label: cleanLabel(body.label, prepared.entry.name + ' · ' + body.model), provider: prepared.entry.id, model: body.model,
            key_enc: prepared.key_enc, key_last4: prepared.key_last4, fallback: body.fallback !== false, updated_at: Date.now()};
          store.routes.push(route);
          if (store.routes.length === 1) store.default_id = route.id;
          writeRoutes(dir, store);
          return json(res, 200, {route: publicRoutes({default_id: store.default_id, routes: [route]}).routes[0], default_id: store.default_id}), true;
        }
        if (id !== null) {
          if (!ROUTE_ID.test(id)) fail('not_found', 'Not found', 404);
          const index = store.routes.findIndex(route => route.id === id);
          if (index < 0) fail('not_found', 'That key was not found.', 404);
          if (method === 'DELETE') {
            store.routes.splice(index, 1);
            if (store.default_id === id) store.default_id = 'ghostwire';
            writeRoutes(dir, store);
            return json(res, 200, routesView(dir, keyFile)), true;
          }
          if (method === 'PUT') {
            const current = store.routes[index];
            const next = {...current, label: cleanLabel(body.label, current.label), fallback: typeof body.fallback === 'boolean' ? body.fallback : current.fallback};
            if (body.key !== undefined || (body.model !== undefined && body.model !== current.model)) {
              const prepared = await prepareKey(registry, filter, keyFile, {provider: current.provider, model: body.model ?? current.model, key: body.key}, current);
              Object.assign(next, {model: body.model ?? current.model, key_enc: prepared.key_enc, key_last4: prepared.key_last4});
            }
            next.updated_at = Date.now();
            store.routes[index] = next;
            writeRoutes(dir, store);
            return json(res, 200, routesView(dir, keyFile)), true;
          }
        }
        if (sub === '/default' && method === 'PUT') {
          if (body.id !== 'ghostwire' && !store.routes.some(route => route.id === body.id)) fail('not_found', 'That key was not found.', 404);
          store.default_id = body.id;
          writeRoutes(dir, store);
          return json(res, 200, routesView(dir, keyFile)), true;
        }
        fail('not_found', 'Not found', 405);
      }
      if (sub !== '') fail('not_found', 'Not found', 404);
      if (method === 'GET') return json(res, 200, view(dir, keyFile)), true;
      const store = readRoutes(dir);
      const chosen = store.routes.find(route => route.id === store.default_id);
      if (method === 'DELETE') {
        const target = chosen || store.routes[0];
        if (target) store.routes = store.routes.filter(route => route !== target);
        store.default_id = 'ghostwire';
        writeRoutes(dir, store);
        return json(res, 200, {configured: false, source: 'ghostwire'}), true;
      }
      if (method !== 'PUT') fail('not_found', 'Not found', 405);
      if (!SOURCES.includes(body.source)) fail('invalid_source', 'Choose a model source.');
      if (body.source === 'ghostwire') {
        store.default_id = 'ghostwire';
        writeRoutes(dir, store);
        return json(res, 200, view(dir, keyFile)), true;
      }
      // Legacy save: update the default (or the key for the same provider), else add a new default.
      const existing = chosen || store.routes.find(route => route.provider === body.provider) || null;
      if (!existing && store.routes.length >= MAX_ROUTES) tooMany();
      const sameProvider = existing && existing.provider === body.provider ? existing : null;
      const prepared = await prepareKey(registry, filter, keyFile, body, sameProvider);
      const route = {id: existing?.id || newRouteId(), label: sameProvider ? existing.label : prepared.entry.name + ' · ' + body.model,
        provider: prepared.entry.id, model: body.model, key_enc: prepared.key_enc, key_last4: prepared.key_last4, fallback: body.source === 'user-then-ghostwire', updated_at: Date.now()};
      store.routes = existing ? store.routes.map(r => (r.id === existing.id ? route : r)) : [...store.routes, route];
      store.default_id = route.id;
      writeRoutes(dir, store);
      return json(res, 200, view(dir, keyFile)), true;
    } catch (error) {
      if (error instanceof RouteError) json(res, error.status, {error: error.message, code: error.code});
      else json(res, 503, {error: 'Model settings are unavailable. Try again.', code: 'unavailable'});
      return true;
    }
  };
}
