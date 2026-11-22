import {setTimeout as delay} from 'node:timers/promises';
import {createPremiumAgent} from '../premium-agent/server.mjs';

// One outbound TLS connection, no public listener, no request replay on reconnect.
export const DEFAULT_ORIGIN=process.env.GHOSTWIRE_APP_ORIGIN||'https://app.ghost-wire.com';
export function validateSidecarOrigin(value, allowed=(process.env.GHOSTWIRE_APP_ORIGINS||DEFAULT_ORIGIN).split(',').map(item=>item.trim()).filter(Boolean)) {
  const parsed=new URL(value);
  if(parsed.protocol!=='https:'||parsed.pathname!=='/'||parsed.username||parsed.password||parsed.search||parsed.hash||!allowed.includes(parsed.origin))throw Error('Sidecar requires the Ghost Wire service');
  return parsed.origin;
}
export async function connectSidecar(config, {origin=DEFAULT_ORIGIN, signal, onStatus=console.log}={}) {
  origin=validateSidecarOrigin(origin);
  const adapter=createPremiumAgent({...config,hostedWorkspace:true,workspaceMode:'api'});
  await new Promise(resolve=>adapter.listen(0,'127.0.0.1',resolve));
  const local=`http://127.0.0.1:${adapter.address().port}`;
  try {
    let credentialInvalid=false;
    while(!signal?.aborted&&!credentialInvalid) {
      onStatus('Connecting to Ghost Wire…');
      await new Promise(resolve=>{
        const ws=new WebSocket(origin.replace('https:','wss:')+'/sidecar/connect');
        const active=new Map();let authenticated=false;
        const send=message=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));};
        const timer=setInterval(()=>{if(authenticated)send({type:'heartbeat'});},15000);
        const authTimer=setTimeout(()=>{if(!authenticated)ws.close();},12000);
        const stop=()=>ws.close();signal?.addEventListener('abort',stop,{once:true});
        ws.addEventListener('open',()=>send({type:'auth',token:config.credential}));
        ws.addEventListener('message',async event=>{
          let message;try{message=JSON.parse(event.data);}catch{ws.close();return;}
          if(message.type==='authenticated'){authenticated=true;clearTimeout(authTimer);onStatus('Connected. Work runs on this PC; AI uses Ghost Wire credits.');return;}
          if(message.type==='heartbeat')return;
          if(message.type==='cancel'){active.get(message.id)?.abort();return;}
          if(!authenticated||message.type!=='request'||active.has(message.id)||active.size>=32)return;
          const target=new URL(message.path,local);
          if(target.origin!==local||!['/status','/engine/'].some(p=>target.pathname===p||p.endsWith('/')&&target.pathname.startsWith(p)))return;
          const abort=new AbortController();active.set(message.id,abort);
          try{
            const response=await fetch(target,{method:message.method,redirect:'error',headers:{...message.headers,authorization:'Bearer '+config.secret,'x-ghostwire-user':String(config.testUserId),'x-ghostwire-mode':'api'},body:message.method==='GET'?undefined:Buffer.from(message.body||'','base64'),signal:abort.signal});
            send({type:'response',id:message.id,status:response.status,headers:{'content-type':response.headers.get('content-type')||'application/json'}});
            let total=0;
            for await(const chunk of response.body){total+=chunk.length;if(total>20*1024*1024)throw Error('large');for(let at=0;at<chunk.length;at+=48*1024){while(ws.bufferedAmount>1024*1024&&ws.readyState===WebSocket.OPEN&&!abort.signal.aborted)await new Promise(r=>setTimeout(r,20));if(ws.readyState!==WebSocket.OPEN||abort.signal.aborted)throw Error('closed');send({type:'chunk',id:message.id,body:Buffer.from(chunk.subarray(at,at+48*1024)).toString('base64')});}}
            send({type:'end',id:message.id});
          }catch{if(!abort.signal.aborted){send({type:'response',id:message.id,status:503,headers:{'content-type':'application/json'}});send({type:'end',id:message.id});}}
          finally{active.delete(message.id);}
        });
        ws.addEventListener('error',()=>ws.close());
        ws.addEventListener('close',event=>{if(event.code===1008){credentialInvalid=true;onStatus('This computer was disconnected. In Ghost Wire open Use my computer, copy the line again and run it (same account, same folder; your data is kept).');}clearInterval(timer);clearTimeout(authTimer);signal?.removeEventListener('abort',stop);for(const abort of active.values())abort.abort();onStatus('Computer offline. Retrying the encrypted connection; work is never moved to hosted infrastructure.');resolve();});
      });
      if(!signal?.aborted&&!credentialInvalid)try{await delay(5000,undefined,{signal});}catch{}
    }
  }finally{adapter.closeAllConnections();await new Promise(resolve=>adapter.close(resolve));}
}
