import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

// A single gateway owns this durable registry. Serial enrollment prevents port
// collisions, duplicate workers and capacity races during concurrent first login.
export function createWorkspaceProvisioner(config, install, assigned = [], canMigrate = () => true) {
  if (!config || !isAbsolute(config.root) || !isAbsolute(config.script) || !Number.isSafeInteger(config.capacity) || config.capacity < 1 ||
      !Number.isSafeInteger(config.portStart) || !Number.isSafeInteger(config.portEnd) || config.portStart < 1024 || config.portEnd > 65535 || config.portEnd < config.portStart || !config.model) throw Error('Invalid automatic workspace provisioning configuration');
  mkdirSync(config.root,{recursive:true,mode:0o700});
  const registryFile=join(config.root,'reservations.private.json');
  const reservations=existsSync(registryFile)?JSON.parse(readFileSync(registryFile,'utf8')):{};
  const persistReservations=()=>{
    const descriptor=openSync(registryFile+'.tmp','w',0o600);
    try{writeFileSync(descriptor,JSON.stringify(reservations));fsyncSync(descriptor);}finally{closeSync(descriptor);}
    renameSync(registryFile+'.tmp',registryFile);
  };
  const installed=new Map(assigned.map(workspace=>[workspace.testUserId,workspace]));
  const usedPorts=new Set(assigned.map(workspace=>Number(new URL(workspace.engineUrl).port)));
  for(const [id,reservation] of Object.entries(reservations)) {
    const previous=installed.get(Number(id));
    if(!/^[1-9][0-9]*$/.test(id)||!Number.isSafeInteger(reservation.port)||!['api','premium'].includes(reservation.mode)||usedPorts.has(reservation.port)&&(!previous || Number(new URL(previous.engineUrl).port)!==reservation.port))throw Error('Invalid or duplicate reserved workspace port');
    usedPorts.add(reservation.port);
    const file=join(config.root,id,'adapter.private.json');
    if(existsSync(file)) {
      const adapter=JSON.parse(readFileSync(file,'utf8'));
      if(adapter.testUserId!==Number(id)||adapter.engineUrl!==`http://127.0.0.1:${reservation.port}`)throw Error('Workspace reservation identity mismatch');
      if(previous && (previous.engineUrl!==adapter.engineUrl || previous.database!==adapter.database))throw Error('Existing workspace identity mismatch');
      reservation.mode=adapter.workspaceMode;install(adapter);installed.set(adapter.testUserId,adapter);
    }
  }
  let pending=Promise.resolve();
  const jobs=new Map(),migrating=new Set();
  const provision=request=> {
    const execute=async()=> {
      const id=request.user_id,mode=request.mode;
      if(!Number.isSafeInteger(id)||id<1||!['api','premium'].includes(mode))return {status:400,body:{ready:false,code:'invalid_workspace'}};
      if((config.retiredAccounts||[]).includes(id))return {status:409,body:{ready:false,code:'workspace_plan_migration'}};
      const previous=installed.get(id);
      if(previous && previous.workspaceMode===mode)return {status:200,body:{ready:true}};
      if(previous && !canMigrate(id))return {status:409,body:{ready:false,code:'workspace_busy'}};
      if(mode==='premium'&&(!config.premiumOrigin||!config.premiumKeyFile||!config.premiumModel))return {status:503,body:{ready:false,code:'premium_unavailable'}};
      let reservation=reservations[id];
      if(previous && !reservation) {
        // Existing enrolled API workers may predate the automatic registry.
        if(previous.database!==join(config.root,String(id),'ownership.db'))return {status:409,body:{ready:false,code:'workspace_plan_migration'}};
        reservation={port:Number(new URL(previous.engineUrl).port),mode:previous.workspaceMode};reservations[id]=reservation;
      }
      if(previous)migrating.add(id);
      if(!reservation) {
        if(installed.size+Object.keys(reservations).filter(user=>!installed.has(Number(user))).length>=config.capacity)return {status:503,body:{ready:false,code:'workspace_capacity'}};
        let port=config.portStart;while(usedPorts.has(port)&&port<=config.portEnd)port++;
        if(port>config.portEnd)return {status:503,body:{ready:false,code:'workspace_capacity'}};
        reservation={port,mode};reservations[id]=reservation;usedPorts.add(port);
        persistReservations();
      }
      if(mode==='api'&&(typeof request.api_key!=='string'||request.api_key.length<32))return {status:409,body:{ready:false,code:'workspace_key_required'}};
      const payload={user_id:id,mode,port:reservation.port,model:mode==='api'?config.model:config.premiumModel,api_key:request.api_key,premium_origin:config.premiumOrigin,premium_key_file:config.premiumKeyFile,premium_network:mode==='premium'?config.premiumNetwork:undefined,worker_image:config.workerImage};
      const success=await new Promise(resolve=> {
        const child=spawn(config.python||'python3',[config.script,'--request-stdin','--workspace-root',config.root],{stdio:['pipe','pipe','ignore'],windowsHide:true});
        let output='',finished=false;
        const finish=value=>{if(!finished){finished=true;clearTimeout(timer);resolve(value);}};
        const timer=setTimeout(()=>{child.kill('SIGTERM');finish(false);},180000);
        child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();finish(false);}});
        child.on('error',()=>finish(false));child.on('close',code=>{try{const result=JSON.parse(output);finish(code===0&&result.ready===true?{ready:true}:{ready:false,code:result.code});}catch{finish({ready:false});}});
        child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
      });
      if(!success?.ready)return {status:success?.code==='workspace_busy'?409:503,body:{ready:false,code:success?.code==='workspace_busy'?'workspace_busy':'workspace_start_failed'}};
      try {
        const adapter=JSON.parse(readFileSync(join(config.root,String(id),'adapter.private.json'),'utf8'));
        if(adapter.testUserId!==id||adapter.workspaceMode!==mode||adapter.engineUrl!==`http://127.0.0.1:${reservation.port}`)throw Error('Workspace identity mismatch');
        install(adapter);installed.set(id,adapter);
        reservation.mode=mode;persistReservations();
      }catch{return {status:503,body:{ready:false,code:'workspace_start_failed'}};}
      return {status:200,body:{ready:true}};
    };
    const id=request?.user_id;
    if(!Number.isSafeInteger(id)||id<1)return Promise.resolve({status:400,body:{ready:false,code:'invalid_workspace'}});
    if((config.retiredAccounts||[]).includes(id))return Promise.resolve({status:409,body:{ready:false,code:'workspace_plan_migration'}});
    const previous=installed.get(id);
    if(previous && previous.workspaceMode===request.mode)return Promise.resolve({status:200,body:{ready:true}});
    const job=jobs.get(id);
    if(job?.running)return Promise.resolve({status:202,body:{ready:false,code:'workspace_preparing'}});
    if(job?.result){jobs.delete(id);return Promise.resolve(job.result);}
    const state={running:true};jobs.set(id,state);
    const result=pending.then(execute);pending=result.catch(()=>{});
    result.then(value=>{state.running=false;state.result=value;if(value.body.ready)jobs.delete(id);migrating.delete(id);},()=>{state.running=false;state.result={status:503,body:{ready:false,code:'workspace_start_failed'}};migrating.delete(id);});
    return Promise.resolve({status:202,body:{ready:false,code:'workspace_preparing'}});
  };
  provision.isMigrating=id=>migrating.has(id);
  return provision;
}
