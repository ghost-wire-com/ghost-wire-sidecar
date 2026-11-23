// Workspace model-route settings: save, test and remove the user's own provider
// API key. Keys are encrypted at rest and never returned or logged.
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadRegistry, loadFilter, modelAllowed, validateKey, validateModelId, readMasterKey, normalizeKey,
  encryptKey, decryptKey, readRoute, writeRoute, modelIds, SOURCES, ROUTE_FILE, STATS_FILE,
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
  function view(dir, keyFile) {
    const route = readRoute(dir);
    let keyUnreadable = false;
    if (route?.key_enc) { try { decryptKey(readMasterKey(keyFile), route.key_enc); } catch { keyUnreadable = true; } }
    let stats = null;
    try { stats = JSON.parse(readFileSync(join(dir, STATS_FILE), 'utf8')); } catch {}
    return {configured: Boolean(route?.key_enc), source: route?.source || 'ghostwire', provider: route?.provider || null, model: route?.model || null,
      key_last4: route?.key_last4 || null, key_unreadable: keyUnreadable, stats, mode: config.workspaceMode || 'premium'};
  }

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
      if (sub !== '') fail('not_found', 'Not found', 404);
      if (method === 'GET') return json(res, 200, view(dir, keyFile)), true;
      if (method === 'DELETE') { rmSync(join(dir, ROUTE_FILE), {force: true}); return json(res, 200, {configured: false, source: 'ghostwire'}), true; }
      if (method !== 'PUT') fail('not_found', 'Not found', 405);
      if (!SOURCES.includes(body.source)) fail('invalid_source', 'Choose a model source.');
      const stored = readRoute(dir);
      if (body.source === 'ghostwire') {
        writeRoute(dir, stored?.key_enc ? {...stored, source: 'ghostwire', updated_at: Date.now()} : {version: 1, source: 'ghostwire', updated_at: Date.now()});
        return json(res, 200, view(dir, keyFile)), true;
      }
      const entry = provider(registry, body.provider); checkModel(filter, entry, body.model);
      const master = readMasterKey(keyFile);
      let key = body.key, keyEnc;
      if (key === undefined && stored?.key_enc && stored.provider === entry.id) {
        try { key = decryptKey(master, stored.key_enc); keyEnc = stored.key_enc; } catch { key = undefined; }
      }
      checkKey(entry, key);
      if (!keyEnc || stored.model !== body.model) await testCall(entry, body.model, key);
      writeRoute(dir, {version: 1, source: body.source, provider: entry.id, model: body.model, key_enc: keyEnc || encryptKey(master, key), key_last4: key.slice(-4), updated_at: Date.now()});
      return json(res, 200, view(dir, keyFile)), true;
    } catch (error) {
      if (error instanceof RouteError) json(res, error.status, {error: error.message, code: error.code});
      else json(res, 503, {error: 'Model settings are unavailable. Try again.', code: 'unavailable'});
      return true;
    }
  };
}
