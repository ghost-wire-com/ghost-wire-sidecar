import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {accessSync,constants,statfsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';

export const resourceLimits={worker:4*1024**3,postgres:384*1024**2,broker:128*1024**2,access:128*1024**2};
export const allocation=Object.values(resourceLimits).reduce((a,b)=>a+b,0);
export const serviceOrigin=process.env.GHOSTWIRE_APP_ORIGIN||'https://app.ghost-wire.com';
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:15000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();

export function hasSidecarListener(output){return output.split('\n').some(line=>/^\s*TCP\s+\S+:18877\s+\S+\s+LISTENING\s+/.test(line));}

export function assess(snapshot){
  const checks=[];
  const add=(name,state,detail,next='')=>checks.push({name,state,detail,next});
  const mac=snapshot.platform==='darwin';
  add('Platform',(snapshot.platform==='win32'&&snapshot.arch==='x64'||mac&&['x64','arm64'].includes(snapshot.arch))?'Ready':'Unsupported',`${snapshot.platform}/${snapshot.arch}`,'Use Windows x64 or an Intel/Apple silicon Mac with Docker Desktop Linux containers.');
  add('Node',snapshot.nodeSupported?'Ready':'Needs setup','Node >=22.13 is required.','Install a supported Node release and rerun this check.');
  add('Python',snapshot.python?'Ready':'Needs setup','Python 3 is used for explicit setup.','Install Python 3 and make python available in PATH.');
  if(!mac)add('WSL2',snapshot.wsl2?'Ready':'Needs setup','Docker must run on WSL2 with virtualization enabled.','Enable virtualization and install/update WSL2 using Windows and Docker instructions. No settings are changed here.');
  const architectures=mac&&snapshot.arch==='arm64'?['aarch64','arm64']:['x86_64','amd64'];
  add('Docker',snapshot.docker?(snapshot.docker.OSType==='linux'&&architectures.includes(snapshot.docker.Architecture)?'Ready':'Unsupported'):'Needs setup',snapshot.docker?'Engine reachable.':'Docker is missing, stopped, or inaccessible.',mac?'Install and start Docker Desktop for your Mac processor, complete its approvals, then retry.':'Start Docker Desktop in Linux containers mode using WSL2.');
  add('CPU',snapshot.docker?.NCPU>=2?'Ready':'Needs setup','The worker configuration allows 2 CPU cores. No local AI or GPU is required.',mac?'Allow at least 2 logical CPUs in Docker Desktop.':'Allow at least 2 logical CPUs in Docker; virtualization capabilities are verified through the running WSL2 engine.');
  add('RAM',!snapshot.docker?'Needs setup':(Math.min(snapshot.freeRAM,snapshot.docker.MemTotal)>=allocation?'Ready':'Insufficient resources'),`Container memory limits total ${allocation} bytes (4.625 GiB). This is an allocation check, not a performance guarantee.`,'Free RAM or increase Docker memory, then rerun. Host OS memory is additional.');
  add('Worker image',snapshot.imageBytes>0?'Ready':'Needs setup','Installation builds the supplied worker image; build tools and layers require additional unmeasured disk space.','Run Setup when dependencies are ready, then rerun. Readiness cannot certify build-time disk requirements.');
  add('Disk',snapshot.freeDisk>=snapshot.workspaceBytes+(snapshot.imageBytes||0)?'Ready':'Insufficient resources',`Free disk: ${snapshot.freeDisk} bytes; selected workspace reserve: ${snapshot.workspaceBytes}; installed worker image: ${snapshot.imageBytes||'not measured'}. Docker image-store free space is not independently observable here.`,'Free disk space on both the workspace drive and Docker data drive. Build/install may need additional space.');
  add('Workspace permissions',snapshot.permissions?'Ready':'Needs setup','Read/write permission check for the selected folder; nothing is written.','Select an existing writable workspace folder.');
  add('Local ports',snapshot.portFree?'Ready':'Needs setup','Only loopback port 18877 is used. No public inbound port is needed.','Close the application occupying loopback port 18877 or keep the existing Sidecar stopped during setup.');
  add('Ghost Wire API',snapshot.api?'Ready':'Needs setup','Read-only HTTPS health request; no inference.','Check Internet, firewall, proxy and certificate settings.');
  add('Connection service',snapshot.service?'Ready':'Needs setup','Read-only HTTPS health request. WSS is verified only when connecting.','Allow outbound HTTPS/WSS to '+new URL(serviceOrigin).host+'.');
  const state=['Unsupported','Insufficient resources','Needs setup'].find(s=>checks.some(c=>c.state===s))||'Ready';
  return {state,checks,privacy:'Hardware details remain on this PC. No paid model requests, tasks, installs or OS/security changes were made.',limits:'Ready covers these checks only. Installation disk needs, Docker network address-pool capacity and actual task performance are not certified.'};
}

export async function checkPC(folder=process.cwd(),workspaceBytes=1024**3){
  folder=resolve(folder);const snapshot={platform:os.platform(),arch:os.arch(),nodeSupported:Number(process.versions.node.split('.')[0])>22||(Number(process.versions.node.split('.')[0])===22&&Number(process.versions.node.split('.')[1])>=13),freeRAM:os.freemem(),workspaceBytes};
  try{snapshot.python=/Python 3\./.test(run(process.env.GHOSTWIRE_PYTHON||(snapshot.platform==='darwin'?'python3':'python'),['--version']));}catch{}
  try{snapshot.wsl2=/Default Version:\s*2|Standardversion:\s*2/.test(run('wsl.exe',['--status']).replaceAll('\0',''));}catch{}
  try{snapshot.docker=JSON.parse(run('docker',['info','--format','{{json .}}']));if(snapshot.docker.OperatingSystem?.includes('Docker Desktop')&&snapshot.docker.KernelVersion?.includes('WSL2'))snapshot.wsl2=true;}catch{}
  try{snapshot.imageBytes=Number(run('docker',['image','inspect','ghostwire-sidecar:20261106-secretless','--format','{{.Size}}']));}catch{}
  try{const disk=statfsSync(folder);snapshot.freeDisk=disk.bavail*disk.bsize;accessSync(folder,constants.R_OK|constants.W_OK);snapshot.permissions=true;}catch{snapshot.freeDisk=0;}
  if(snapshot.platform==='darwin')snapshot.portFree=await new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(18877,'127.0.0.1',()=>server.close(()=>resolve(true)));});
  else try{snapshot.portFree=!hasSidecarListener(run('netstat',['-ano','-p','tcp']));}catch{snapshot.portFree=false;}
  for(const [name,path] of [['api','/api/status'],['service','/api/sidecar/health']]){try{const r=await fetch(serviceOrigin+path,{redirect:'error',signal:AbortSignal.timeout(10000)});snapshot[name]=r.ok;if(name==='service'&&r.ok)snapshot[name]=(await r.json()).protocol===1;}catch{snapshot[name]=false;}}
  return assess(snapshot);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const report=await checkPC(process.argv[2]);console.log(JSON.stringify(report,null,2));process.exitCode=report.state==='Ready'?0:2;}
