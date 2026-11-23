import {createHash} from 'node:crypto';
const roots = new Set(['model-routes','companies','task-archives','audit','triggers','asset-intercept','health','tasks','task-categories','task-templates','assets','asset-groups','exploration','report','conversations','chat','agents','tools','skills','workspace','traffic','commands','usage','stats','token-stats','tokens','side-questions','coverage','llm-records','intercept','judge','llm','mcp','notify','settings','logs','visibility']);
const digest = value => createHash('sha256').update(value).digest('hex');
export function createEngineProxy(config, db, json) {
 db.exec(`CREATE TABLE IF NOT EXISTS workspace_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER, content_type TEXT, response BLOB)`);
 let token;
 const base = new URL(config.engineUrl);
 return async (req,res) => {
  if (!req.url.startsWith('/engine/')) return false;
  if (!config.hostedWorkspace || req.headers['x-ghostwire-mode'] !== (config.workspaceMode || 'premium')) {json(res,403,{error:'Workspace access is unavailable'});return true;}
  const url=new URL(req.url.slice('/engine'.length),'http://workspace');
  const root=url.pathname.split('/')[1];
  if (!roots.has(root) || url.pathname.includes('..') || url.pathname.includes('\\') || /\/(llm|llm-profiles)(\/|$)/.test(url.pathname) && req.method !== 'GET') {json(res,403,{error:'This setting is managed by Ghost Wire'});return true;}
  if (!['GET','POST','PUT','PATCH','DELETE'].includes(req.method)) {json(res,405,{error:'Unsupported method'});return true;}
  let body=Buffer.alloc(0),requestId,fingerprint;
  if(req.method !== 'GET') {
   requestId=req.headers['x-request-id'];
   if(typeof requestId !== 'string'|| !/^[0-9a-f-]{36}$/.test(requestId)){json(res,400,{error:'A request identifier is required'});return true;}
   const chunks=[];let bytes=0;
   for await(const c of req){bytes+=c.length;if(bytes>16*1024*1024){json(res,413,{error:'Request too large'});return true;}chunks.push(c);}
   body=Buffer.concat(chunks);fingerprint=digest(Buffer.concat([Buffer.from(req.method+' '+url.pathname+url.search+' '+(req.headers['content-type']||'')),body]));
   const old=db.prepare('SELECT * FROM workspace_requests WHERE request_id=?').get(requestId);
   if(old){if(old.fingerprint!==fingerprint||!old.status){json(res,409,{error:'Request awaiting reconciliation or identifier reused'});return true;}res.writeHead(old.status,{'content-type':old.content_type,'cache-control':'no-store'});res.end(old.response);return true;}
   db.prepare('INSERT INTO workspace_requests(request_id,fingerprint) VALUES(?,?)').run(requestId,fingerprint);
  }
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),60000);
  res.on('close',()=>abort.abort());
  try {
   if(!token){const r=await fetch(new URL('/api/auth/login',base),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({username:config.engineUsername || 'GHOSTWIRE',password:config.enginePassword}),signal:abort.signal});if(!r.ok)throw Error('login');token=(await r.json()).token;if(!token)throw Error('login');}
   const target=new URL('/api'+url.pathname+url.search,base);
   const response=await fetch(target,{method:req.method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':req.headers['content-type']||'application/json',...(req.headers['last-event-id']?{'last-event-id':req.headers['last-event-id']}:{})},body:req.method==='GET'?undefined:body,signal:abort.signal});
   if(response.status===401)token=undefined;
   const type=response.headers.get('content-type')||'application/octet-stream';
   if(type.includes('text/event-stream')){
    res.writeHead(response.status,{'content-type':type,'cache-control':'no-store','x-accel-buffering':'no'});
    for await(const chunk of response.body){if(!res.write(chunk))await new Promise(resolve=>{res.once('drain',resolve);res.once('close',resolve);});if(res.destroyed)break;}
    res.end();return true;
   }
   const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>20*1024*1024)throw Error('large');chunks.push(chunk);}let result=Buffer.concat(chunks);
   if(type.includes('application/json')){
    const value=JSON.parse(result.toString('utf8'),(key,value)=> /^(api_?key|password|secret|authorization|dsn)$/i.test(key)&&typeof value==='string'?'':value);
    result=Buffer.from(JSON.stringify(value));
    if(response.ok && req.method==='POST' && ['/tasks','/conversations'].includes(url.pathname) && /^\d+$/.test(String(value.id))) {
     const input=JSON.parse(body.toString('utf8')||'{}');
     if(url.pathname==='/tasks') db.prepare("INSERT OR IGNORE INTO tasks(user_id,request_id,task_id,state,fingerprint) VALUES(?,?,?,'created',?)").run(config.testUserId,requestId,String(value.id),digest(JSON.stringify([input.name||'',input.goal||''])));
     if(url.pathname==='/conversations') db.prepare("INSERT OR IGNORE INTO conversations(user_id,request_id,conversation_id,agent_key,title,state) VALUES(?,?,?,?,?,'created')").run(config.testUserId,requestId,String(value.id),input.agent_key||'',input.title||'New conversation');
    }
    if(response.ok && req.method==='DELETE') {
     const task=/^\/tasks\/(\d+)$/.exec(url.pathname),conversation=/^\/conversations\/(\d+)$/.exec(url.pathname);
     if(task)db.prepare('DELETE FROM tasks WHERE user_id=? AND task_id=?').run(config.testUserId,task[1]);
     if(conversation)db.prepare('DELETE FROM conversations WHERE user_id=? AND conversation_id=?').run(config.testUserId,conversation[1]);
    }
   }
   if(requestId){if(result.length>2*1024*1024)throw Error('large mutation');db.prepare('UPDATE workspace_requests SET status=?,content_type=?,response=? WHERE request_id=?').run(response.status,type,result,requestId);}
   res.writeHead(response.status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(result);
  }catch{if(!res.headersSent)json(res,503,{error:'Worker unavailable. Refresh before resubmitting.'});else res.end();}finally{clearTimeout(timer);}
  return true;
 };
}
