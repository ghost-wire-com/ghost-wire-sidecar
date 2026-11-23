// "My keys" chat for the console's Models tab: plain chat completions sent to the
// workspace broker with one of the user's saved keys ("byok:<id>"). The key never
// leaves the broker; Ghost Wire models keep using the console's own billed path.
//
// config.modelChat = {url, token?}
//   own PC:  {url: 'http://model-broker:8791', token: <workspace token>}
//   hosted:  {url: '<engineUrl>/model'}  (the access proxy adds the token)
import http from 'node:http';
import https from 'node:https';

const SAVED_KEY = /^byok:[a-z2-7]{8}$/;
const MAX_BODY = 1024 * 1024;

export function createModelChatHandler(config, json) {
  const target = config.modelChat?.url || (config.engineUrl ? new URL('model', config.engineUrl.endsWith('/') ? config.engineUrl : config.engineUrl + '/').href : null);
  const headers = () => ({'content-type': 'application/json', ...(config.modelChat?.token ? {authorization: 'Bearer ' + config.modelChat.token} : {})});
  const url = path => new URL(target.replace(/\/$/, '') + path);

  function forward(method, path, body, res, onError) {
    const destination = url(path);
    const transport = destination.protocol === 'https:' ? https : http;
    const upstream = transport.request(destination, {method, headers: {...headers(), ...(body ? {'content-length': body.length} : {})}}, response => {
      res.writeHead(response.statusCode, {'content-type': response.headers['content-type'] || 'application/json', 'cache-control': 'no-store'});
      response.pipe(res);
    });
    upstream.on('error', onError);
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  }

  return async (req, res) => {
    const path = req.url.split('?')[0];
    if (path !== '/engine/model-chat' && !path.startsWith('/engine/model-chat/')) return false;
    if (!config.hostedWorkspace || req.headers['x-ghostwire-mode'] !== (config.workspaceMode || 'premium')) return json(res, 403, {error: 'Workspace access is unavailable', code: 'forbidden'}), true;
    if (!target) return json(res, 503, {error: 'Your workspace needs an update to chat with your own keys.', code: 'model_chat_unavailable'}), true;
    const offline = () => { if (!res.headersSent) json(res, 503, {error: 'Your workspace is offline. Start it and try again.', code: 'workspace_offline'}); else res.end(); };

    if (req.method === 'GET' && path === '/engine/model-chat/models') {
      try {
        const response = await fetch(url('/v1/models'), {headers: headers(), signal: AbortSignal.timeout(8000)});
        const listed = response.ok ? await response.json() : null;
        const routes = (Array.isArray(listed?.data) ? listed.data : [])
          .filter(m => m?.owned_by === 'user' && SAVED_KEY.test(m.id))
          .map(m => ({id: m.id, label: String(m.label || m.model || m.id), provider: String(m.provider || ''), model: String(m.model || ''), broken: m.broken === true}));
        return json(res, 200, {default_id: listed?.default_id || 'ghostwire', routes}), true;
      } catch { return offline(), true; }
    }

    if (req.method === 'POST' && path === '/engine/model-chat/completions') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return json(res, 413, {error: 'Message too large', code: 'request_too_large'}), true; chunks.push(chunk); }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, {error: 'Invalid request', code: 'invalid_request'}), true; }
      if (!payload || !SAVED_KEY.test(payload.model)) return json(res, 400, {error: 'Choose one of your saved keys.', code: 'my_keys_only'}), true;
      forward('POST', '/v1/chat/completions', Buffer.from(JSON.stringify(payload)), res, offline);
      return true;
    }
    return json(res, 404, {error: 'Not found', code: 'not_found'}), true;
  };
}
