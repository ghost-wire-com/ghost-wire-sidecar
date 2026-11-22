import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatHandler } from './chat.mjs';
import { createEngineProxy } from './engine-proxy.mjs';
import {createWorkspaceProvisioner} from './workspace-provisioner.mjs';
import {createMiningProxy} from './mining-proxy.mjs';
import {createModelRouteHandler} from './model-route.mjs';

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
const taskView = task => ({
  id: String(task.id), name: task.name || task.description, description: task.description,
  goal: task.goal, status: task.status, created_at: task.created_at,
  goals_total: task.goals_total, goals_met: task.goals_met,
});

export function createPremiumAgent(config) {
  if (!config.secret || config.secret.length < 32 || !Number.isSafeInteger(config.testUserId) || config.testUserId < 1) {
    throw Error('A gateway secret and single test user are required');
  }
  const base = new URL(config.engineUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !['http:', 'https:'].includes(base.protocol)) throw Error('Invalid worker origin');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', 'worker'].includes(base.hostname)) {
    throw Error('Remote worker requires HTTPS');
  }
  mkdirSync(dirname(config.database), { recursive: true });
  const db = new DatabaseSync(config.database);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tasks (user_id INTEGER NOT NULL, request_id TEXT NOT NULL,
      task_id TEXT, state TEXT NOT NULL, PRIMARY KEY(user_id, request_id), UNIQUE(task_id));`);
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'fingerprint')) db.exec('ALTER TABLE tasks ADD COLUMN fingerprint TEXT');
  let token = config.engineToken;
  async function upstream(path, method = 'GET', data) {
    if (!token) {
      const login = await fetch(new URL('/api/auth/login', base), {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ username: config.engineUsername || 'GHOSTWIRE', password: config.enginePassword }), signal: AbortSignal.timeout(15000),
      });
      if (!login.ok) throw Error('Worker authentication unavailable');
      token = (await login.json()).token;
      if (!token) throw Error('Worker authentication unavailable');
    }
    const response = await fetch(new URL(path, base), {
      method, redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401) token = undefined; // A subsequent explicit request can sign in again. Never replay creation.
    if (!response.ok) throw Error('Worker request unavailable');
    // Bound bytes before parsing, including chunked replies. Truncating after
    // response.json()/text() would already have allocated the entire response.
    const chunks=[]; let length=0;
    for await (const chunk of response.body) {
      length+=chunk.length;
      if (length > 2*1024*1024) throw Error('Worker response too large');
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks).toString('utf8');
    if (path.startsWith('/api/report?')) return { report:raw.slice(0,1_000_000) };
    return JSON.parse(raw);
  }
  async function taskSnapshot(id) {
    const [task, progress] = await Promise.all([upstream(`/api/tasks/${id}`), upstream(`/api/tasks/${id}/goals`)]);
    if (String(task.id) !== id) throw Error('ARTEX task identity mismatch');
    const view = taskView(task);
    if (Array.isArray(progress.goals)) {
      view.goals_total = progress.goals.length;
      view.goals_met = progress.goals.filter(goal => goal.state === 'met').length;
    }
    return view;
  }
  const chat = createChatHandler({ db, upstream, json });
  const engineProxy = createEngineProxy(config, db, json);
  const miningProxy = createMiningProxy(config, json);
  const modelRoute = createModelRouteHandler(config, json);
  const server = http.createServer(async (req, res) => {
    try {
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${config.secret}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: 'Unauthorized' });
      const userId = Number(req.headers['x-ghostwire-user']);
      if (userId !== config.testUserId) return json(res, 403, { error: 'This test workspace is unavailable' });
      if (await miningProxy(req,res)) return;
      if (await modelRoute(req,res)) return;
      if (await engineProxy(req,res)) return;
      const path = req.url;
      if (req.method === 'GET' && path === '/status') {
        await upstream('/api/health');
        return json(res, 200, { online: true, mode: config.workspaceMode || 'premium', engine: 'Ghost Wire', mining_configured: Boolean(config.miningSecret) });
      }
      let body;
      if (req.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 16384) return json(res, 413, { error: 'Request too large' });
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { return json(res, 400, { error: 'Invalid request' }); }
      }
      if (await chat(req, res, body, userId, path)) return;
      if (path === '/tasks' && req.method === 'GET') {
        const rows = db.prepare("SELECT task_id FROM tasks WHERE user_id = ? AND state = 'created' ORDER BY rowid DESC LIMIT 100").all(userId);
        const tasks = [];
        for (const row of rows) tasks.push(await taskSnapshot(row.task_id));
        return json(res, 200, { tasks });
      }
      if (path === '/findings' && req.method === 'GET') {
        const rows = db.prepare("SELECT task_id FROM tasks WHERE user_id = ? AND state = 'created' ORDER BY rowid DESC LIMIT 100").all(userId);
        const findings = [];
        let truncated = false;
        for (const row of rows) {
          // Always request a specific owned task. Never use ARTEX's global findings endpoint.
          const entries = await upstream(`/api/exploration/findings?task=${row.task_id}`);
          if (!Array.isArray(entries)) throw Error('Invalid findings response');
          for (const entry of entries) {
            if (entry.inherited || String(entry.task_id) !== row.task_id) continue;
            if (findings.length >= 1000) { truncated = true; break; }
            findings.push({
              id: `${row.task_id}:${entry.id}`, task_id: row.task_id,
              name: String(entry.name || entry.vulnclass || 'Finding').slice(0, 200),
              severity: String(entry.severity || 'unknown'), status: String(entry.status || 'pending'),
              summary: String(entry.summary || '').slice(0, 8000), evidence: String(entry.evidence || '').slice(0, 8000),
              created_at: entry.ts,
            });
          }
          if (truncated) break;
        }
        return json(res, 200, { findings, truncated });
      }
      if (path === '/tasks' && req.method === 'POST') {
        if (!body || typeof body.goal !== 'string' || body.goal.trim().length < 3 || body.goal.length > 8000 ||
            typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 120 ||
            typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.request_id)) {
          return json(res, 400, { error: 'Provide a task name, goal and request identifier' });
        }
        const fingerprint = createHash('sha256').update(JSON.stringify([body.name.trim(),body.goal.trim()])).digest('hex');
        const old = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND request_id = ?').get(userId, body.request_id);
        if (old?.fingerprint && old.fingerprint !== fingerprint) return json(res,409,{error:'This request identifier was already used for another task.'});
        if (old?.task_id) return json(res, 200, await taskSnapshot(old.task_id));
        if (old) return json(res, 409, { error: 'Task submission is awaiting reconciliation. Do not resubmit it.' });
        // Claim before calling ARTEX. If a network failure leaves creation ambiguous, fail closed instead of duplicating work.
        db.prepare("INSERT INTO tasks(user_id,request_id,state,fingerprint) VALUES(?,?,'pending',?)").run(userId, body.request_id, fingerprint);
        const task = await upstream('/api/tasks', 'POST', {
          name: body.name.trim(), description: body.name.trim(), goal: body.goal.trim(),
          timeout_seconds: 0, seed_first_intent: false, coverage_enabled: false,
        });
        if (!/^[1-9][0-9]*$/.test(String(task.id))) throw Error('Invalid task response');
        db.prepare("UPDATE tasks SET task_id = ?, state = 'created' WHERE user_id = ? AND request_id = ?")
          .run(String(task.id), userId, body.request_id);
        return json(res, 201, taskView(task));
      }
      const match = /^\/tasks\/([1-9][0-9]*)(\/(control|report))?$/.exec(path);
      if (!match) return json(res, 404, { error: 'Not found' });
      const id = match[1];
      if (!db.prepare('SELECT 1 FROM tasks WHERE task_id = ? AND user_id = ?').get(id, userId)) {
        return json(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' && !match[3]) return json(res, 200, await taskSnapshot(id));
      if (req.method === 'GET' && match[3] === 'report') {
        const [report, goals, activity] = await Promise.all([
          upstream(`/api/report?task=${id}`), upstream(`/api/tasks/${id}/goals`),
          upstream(`/api/exploration/activity?task=${id}&limit=100`),
        ]);
        const goalText = (goals.goals || []).map(goal => `- [${goal.state}] ${goal.text}`).join('\n');
        const progress = (activity.items || []).filter(item => ['text', 'result', 'error'].includes(item.kind))
          .slice(-20).map(item => `${item.worker}: ${String(item.summary || '').slice(0, 4000)}`).join('\n\n');
        return json(res, 200, { report: `## Goals\n${goalText || 'The agent is preparing its goals.'}\n\n## Agent progress\n${progress || 'No progress recorded yet.'}\n\n${report.report}` });
      }
      if (req.method === 'POST' && match[3] === 'control' && ['pause', 'resume'].includes(body?.action)) {
        const result = await upstream(`/api/tasks/${id}/control`, 'POST', { action: body.action });
        return json(res,200,{id,status:String(result.status || ''),paused:!!result.paused,queued:!!result.queued});
      }
      return json(res, 400, { error: 'Unsupported action' });
    } catch {
      // No upstream bodies, goals, account credentials or bearer tokens in errors/logs.
      json(res, 503, { error: 'Premium engine unavailable. A submitted task may still be running; refresh before retrying.' });
    }
  });
  server.on('close', () => db.close());
  server.requestTimeout = 35000;
  return server;
}

