// Small per-provider fixes for OpenAI-compatible endpoints, applied by the
// workspace broker only on the user's own-key route. Workers speak plain Chat
// Completions and drop fields they don't know, so the broker remembers what a
// provider needs echoed back and enforces each provider's request rules.
//
// Echoed back (remembered from replies, restored on the next request):
//   gemini     tool_calls[].extra_content.google.thought_signature (Gemini 3 rejects tool turns without it)
//   deepseek   assistant.reasoning_content on every assistant turn when tools are sent
//   openrouter assistant.reasoning_details, unchanged (Claude/Gemini routes)
// Request rules (pure):
//   mistral    tool-call ids must be exactly 9 alphanumerics; tool_choice "required" is called "any"
//   anthropic  rejects temperature/top_p on newer models, n > 1 and a forced tool_choice
import {createHash} from 'node:crypto';

export const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';
const MAX_FIELD = 1024 * 1024;

const hash = text => createHash('sha256').update(text).digest('hex');
const signatureOf = extra => {
  const value = extra?.google?.thought_signature;
  return typeof value === 'string' && value.length > 0 && value.length <= 65536 ? value : null;
};
const messageKey = message => {
  const first = Array.isArray(message?.tool_calls) ? message.tool_calls.find(tool => typeof tool?.id === 'string' && tool.id) : null;
  if (first) return 'tool:' + first.id;
  return typeof message?.content === 'string' && message.content ? 'text:' + hash(message.content) : null;
};
// Streamed reasoning_details arrive in pieces; join consecutive pieces of the same entry.
function mergeDetails(items) {
  const merged = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const last = merged[merged.length - 1];
    if (last && last.index === item.index && last.type === item.type) {
      for (const field of ['text', 'summary', 'data']) if (typeof item[field] === 'string') last[field] = (last[field] || '') + item[field];
    } else merged.push({...item});
  }
  return merged;
}

export function createReplyStore({max = 5000} = {}) {
  const toolExtras = new Map(), messageFields = new Map();
  const bounded = (map, key, value) => {
    map.delete(key); map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  };
  const rememberTool = (id, extra) => { if (typeof id === 'string' && id && signatureOf(extra)) bounded(toolExtras, id, extra); };
  const rememberMessage = (key, fields) => {
    if (!key) return;
    const value = {};
    if (typeof fields.reasoning_content === 'string' && fields.reasoning_content && fields.reasoning_content.length <= MAX_FIELD) value.reasoning_content = fields.reasoning_content;
    if (Array.isArray(fields.reasoning_details) && fields.reasoning_details.length) value.reasoning_details = fields.reasoning_details;
    if (Object.keys(value).length) bounded(messageFields, key, value);
  };

  function captureJson(body) {
    if (!body || !Array.isArray(body.choices)) return;
    for (const choice of body.choices) {
      const message = choice?.message;
      if (!message) continue;
      for (const tool of Array.isArray(message.tool_calls) ? message.tool_calls : []) rememberTool(tool?.id, tool?.extra_content);
      rememberMessage(messageKey(message), message);
    }
  }

  function sseCapture() {
    let buffer = '';
    const choices = new Map();
    const stateFor = index => {
      if (!choices.has(index)) choices.set(index, {content: '', reasoning: '', details: [], tools: new Map(), last: null});
      return choices.get(index);
    };
    const finish = () => {
      for (const state of choices.values()) {
        const tools = [...state.tools.values()].filter(tool => tool.id);
        const key = tools.length ? 'tool:' + tools[0].id : (state.content ? 'text:' + hash(state.content) : null);
        rememberMessage(key, {reasoning_content: state.reasoning, reasoning_details: mergeDetails(state.details)});
      }
    };
    const event = data => {
      if (data === '[DONE]') { finish(); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { return; }
      for (const choice of Array.isArray(parsed?.choices) ? parsed.choices : []) {
        const state = stateFor(Number.isInteger(choice?.index) ? choice.index : 0);
        const delta = choice?.delta || {};
        if (typeof delta.content === 'string' && state.content.length < MAX_FIELD) state.content += delta.content;
        if (typeof delta.reasoning_content === 'string' && state.reasoning.length < MAX_FIELD) state.reasoning += delta.reasoning_content;
        if (Array.isArray(delta.reasoning_details) && state.details.length < 10000) state.details.push(...delta.reasoning_details);
        for (const tool of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          // Some providers omit `index`; then a delta with an id starts a new call and one without continues the last.
          const slot = Number.isInteger(tool?.index) ? 'i' + tool.index : (typeof tool?.id === 'string' && tool.id ? 'id:' + tool.id : state.last);
          if (!slot) continue;
          const entry = state.tools.get(slot) || {id: null, extra: null};
          if (typeof tool?.id === 'string' && tool.id) entry.id = tool.id;
          if (tool?.extra_content) entry.extra = tool.extra_content;
          state.tools.set(slot, entry); state.last = slot;
          if (entry.id && entry.extra) rememberTool(entry.id, entry.extra);
        }
        if (choice?.finish_reason) finish();
      }
    };
    return {
      write(chunk) {
        buffer += chunk.toString('utf8');
        if (buffer.length > 4 * 1024 * 1024) buffer = '';
        let end;
        while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) event(data);
        }
      },
    };
  }

  function restore(providerId, payload) {
    if (!payload || !Array.isArray(payload.messages)) return payload;
    const withTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    let changed = false;
    const messages = payload.messages.map(message => {
      if (message?.role !== 'assistant') return message;
      if (providerId === 'gemini' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
        changed = true;
        return {...message, tool_calls: message.tool_calls.map(tool => {
          if (signatureOf(tool?.extra_content)) return tool;
          const known = toolExtras.get(tool?.id);
          return {...tool, extra_content: known || {...tool?.extra_content, google: {...tool?.extra_content?.google, thought_signature: PLACEHOLDER_SIGNATURE}}};
        })};
      }
      if (providerId === 'deepseek' && typeof message.reasoning_content !== 'string') {
        const known = messageFields.get(messageKey(message))?.reasoning_content;
        if (known !== undefined || withTools) { changed = true; return {...message, reasoning_content: known ?? ''}; }
      }
      if (providerId === 'openrouter' && !Array.isArray(message.reasoning_details)) {
        const known = messageFields.get(messageKey(message))?.reasoning_details;
        if (known) { changed = true; return {...message, reasoning_details: known}; }
      }
      return message;
    });
    return changed ? {...payload, messages} : payload;
  }

  return {captureJson, sseCapture, restore, size: () => toolExtras.size + messageFields.size};
}

const MISTRAL_ID = /^[a-zA-Z0-9]{9}$/;
const mistralId = id => (typeof id === 'string' && !MISTRAL_ID.test(id) ? hash(id).slice(0, 9) : id);

export function adaptRequest(providerId, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (providerId === 'mistral') {
    const out = {...payload};
    if (out.tool_choice === 'required') out.tool_choice = 'any';
    if (Array.isArray(payload.messages)) out.messages = payload.messages.map(message => {
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) return {...message, tool_calls: message.tool_calls.map(tool => ({...tool, id: mistralId(tool?.id)}))};
      if (message?.role === 'tool' && typeof message.tool_call_id === 'string') return {...message, tool_call_id: mistralId(message.tool_call_id)};
      return message;
    });
    return out;
  }
  if (providerId === 'anthropic') {
    const out = {...payload};
    delete out.temperature; delete out.top_p;
    if (out.n !== undefined) out.n = 1;
    if (out.tool_choice === 'required' || (out.tool_choice && typeof out.tool_choice === 'object')) out.tool_choice = 'auto';
    return out;
  }
  return payload;
}
