import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assess,allocation,hasSidecarListener} from './preflight.mjs';

const ready={platform:'win32',arch:'x64',nodeSupported:true,python:true,wsl2:true,docker:{OSType:'linux',Architecture:'x86_64',NCPU:4,MemTotal:8*1024**3},freeRAM:8*1024**3,imageBytes:1024**3,freeDisk:20*1024**3,workspaceBytes:1024**3,permissions:true,portFree:true,api:true,service:true};
test('readiness reports actual resource allocation and successful checks without requiring a GPU',()=>{
 const result=assess(ready);assert.equal(result.state,'Ready');assert.equal(result.checks.length,13);assert.equal(allocation,4.625*1024**3);assert(!result.checks.some(c=>c.name==='GPU'));
});
test('readiness distinguishes setup, resource, platform and outbound-network failures with next steps',()=>{
 for(const [changes,state,name] of [[{docker:undefined},'Needs setup','Docker'],[{freeRAM:allocation-1},'Insufficient resources','RAM'],[{platform:'linux'},'Unsupported','Platform'],[{service:false},'Needs setup','Connection service'],[{api:false},'Needs setup','Ghost Wire API'],[{freeDisk:0},'Insufficient resources','Disk'],[{nodeSupported:false},'Needs setup','Node'],[{portFree:false},'Needs setup','Local ports'],[{imageBytes:0},'Needs setup','Worker image']]){
  const result=assess({...ready,...changes});assert.equal(result.state,state);const check=result.checks.find(c=>c.name===name);assert.notEqual(check.state,'Ready');assert(check.next.length>0);
 }
});

test('port readiness rejects listeners but ignores closed TIME_WAIT connections',()=>{
 assert.equal(hasSidecarListener('  TCP  127.0.0.1:18877  0.0.0.0:0  LISTENING  125'),true);
 assert.equal(hasSidecarListener('  TCP  127.0.0.1:18877  127.0.0.1:50123  TIME_WAIT  0'),false);
 assert.equal(hasSidecarListener('  TCP  127.0.0.1:50123  127.0.0.1:18877  ESTABLISHED  125'),false);
});

test('Mac readiness supports native Intel and Apple silicon Linux engines without WSL',()=>{
 for(const [arch,engine] of [['x64','x86_64'],['arm64','aarch64'],['arm64','arm64']]){
  const report=assess({...ready,platform:'darwin',arch,wsl2:false,docker:{...ready.docker,Architecture:engine}});
  assert.equal(report.state,'Ready');assert(!report.checks.some(c=>c.name==='WSL2'));
 }
 assert.equal(assess({...ready,platform:'darwin',arch:'arm64'}).state,'Unsupported');
 assert.equal(assess({...ready,platform:'darwin',arch:'arm64',docker:undefined}).state,'Needs setup');
});