export function createWorkspaceGateway(config) {
  if (!Array.isArray(config.workspaces) || !config.workspaces.length || typeof config.secret !== 'string' || config.secret.length < 32) throw Error('Workspace assignments and a gateway secret are required');
  const handlers = new Map(), records = new Map(), active = new Map(), urls = new Set(), databases = new Set();
  const install = (workspace,replace=false) => {
    const url = new URL(workspace.engineUrl).href;
    const old=records.get(workspace.testUserId);
    if(old && !replace)throw Error('Every account requires a distinct engine and ownership database');
    if (urls.has(url) && old?.engineUrl!==workspace.engineUrl || databases.has(workspace.database) && old?.database!==workspace.database) throw Error('Every account requires a distinct engine and ownership database');
    if(old){handlers.get(workspace.testUserId).emit('close');urls.delete(new URL(old.engineUrl).href);databases.delete(old.database);}
    records.set(workspace.testUserId,workspace);
    const handler = createPremiumAgent({...workspace,secret:config.secret});
    urls.add(url);databases.add(workspace.database);
    handlers.set(workspace.testUserId,handler);
  };
  for (const workspace of config.workspaces) install(workspace);
  const provision = config.autoProvision ? createWorkspaceProvisioner(config.autoProvision,workspace=>install(workspace,true),config.workspaces,id=>!active.get(id)) : null;
  const server=http.createServer(async(req,res)=>{
    try {
      const supplied=Buffer.from(req.headers.authorization || ''),expected=Buffer.from('Bearer '+config.secret);
      if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return json(res,401,{error:'Unauthorized'});
      if(req.url==='/provision') {
        if(req.method!=='POST' || !provision)return json(res,404,{error:'Not found'});
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)return json(res,413,{error:'Request too large'});chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(res,400,{error:'Invalid workspace request'});}
        const result=await provision(body);return json(res,result.status,result.body);
      }
      const id=Number(req.headers['x-ghostwire-user']);
      if(provision?.isMigrating(id))return json(res,503,{error:'Workspace plan is updating. Please retry'});
      const handler=handlers.get(id);
      if(!handler)return json(res,403,{error:'Workspace is not assigned'});
      // Read streams can reconnect after an idle plan update. Only in-flight
      // mutations block migration; the worker itself verifies running work.
      if(req.method!=='GET') {
        active.set(id,(active.get(id)||0)+1);
        let finished=false;const finish=()=>{if(!finished){finished=true;active.set(id,active.get(id)-1);}};res.on('finish',finish);res.on('close',finish);
      }
      handler.emit('request',req,res);
    }catch{if(!res.headersSent)json(res,503,{error:'Workspace provisioning unavailable; retry safely'});else res.end();}
  });
  server.requestTimeout=125000;
  server.on('close',()=>{for(const handler of handlers.values())handler.emit('close');});
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.env.GHOSTWIRE_PREMIUM_CONFIG || 'config.private.json', 'utf8'));
  (config.workspaces ? createWorkspaceGateway(config) : createPremiumAgent(config)).listen(config.port || 8795, '127.0.0.1', () => console.log('Premium agent listening on loopback'));
}
