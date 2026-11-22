// An owned conversation adapter; credentials, model profiles and agent configuration never reach the customer.
import {createHash} from 'node:crypto';
export function createChatHandler({ db, upstream, json }) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (
    user_id INTEGER NOT NULL, request_id TEXT NOT NULL, conversation_id TEXT UNIQUE,
    agent_key TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS chat_sends (
    conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(conversation_id,request_id));`);
  if (!db.prepare('PRAGMA table_info(chat_sends)').all().some(column => column.name === 'fingerprint')) db.exec('ALTER TABLE chat_sends ADD COLUMN fingerprint TEXT');
  const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  const agents = async () => {
    const result = await upstream('/api/agents');
    return (result.agents || []).filter(agent => agent.enabled && (!agent.builtin || agent.role === 'assistant'))
      .map(agent => ({
        key: agent.key, name: String(agent.name).replace(/\bARTEX\b/gi, 'Ghost Wire'),
        description: String(agent.description || '').replace(/\bARTEX\b/gi, 'Ghost Wire'),
        builtin: agent.builtin, tools: agent.tool_count || 0, skills: agent.skill_count || 0,
      }));
  };
  return async (req, res, body, userId, path) => {
    if (path === '/agents' && req.method === 'GET') {
      json(res, 200, { agents: await agents() }); return true;
    }
    if (!path.startsWith('/chat/')) return false;
    if (path === '/chat/sessions' && req.method === 'GET') {
      const sessions = db.prepare("SELECT conversation_id AS id,agent_key,title FROM conversations WHERE user_id=? AND state='created' ORDER BY rowid DESC LIMIT 100").all(userId);
      json(res, 200, { sessions }); return true;
    }
    if (path === '/chat/sessions' && req.method === 'POST') {
      if (!uuid(body?.request_id) || typeof body.agent_key !== 'string' || !(await agents()).some(agent => agent.key === body.agent_key)) {
        json(res, 400, { error: 'Select an available agent' }); return true;
      }
      const old = db.prepare('SELECT conversation_id AS id,agent_key,title,state FROM conversations WHERE user_id=? AND request_id=?').get(userId, body.request_id);
      if (old && old.agent_key !== body.agent_key) { json(res,409,{error:'This request identifier belongs to another agent conversation.'}); return true; }
      if (old) { json(res, old.state === 'created' ? 200 : 409, old.state === 'created' ? old : { error: 'Conversation awaiting reconciliation' }); return true; }
      db.prepare("INSERT INTO conversations(user_id,request_id,agent_key,title,state) VALUES(?,?,?,'New conversation','pending')").run(userId, body.request_id, body.agent_key);
      const conversation = await upstream('/api/conversations', 'POST', { agent_key: body.agent_key, title: 'New conversation' });
      if (!/^[1-9][0-9]*$/.test(String(conversation.id))) throw Error('Invalid conversation');
      db.prepare("UPDATE conversations SET conversation_id=?,state='created' WHERE user_id=? AND request_id=?").run(String(conversation.id), userId, body.request_id);
      json(res, 201, { id: String(conversation.id), agent_key: body.agent_key, title: 'New conversation' }); return true;
    }
    const match = /^\/chat\/sessions\/([1-9][0-9]*)\/(messages|stop)$/.exec(path);
    if (!match || !db.prepare("SELECT 1 FROM conversations WHERE user_id=? AND conversation_id=? AND state='created'").get(userId, match[1])) {
      json(res, 404, { error: 'Not found' }); return true;
    }
    const id = match[1];
    if (req.method === 'GET' && match[2] === 'messages') {
      const result = await upstream(`/api/conversations/${id}/messages?limit=200`);
      const items = [];
      for (const item of result.items || []) {
        if (!['user','text','result','thinking','tool_use','tool_result'].includes(item.kind)) continue;
        let content = String(item.summary || '');
        if (['user','text','result'].includes(item.kind) && content.length >= 190 && /^[1-9][0-9]*$/.test(String(item.seq))) {
          const full = await upstream(`/api/conversations/${id}/messages/${item.seq}`);
          if (typeof full.detail === 'string' && full.detail) content = full.detail;
        }
        if (item.kind.startsWith('tool_')) content = item.tool || 'Agent tool';
        if (item.is_error) content = 'The agent could not complete this step. Try again later.';
        items.push({ id: String(item.seq), kind: item.kind, content: content.slice(0, 8000), error: !!item.is_error });
      }
      json(res, 200, { items, running: !!result.running, has_more: !!result.hasMore }); return true;
    }
    if (req.method === 'POST' && match[2] === 'stop') {
      await upstream(`/api/conversations/${id}/stop`, 'POST', {});
      json(res, 200, { status: 'stopping' }); return true;
    }
    if (req.method === 'POST' && match[2] === 'messages') {
      if (!uuid(body?.request_id) || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000) {
        json(res, 400, { error: 'Provide a message' }); return true;
      }
      const fingerprint=createHash('sha256').update(body.message.trim()).digest('hex');
      const old = db.prepare('SELECT state,fingerprint FROM chat_sends WHERE conversation_id=? AND request_id=?').get(id, body.request_id);
      if (old?.fingerprint && old.fingerprint !== fingerprint) { json(res,409,{error:'This request identifier was already used for another message.'});return true; }
      if (old) { json(res, old.state === 'accepted' ? 200 : 409, { status: old.state }); return true; }
      db.prepare("INSERT INTO chat_sends(conversation_id,request_id,state,fingerprint) VALUES(?,?,'pending',?)").run(id, body.request_id,fingerprint);
      await upstream(`/api/conversations/${id}/messages`, 'POST', { message: body.message.trim() });
      db.prepare("UPDATE chat_sends SET state='accepted' WHERE conversation_id=? AND request_id=?").run(id, body.request_id);
      db.prepare("UPDATE conversations SET title=? WHERE conversation_id=? AND title='New conversation'").run(body.message.trim().slice(0, 40), id);
      json(res, 202, { status: 'accepted' }); return true;
    }
    json(res, 400, { error: 'Unsupported action' }); return true;
  };
}
