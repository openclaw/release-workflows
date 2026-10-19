#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, mkdirSync, readdirSync, unlinkSync, symlinkSync } from 'node:fs';
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
    assert.equal(w.jobs.build['runs-on'],"${{ startsWith(inputs.test-runs-on, 'macos-') && 'xcode-27' || inputs.test-runs-on }}");
    assert.deepEqual(w.jobs.build.permissions,{contents:'read',actions:'read'});
    const validate=step(w,'validate','Validate inputs').run;
    const runnerEnv={...process.env,VERSION:'1.2.3',HOMEBREW_TAP:'openclaw/homebrew-tap',HOMEBREW_FORMULA:'',SOURCE_ARCHIVES:'true',GITHUB_OUTPUT:path.join(root,'runner-output')};
    for(const runner of ['ubuntu-latest','xcode-27','xcode-27-xlarge','macos-26','macos-15-intel']) run('bash',['-c',validate],{env:{...runnerEnv,TEST_RUNS_ON:runner}});
    for(const runner of ['self-hosted','untrusted-runner']) assert.throws(()=>run('bash',['-c',validate],{env:{...runnerEnv,TEST_RUNS_ON:runner}}),/Command failed/);
    assert.equal(call.inputs['tag-prefix'].default,'v');
    for(const prefix of ['v','']) {
      writeFileSync(runnerEnv.GITHUB_OUTPUT,'');
      run('bash',['-c',validate],{env:{...runnerEnv,TEST_RUNS_ON:'ubuntu-latest',TAG_PREFIX:prefix,GO_MODULES:'[]'}});
      assert.match(readFileSync(runnerEnv.GITHUB_OUTPUT,'utf8'),new RegExp(`^tag=${prefix}1\\.2\\.3$`,'m'));
    }
    for(const env of [{TAG_PREFIX:'release-'},{TAG_PREFIX:'',GO_MODULES:'["."]'}]) {
      assert.throws(()=>run('bash',['-c',validate],{env:{...runnerEnv,TEST_RUNS_ON:'ubuntu-latest',...env}}),/Command failed/);
    }
    assert.equal(call.inputs['release-name'].default,'');
    assert.match(step(w,'publish','Publish only attested GitHub release bytes').with.script,/name:releaseName/);
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

