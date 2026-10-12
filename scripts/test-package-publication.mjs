#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';
const require=createRequire(import.meta.url);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const w=loadWorkflow('release-npm-package.yml');
const raw=workflowStep(w,'publish-npm','name','Publish exact tarballs with trusted publishing').run;
const code=raw.split("(async () => {\n")[1].split('\n})().catch')[0];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'npm-publication-'));
try {
const bytes=Buffer.from('exact tarball bytes');
const p={name:'@fixture/core',version:'1.2.3',file:'fixture-core-1.2.3.tgz'};
fs.writeFileSync(path.join(root,p.file),bytes);
fs.writeFileSync(path.join(root,'PACKAGE-PLAN.json'),JSON.stringify([p]));
const meta={name:p.name,version:p.version,dist:{integrity:'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64'),tarball:'https://registry.npmjs.org/@fixture/core/-/core-1.2.3.tgz'}};
async function scenario({delay=0,exists=false,wrong=false,publishResult=0,wrongCommit=false}={}) {
  let calls=0,publishes=0,now=0;
  const summary=path.join(root,'summary-'+Math.random());
  const fakeRequire=name=>name==='node:child_process'?{spawnSync(command,args){assert.equal(command,'npm');assert.ok(args.includes('--provenance'));assert.ok(args.includes('--ignore-scripts'));assert.ok(args.includes('latest'));publishes++;return{status:publishResult};}}:require(name);
  const fetch=async url=>{
    const s=String(url);
    if(s===meta.dist.tarball)return{ok:true,arrayBuffer:async()=>wrong?Buffer.from('wrong'):bytes};
    if(s.endsWith('/1.2.3')){calls++;return calls>delay||exists?{ok:true,json:async()=>meta}:{status:404};}
    return{ok:true,json:async()=>({name:p.name})};
  };
  await new AsyncFunction('require','fetch','process','Date','setTimeout','console',code)(fakeRequire,fetch,{env:{PAYLOAD:root,GITHUB_STEP_SUMMARY:summary,GITHUB_SHA:wrongCommit?'b':'a',TARGET_SHA:'a'}},{now:()=>now},fn=>{now+=10000;fn();},{log(){}});
  return{publishes,summary,now};
}
assert.equal((await scenario({exists:true,wrongCommit:true})).publishes,0,'resume does not republish');
assert.equal((await scenario({delay:9})).publishes,1);
await assert.rejects(()=>scenario({exists:true,wrong:true}),/tarball differs/);
assert.equal((await scenario({delay:2,publishResult:1})).publishes,1,'ambiguous CLI error resumes exact public payload');
await assert.rejects(()=>scenario({delay:1000}),/deadline exceeded/);
await assert.rejects(()=>scenario({delay:2,wrongCommit:true}),/frozen commit/);
const slow=await scenario({delay:9});assert.match(fs.readFileSync(slow.summary,'utf8'),/exceeded one minute/);
const provenance=workflowStep(w,'provenance','name','Verify npm signatures and provenance independently').run;
const pc=provenance.split("(async () => {\n")[1].split('\n})().catch')[0];
async function proof(commit){
  let audits=0;
  const sha='a'.repeat(40);
  const statement={predicateType:'https://slsa.dev/provenance/v1',subject:[{digest:{sha512:crypto.createHash('sha512').update(bytes).digest('hex')}}],predicate:{buildDefinition:{externalParameters:{workflow:{repository:'https://github.com/openclaw/fixture',path:'.github/workflows/release.yml'}},resolvedDependencies:[{digest:{gitCommit:commit}}]}}};
  const metadata={...meta,dist:{...meta.dist,attestations:{url:'https://registry.npmjs.org/-/npm/v1/attestations/fixture'}}};
  const attestations={attestations:[{predicateType:statement.predicateType,bundle:{dsseEnvelope:{payload:Buffer.from(JSON.stringify(statement)).toString('base64')}}}]};
  const fetch=async url=>({ok:true,json:async()=>String(url).includes('attestations')?attestations:metadata});
  const fakeRequire=name=>name==='node:child_process'?{execFileSync(cmd,args){if(args[0]==='audit')audits++;}}:require(name);
  await new AsyncFunction('require','fetch','process','setTimeout',pc)(fakeRequire,fetch,{env:{PAYLOAD:root,RUNNER_TEMP:root,CALLER_WORKFLOW:'openclaw/fixture/.github/workflows/release.yml@refs/heads/main',GITHUB_REPOSITORY:'openclaw/fixture',TARGET_SHA:sha}},fn=>fn());
  return audits;
}
assert.equal(await proof('a'.repeat(40)),1);
await assert.rejects(()=>proof('b'.repeat(40)),/provenance does not bind/);
console.log('npm publication: exact-byte resume, tampering, delayed visibility, ten-minute deadline, ambiguous publish recovery and provenance identity passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
