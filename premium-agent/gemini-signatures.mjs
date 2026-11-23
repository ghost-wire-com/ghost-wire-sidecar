// Gemini 3 (OpenAI-compatible endpoint) attaches a "thought signature" to every
// tool call and rejects the next turn unless the assistant's tool calls carry it
// back unchanged. Workers speak plain Chat Completions and drop unknown fields,
// so the broker remembers signatures by tool-call id and restores them.
// When a signature is unknown (e.g. after a restart), Google's documented
// placeholder lets the request through.
export const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';

const signatureOf = extra => {
  const value = extra?.google?.thought_signature;
  return typeof value === 'string' && value.length > 0 && value.length <= 65536 ? value : null;
};

export function createSignatureStore({max = 5000} = {}) {
  const signatures = new Map();
  const remember = (id, extra) => {
    const value = signatureOf(extra);
    if (typeof id !== 'string' || !id || !value) return;
    signatures.delete(id);
    signatures.set(id, value);
    while (signatures.size > max) signatures.delete(signatures.keys().next().value);
  };

  function captureJson(body) {
    if (!body || !Array.isArray(body.choices)) return;
    for (const choice of body.choices) for (const tool of choice?.message?.tool_calls || []) remember(tool?.id, tool?.extra_content);
  }

  // Streaming: a tool call's id comes on its first delta; later deltas refer to it by index.
  function sseCapture() {
    let buffer = '';
    const ids = new Map(), pending = new Map();
    const event = data => {
      if (data === '[DONE]') return;
      let parsed;
      try { parsed = JSON.parse(data); } catch { return; }
      for (const choice of Array.isArray(parsed?.choices) ? parsed.choices : []) {
        for (const tool of choice?.delta?.tool_calls || []) {
          const index = Number.isInteger(tool?.index) ? tool.index : 0;
          if (typeof tool?.id === 'string' && tool.id) ids.set(index, tool.id);
          if (tool?.extra_content) pending.set(index, tool.extra_content);
          const id = ids.get(index), extra = pending.get(index);
          if (id && extra) remember(id, extra);
        }
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

  function restore(payload) {
    if (!payload || !Array.isArray(payload.messages)) return payload;
    if (!payload.messages.some(m => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length)) return payload;
    return {...payload, messages: payload.messages.map(message => {
      if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
      return {...message, tool_calls: message.tool_calls.map(tool => {
        if (signatureOf(tool?.extra_content)) return tool;
        const known = signatures.get(tool?.id);
        return {...tool, extra_content: {...tool?.extra_content, google: {...tool?.extra_content?.google, thought_signature: known || PLACEHOLDER_SIGNATURE}}};
      })};
    })};
  }

  return {captureJson, sseCapture, restore, size: () => signatures.size};
}