const source=workflows[0];
assert.equal((source.on??source.true).workflow_call.inputs['generated-asset'].default,'');
const rawDownload=step(source,'assemble','Download generated asset from this build');
assert.equal(rawDownload.if,"inputs.generated-asset != ''");
assert.equal(rawDownload.with['artifact-ids'],'${{ needs.build.outputs.artifact-id }}');
assert.equal(rawDownload.with['digest-mismatch'],'error');
assert.equal(rawDownload.with['github-token'],undefined);
const inputDownload=step(source,'build','Download generated input from this run');
assert.equal(inputDownload.if,"inputs.generated-input-artifact-id != ''");
assert.equal(inputDownload.with['artifact-ids'],'${{ inputs.generated-input-artifact-id }}');
assert.equal(inputDownload.with['digest-mismatch'],'error');
assert.deepEqual(Object.keys(inputDownload.with).sort(),['artifact-ids','digest-mismatch','path']);
assert.equal(step(source,'build','Prepare isolated generated input').if,inputDownload.if);
assert.equal((source.on??source.true).workflow_call.inputs['generated-input-artifact-id'].default,'');
const sourceEnv={...process.env,VERSION:'1.2.3',TAG_PREFIX:'v',TEST_RUNS_ON:'ubuntu-latest',HOMEBREW_TAP:'openclaw/homebrew-tap',HOMEBREW_FORMULA:'',GO_MODULES:'[]',TAG:'v1.2.3',RELEASE_VERSION:'1.2.3',GITHUB_REPOSITORY:'openclaw/fixture',TARGET_SHA:'a'.repeat(40),GENERATED_INPUT_ARTIFACT_ID:''};
const generatedName='fixture-envelope.tar.gz';
for(const name of ['../escape.tgz','.hidden.tgz','a/b.tgz','*.tgz','a.tgz\n','a.tgz ','SHA256SUMS','release-notes.md','PACKAGE-PLAN.JSON','tests-passed','Source-1.2.3.TAR.GZ','source-1.2.3.zip']) {
  assert.throws(()=>run('/bin/bash',['-c',step(source,'validate','Validate inputs').run],{env:{...sourceEnv,SOURCE_ARCHIVES:'false',GENERATED_ASSET:name,GITHUB_OUTPUT:path.join(root,'invalid-output')}}),/Command failed/,`reject unsafe generated filename ${JSON.stringify(name)}`);
}
for(const id of ['0','01','-1','1.0','1e3','1,2','1junk',' 1','1\n','9007199254740992'])assert.throws(()=>run('/bin/bash',['-c',step(source,'validate','Validate inputs').run],{env:{...sourceEnv,SOURCE_ARCHIVES:'false',GENERATED_ASSET:generatedName,GENERATED_INPUT_ARTIFACT_ID:id,GITHUB_OUTPUT:path.join(root,'invalid-output')}}),/Command failed/,`reject invalid artifact ID ${JSON.stringify(id)}`);
assert.throws(()=>run('/bin/bash',['-c',step(source,'validate','Validate inputs').run],{env:{...sourceEnv,SOURCE_ARCHIVES:'false',GENERATED_ASSET:'',GENERATED_INPUT_ARTIFACT_ID:'123',GITHUB_OUTPUT:path.join(root,'invalid-output')}}),/Command failed/,'input requires generated output');
const sourceFixture=(name=generatedName,archives=false)=>{
  const dir=mkdtempSync(path.join(root,'generated-'));
  const payload=path.join(dir,'payload');mkdirSync(payload);
  writeFileSync(path.join(payload,'RELEASE-NOTES.md'),'## 1.2.3 - 2026-10-19\n\n- Fixture.\n');
  if(archives)for(const suffix of ['tar.gz','zip'])writeFileSync(path.join(payload,`source-1.2.3.${suffix}`),`source ${suffix}\n`);
  const env={...sourceEnv,RUNNER_TEMP:dir,PAYLOAD:payload,GENERATED_ASSET:name,SOURCE_ARCHIVES:String(archives),GITHUB_OUTPUT:path.join(dir,'output')};
  run('/bin/bash',['-c',step(source,'validate','Validate inputs').run],{env});
  return {dir,payload,env};
};
const buildSource=(fixture,command='printf "generated fixture\\n" > "$RELEASE_ASSET_PATH"')=>run('/bin/bash',['-c',step(source,'build','Run caller tests without write credentials').run],{env:{...fixture.env,TEST_COMMAND:command}});
const acceptSource=fixture=>{
  cpSync(path.join(fixture.dir,'raw'),path.join(fixture.dir,'generated-raw'),{recursive:true});
  run('/bin/bash',['-c',step(source,'assemble','Accept only the requested generated asset').run],{env:fixture.env});
};
const freezeSource=fixture=>run('/bin/bash',['-c',step(source,'assemble','Freeze inventory and checksums').run],{env:fixture.env});
const verifySource=fixture=>{
  for(const job of ['verify','verify-arm'])run('/bin/bash',['-c',step(source,job,'Independently verify frozen bytes').run],{env:fixture.env});
};
for(const name of ['',generatedName])for(const archives of [false,true]) {
  const fixture=sourceFixture(name,archives);
  buildSource(fixture,`test -z "\${RELEASE_ASSET_INPUT_DIR+x}"; ${name?'printf "generated fixture\\n" > "$RELEASE_ASSET_PATH"':'test -z "${RELEASE_ASSET_PATH+x}"'}`);
  assert.equal(readFileSync(path.join(fixture.dir,'raw/tests-passed'),'utf8'),'verified\n');
  if(name)acceptSource(fixture);
  else assert.deepEqual(readdirSync(path.join(fixture.dir,'raw')),['tests-passed']);
  freezeSource(fixture);verifySource(fixture);
  const inv=JSON.parse(readFileSync(path.join(fixture.payload,'ASSET-INVENTORY.json')));
  assert.deepEqual(Object.keys(inv),['repository','commit','tag','assets']);
  assert.equal(inv.assets.length,1+(archives?2:0)+(name?1:0));
  assert.equal(inv.assets.some(asset=>asset.name==='tests-passed'),false);
}
{
  const fixture=sourceFixture();fixture.env.GENERATED_INPUT_ARTIFACT_ID='123';
  run('/bin/bash',['-c',step(source,'validate','Validate inputs').run],{env:fixture.env});
  run('/bin/bash',['-c',step(source,'build','Prepare isolated generated input').run],{env:fixture.env});
  writeFileSync(path.join(fixture.dir,'generated-input/original.txt'),'immutable producer bytes\n');
  buildSource(fixture,'cp "$RELEASE_ASSET_INPUT_DIR/original.txt" "$RELEASE_ASSET_PATH"');
  acceptSource(fixture);freezeSource(fixture);verifySource(fixture);
  assert.equal(readFileSync(path.join(fixture.payload,generatedName),'utf8'),'immutable producer bytes\n');
  const absent=sourceFixture();absent.env.GENERATED_INPUT_ARTIFACT_ID='123';
  assert.throws(()=>buildSource(absent),/Command failed/,'missing artifact input fails before caller command');
}
for(const [label,command] of [
  ['missing','true'],
  ['empty','touch "$RELEASE_ASSET_PATH"'],
  ['extra','touch "$RELEASE_ASSET_PATH" "$(dirname "$RELEASE_ASSET_PATH")/extra"'],
  ['hidden','printf x > "$RELEASE_ASSET_PATH"; touch "$(dirname "$RELEASE_ASSET_PATH")/.hidden"'],
  ['directory','mkdir "$RELEASE_ASSET_PATH"'],
  ['symlink','ln -s /dev/null "$RELEASE_ASSET_PATH"'],
  ['replaced parent','rmdir "$(dirname "$RELEASE_ASSET_PATH")"; mkdir "$RUNNER_TEMP/other"; ln -s "$RUNNER_TEMP/other" "$(dirname "$RELEASE_ASSET_PATH")"; printf x > "$RELEASE_ASSET_PATH"'],
  ['oversize','node -e \'const f=require("fs");f.closeSync(f.openSync(process.env.RELEASE_ASSET_PATH,"w"));f.truncateSync(process.env.RELEASE_ASSET_PATH,2**31)\''],
  ['command failure','printf x > "$RELEASE_ASSET_PATH"; exit 7'],
]) {
  assert.throws(()=>buildSource(sourceFixture(),command),/Command failed/,`reject ${label} generated output`);
}
for(const mutation of ['marker','marker symlink','missing','extra','hidden','symlink','case collision']) {
  const fixture=sourceFixture();buildSource(fixture);
  const raw=path.join(fixture.dir,'raw');
  if(mutation==='marker')writeFileSync(path.join(raw,'tests-passed'),'failed\n');
  if(mutation==='marker symlink'){unlinkSync(path.join(raw,'tests-passed'));symlinkSync('/dev/null',path.join(raw,'tests-passed'));}
  if(mutation==='missing')unlinkSync(path.join(raw,generatedName));
  if(mutation==='extra'||mutation==='hidden')writeFileSync(path.join(raw,mutation==='hidden'?'.hidden':'extra'),'unexpected');
  if(mutation==='symlink'){unlinkSync(path.join(raw,generatedName));symlinkSync('/dev/null',path.join(raw,generatedName));}
  if(mutation==='case collision')writeFileSync(path.join(fixture.payload,generatedName.toUpperCase()),'do not replace');
  assert.throws(()=>acceptSource(fixture),/Command failed/,`reject raw ${mutation}`);
}
for(const mutation of ['modified','missing','unrequested']) {
  const fixture=sourceFixture();buildSource(fixture);acceptSource(fixture);freezeSource(fixture);
  if(mutation==='modified')writeFileSync(path.join(fixture.payload,generatedName),'changed');
  if(mutation==='missing')unlinkSync(path.join(fixture.payload,generatedName));
  if(mutation==='unrequested')fixture.env.GENERATED_ASSET='another.tgz';
  for(const job of ['verify','verify-arm'])assert.throws(()=>run('/bin/bash',['-c',step(source,job,'Independently verify frozen bytes').run],{env:fixture.env}),/Command failed/,`${job} rejects ${mutation} generated asset`);
}
console.log('source generated assets: default parity, exact output/transport, adversarial paths and both verifiers passed');
console.log('source/npm: dry-run tag isolation, real monorepo packs, exact pins, workspace rejection and dated metadata passed');
} finally {rmSync(root,{recursive:true,force:true});}
