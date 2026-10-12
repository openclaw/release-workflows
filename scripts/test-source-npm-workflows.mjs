#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';
const workflows=['release-source.yml','release-npm-package.yml'].map(loadWorkflow);
const step=(w,j,n)=>workflowStep(w,j,'name',n);
const asyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=(command,args,options)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options});
const artifactNames=[];
const root=mkdtempSync(path.join(tmpdir(),'source-npm-proof-'));
try {
for(const w of workflows){
  const call=(w.on??w.true).workflow_call;
  if(w.name==='Release source') {
    assert.equal(call.inputs['test-runs-on'].default,'ubuntu-latest');
    assert.equal(w.jobs.build['runs-on'],'${{ inputs.test-runs-on }}');
    assert.deepEqual(w.jobs.build.permissions,{contents:'read',actions:'read'});
    const validate=step(w,'validate','Validate inputs').run;
    const runnerEnv={...process.env,VERSION:'1.2.3',HOMEBREW_TAP:'openclaw/homebrew-tap',HOMEBREW_FORMULA:'',SOURCE_ARCHIVES:'true',GITHUB_OUTPUT:path.join(root,'runner-output')};
    for(const runner of ['ubuntu-latest','macos-26','macos-15-intel']) run('bash',['-c',validate],{env:{...runnerEnv,TEST_RUNS_ON:runner}});
    for(const runner of ['self-hosted','untrusted-runner']) assert.throws(()=>run('bash',['-c',validate],{env:{...runnerEnv,TEST_RUNS_ON:runner}}),/Command failed/);
  }
  assert.equal(call.inputs.dry_run.default,true);
  assert.deepEqual(w.permissions,{});
  assert.equal(w.jobs.verify.permissions.actions,'read');
  assert.deepEqual(Object.keys(w.jobs.verify.permissions),['actions']);
  assert.equal(w.jobs.verify['runs-on'],'ubuntu-latest');
  assert.equal(w.jobs['verify-arm']['runs-on'],'ubuntu-24.04-arm');
  for(const job of Object.values(w.jobs))for(const step of job.steps??[])if(step.uses?.startsWith('actions/download-artifact@')){assert.ok(step.with['artifact-ids']);assert.equal(step.with.name,undefined);}
  assert.equal(w.jobs.publish.permissions.contents,'write');
  assert.match(w.jobs.publish.if,/!inputs.dry_run/);
  assert.ok(!JSON.stringify(w.jobs.publish).includes('actions/checkout'));
  assert.match(step(w,'publish','Publish only attested GitHub release bytes').with.script,/await compare\(release\)/);
  const resolver=workflowStep(w,'validate','id','repository').with.script;
  const resolve=new asyncFunction('github','context','core','process',resolver);
  {
    const outputs=new Map();
    let tagReads=0;
    const head='b'.repeat(40);
    const github={rest:{repos:{
      get:async()=>({data:{default_branch:'main'}}),
      getBranch:async()=>({data:{protected:true,commit:{sha:head}}}),
    },git:{getRef:async()=>{tagReads++; throw new Error('must not read an old tag');}}}};
    const context={repo:{owner:'openclaw',repo:'fixture'},ref:'refs/heads/main',sha:head};
    const core={info(){},setOutput(k,v){outputs.set(k,v);},setFailed(m){throw new Error(m);}};
    await resolve(github,context,core,{env:{TAG:'v1.2.3',DRY_RUN:'true'}});
    assert.equal(outputs.get('target-sha'),head);
    assert.equal(outputs.get('tag-object-sha'),'');
    assert.equal(tagReads,0,'main dry run ignores previously released tags');
    const checkout=workflowStep(w,'validate','name','Check out exact release target');
    assert.match(checkout.with.ref,/!\(inputs.dry_run && github.event_name == 'workflow_dispatch'\)/);
    assert.match(step(w,'validate','Verify required SSH-signed tag').if,/!\(inputs.dry_run && github.event_name == 'workflow_dispatch'\)/);
    context.sha='d'.repeat(40);
    await assert.rejects(resolve(github,context,core,{env:{TAG:'v1.2.3',DRY_RUN:'true'}}),/caller must run at protected/);
    context.sha=head;
    github.rest.repos.getBranch=async()=>({data:{protected:false,commit:{sha:head}}});
    await assert.rejects(resolve(github,context,core,{env:{TAG:'v1.2.3',DRY_RUN:'true'}}),/not protected/);
    // Tag events retain the immutable-tag validation path, including failures.
    github.rest.repos.getBranch=async()=>({data:{protected:true,commit:{sha:head}}});
    context.ref='refs/tags/v1.2.3';
    await assert.rejects(resolve(github,context,core,{env:{TAG:'v1.2.3',DRY_RUN:'true'}}),/must not read an old tag/);
  }
  const freeze=step(w,'tag','Create immutable annotated tag').with.script;
  let writes=0;
  const core={setOutput(){},info(){},setFailed(m){throw new Error(m)}};
  const github={rest:{git:{getRef:async()=>{throw Object.assign(new Error('missing'),{status:404})},createTag:async()=>{writes++;return{data:{sha:'c'.repeat(40)}}},createRef:async()=>{writes++}}}};
  const context={repo:{owner:'openclaw',repo:'fixture'}};
  const execute=new asyncFunction('github','context','core','process',freeze);
  await execute(github,context,core,{env:{EXPECTED_TAG_OBJECT:'',DRY_RUN:'true',TAG:'v1.2.3',TARGET_SHA:'a'.repeat(40)}});
  assert.equal(writes,0,'dry run must not create a tag');
  await execute({...github,rest:{git:{getRef:async()=>{throw new Error('dry run must not inspect tags');}}}},context,core,{env:{EXPECTED_TAG_OBJECT:'',DRY_RUN:'true',TAG:'v1.2.3',TARGET_SHA:'b'.repeat(40)}});
  await execute(github,context,core,{env:{EXPECTED_TAG_OBJECT:'',DRY_RUN:'false',TAG:'v1.2.3',TARGET_SHA:'a'.repeat(40)}});
  assert.equal(writes,2);
  const metadata=workflowStep(w,'validate','id','metadata').run;
  const work=path.join(root,w.name.replaceAll(' ','-'));mkdirSync(work);
  cpSync(new URL('./fixtures/npm-monorepo/',import.meta.url),work,{recursive:true});
  for(const name of ['core','cli']){const p=path.join(work,'packages',name,'package.json');const m=JSON.parse(readFileSync(p));m.version='1.2.3';if(m.dependencies)m.dependencies['@release-fixture/core']='1.2.3';writeFileSync(p,JSON.stringify(m));}
  writeFileSync(path.join(work,'CHANGELOG.md'),'# Changelog\n\n## 1.2.3 - 2026-10-11\n\n- Fixture.\n');
  const temp=path.join(work,'tmp');mkdirSync(temp);
  const env={...process.env,RELEASE_VERSION:'1.2.3',PACKAGE_DIRS:'["packages/core","packages/cli"]',RUNNER_TEMP:temp,GITHUB_OUTPUT:path.join(temp,'output'),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1'};
  run('bash',['-c',metadata],{cwd:work,env});
  assert.match(readFileSync(path.join(temp,'RELEASE-NOTES.md'),'utf8'),/Fixture/);
  artifactNames.push(readFileSync(path.join(temp,'output'),'utf8').trim());
  artifactNames.push(workflowStep(w,'build','id','artifact').run);
  artifactNames.push(workflowStep(w,'assemble','id','artifact').run);
  if(w.name==='Release npm package'){
    const payload=path.join(work,'payload');mkdirSync(payload);
    cpSync(path.join(temp,'PACKAGE-PLAN.json'),path.join(payload,'PACKAGE-PLAN.json'));
    const pack=p=>run('npm',['pack','--json','--pack-destination',payload],{cwd:path.join(work,'packages',p)});
    const coreDir=path.join(work,'packages/core');
    const coreManifest=JSON.parse(readFileSync(path.join(coreDir,'package.json')));
    coreManifest.scripts={prepack:'node lifecycle.cjs prepack',prepare:'node lifecycle.cjs prepare',postpack:'node lifecycle.cjs postpack'};
    coreManifest.files.push('prepared.txt');
    writeFileSync(path.join(coreDir,'package.json'),JSON.stringify(coreManifest));
    writeFileSync(path.join(coreDir,'lifecycle.cjs'),"const fs=require('node:fs'); const hook=process.argv[2]; console.log(hook+' lifecycle output'); if(process.env.FAIL_PACK_HOOK===hook) process.exit(7); if(hook==='prepare') fs.writeFileSync('prepared.txt','prepared by lifecycle');\n");
    mkdirSync(path.join(temp,'raw'));mkdirSync(path.join(temp,'validated'));
    cpSync(path.join(temp,'PACKAGE-PLAN.json'),path.join(temp,'validated/PACKAGE-PLAN.json'));
    const packing=step(w,'build','Install, build and pack in dependency order').run.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    const packingOutput=run('python3',['-c',packing],{cwd:work,env});
    for(const hook of ['prepack','prepare','postpack']) assert.match(packingOutput,new RegExp(hook+' lifecycle output'));
    for(const p of JSON.parse(readFileSync(path.join(temp,'PACKAGE-PLAN.json')))) cpSync(path.join(temp,'raw',p.file),path.join(payload,p.file));
    assert.equal(run('tar',['-xOf',path.join(payload,'release-fixture-core-1.2.3.tgz'),'package/prepared.txt']),'prepared by lifecycle');
    assert.throws(()=>run('python3',['-c',packing],{cwd:work,env:{...env,FAIL_PACK_HOOK:'prepare'}}),/Command failed/,'lifecycle failure must abort packing');
    const verify=step(w,'verify','Independently verify frozen bytes').run.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    run('python3',['-c',verify],{env:{...env,PAYLOAD:payload}});
    const bad=JSON.parse(readFileSync(path.join(work,'packages/cli/package.json')));
    bad.dependencies['@release-fixture/core']='^1.2.3';
    writeFileSync(path.join(work,'packages/cli/package.json'),JSON.stringify(bad));
    assert.throws(()=>run('bash',['-c',metadata],{cwd:work,env}),/Command failed/,'reject loose source dependency');
    pack('cli');
    assert.throws(()=>run('python3',['-c',verify],{env:{...env,PAYLOAD:payload}}),/Command failed/,'independently reject loose packed dependency');
    bad.dependencies['@release-fixture/core']='1.2.3';
    bad.publishConfig={'https-proxy':'http://evil.invalid','strict-ssl':false};
    writeFileSync(path.join(work,'packages/cli/package.json'),JSON.stringify(bad));pack('cli');
    assert.throws(()=>run('python3',['-c',verify],{env:{...env,PAYLOAD:payload}}),/Command failed/,'reject publishConfig credential exfiltration');
    delete bad.publishConfig;
    bad.dependencies['@release-fixture/core']='workspace:*';
    writeFileSync(path.join(work,'packages/cli/package.json'),JSON.stringify(bad));pack('cli');
    assert.throws(()=>run('python3',['-c',verify],{env:{...env,PAYLOAD:payload}}),/Command failed/,'reject workspace leak');
    assert.throws(()=>run('bash',['-c',metadata],{cwd:work,env:{...env,PACKAGE_DIRS:'["packages/cli","packages/core"]'}}),/Command failed/);
  }
  writeFileSync(path.join(work,'CHANGELOG.md'),'## 1.2.3 - 2026-99-99\n\n- Invalid date.\n');
  assert.throws(()=>run('bash',['-c',metadata],{cwd:work,env}),/Command failed/);
}
assert.equal(new Set(artifactNames).size,artifactNames.length,'archetypes cannot collide within one caller run');
const npm=workflows[1];
assert.equal(npm.jobs['publish-npm'].permissions['id-token'],'write');
assert.equal(npm.jobs.provenance.permissions.actions,'read');
assert.ok(!JSON.stringify(npm.jobs['publish-npm']).includes('secrets.'));
assert.match(step(npm,'publish-npm','Publish exact tarballs with trusted publishing').run,/10\*60\*1000/);
assert.match(step(npm,'provenance','Verify npm signatures and provenance independently').run,/'audit','signatures'/);
assert.match(step(npm,'provenance','Verify npm signatures and provenance independently').run,/gitCommit===process.env.TARGET_SHA/);
console.log('source/npm: dry-run tag isolation, real monorepo packs, exact pins, workspace rejection and dated metadata passed');
} finally {rmSync(root,{recursive:true,force:true});}
