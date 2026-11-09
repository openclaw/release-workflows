#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const require = createRequire(import.meta.url);
const workflow = loadWorkflow('release-source.yml');
const inputs = workflow.on.workflow_call.inputs;
const publisher = workflowStep(workflow, 'publish', 'id', 'release');
const validate = workflowStep(workflow, 'validate', 'id', 'inputs');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('github', 'context', 'core', 'process', 'require', publisher.with.script);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-signer-test-'));
const repository = {owner: 'example', repo: 'fixture'};
const tagName = 'v1.2.3';
const head = 'a'.repeat(40), rootTree = 'b'.repeat(40), githubTree = 'c'.repeat(40);
const hash = (type, bytes) => createHash('sha1').update(type+' '+bytes.length+'\0').update(bytes).digest('hex');
const env = {PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z'};
const git = (args, input) => execFileSync('git', args, {cwd: root, env, input, encoding: 'utf8', stdio: ['pipe','pipe','pipe']}).trim();
let cases = 0;
try {
  git(['init', '--bare', '--template=', '.']);
  const emptyTree = git(['hash-object', '-t', 'tree', '-w', '--stdin'], '');
  const target = git(['commit-tree', emptyTree], 'Fixture commit\n');
  const keys = ['approved', 'other'].map(name => {
    const file = path.join(root, name);
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', file], {stdio: 'pipe'});
    return {file, public: fs.readFileSync(file+'.pub', 'utf8').trim()};
  });
  git(['-c', 'gpg.format=ssh', '-c', 'user.signingkey='+keys[0].file, 'tag', '-s', tagName, target, '-m', 'Fixture release']);
  const tagSha = git(['rev-parse', tagName]);
  const rawTag = execFileSync('git', ['cat-file', 'tag', tagSha], {cwd: root, env, encoding: 'utf8'});
  const signatureOffset = rawTag.indexOf('-----BEGIN SSH SIGNATURE-----');
  const tagData = {sha: tagSha, object: {type:'commit', sha:target}, verification: {verified:false, payload:rawTag.slice(0,signatureOffset), signature:rawTag.slice(signatureOffset)}};
  const approved = Buffer.from('fixture@example.test '+keys[0].public+'\n');
  const removed = Buffer.from('fixture@example.test '+keys[1].public+'\n');
  const payload = path.join(root, 'payload');fs.mkdirSync(payload);
  for (const [name, text] of [['RELEASE-NOTES.md', 'Fixture notes\n'], ['ASSET-INVENTORY.json', '{}\n'], ['SHA256SUMS', 'Fixture checksums\n']]) fs.writeFileSync(path.join(payload, name), text);
  const names = fs.readdirSync(payload).sort();
  const expectedWrites = ['create', ...names.map(name => 'upload:'+name), 'publish'];
  const run = async (scenario = {}) => {
    const calls = [], writes = [], tempPaths = [];
    const expectedTag = scenario.tagData?.sha ?? tagSha;
    const outputs = new Map();
    let checks = 0, repoReads = 0, branchReads = 0, currentPolicy = scenario.policy ?? approved;
    let release = scenario.release ? {id:7, tag_name:tagName, body:'Fixture notes\n', draft:scenario.release !== 'public', html_url:'https://example.test/release'} : undefined;
    let assets = (scenario.assets ?? (scenario.release === 'public' ? names : [])).map((name, id) => ({id, name, bytes:fs.readFileSync(path.join(payload, name))}));
    if (scenario.badAsset) assets[0].bytes = Buffer.from('changed');
    if (scenario.badNotes) release.body = 'changed';
    const write = name => {
      calls.push(name);writes.push(name);
      if (scenario.revokeAfter === writes.length) currentPolicy = removed;
      if (scenario.writeError === name) throw Object.assign(new Error('write failed'), {status:503});
    };
    const fault = name => { if (scenario.apiError === name) throw Object.assign(new Error('policy API forbidden: '+name), {status:403}); };
    const github = {rest:{
      git:{
        getRef: async () => ({data:{object:{type:scenario.refType ?? 'tag', sha:scenario.refDrift && checks >= (scenario.refDriftAtCheck ?? 1) ? 'f'.repeat(40) : scenario.refSha ?? expectedTag}}}),
        getTag: async () => ({data:scenario.tagData ?? {...tagData, object:{type:scenario.targetType ?? 'commit', sha:scenario.target ?? target}}}),
        getCommit: async request => {
          fault('commit');calls.push('commit');assert.equal(request.commit_sha, head);
          return {data:{sha:head, tree:{sha:rootTree}}};
        },
        getTree: async request => {
          fault('tree');calls.push('tree');assert.equal(request.recursive, undefined, 'policy trees must be non-recursive');
          const outer = request.tree_sha === rootTree;
          assert.ok(outer || request.tree_sha === githubTree);
          const item = outer ? {path:'.github', mode:scenario.directoryMode ?? '040000', type:scenario.directoryType ?? 'tree', sha:githubTree} : {path:'release-allowed-signers', mode:scenario.policyMode ?? '100644', type:scenario.policyType ?? 'blob', sha:hash('blob', currentPolicy), size:scenario.policySize ?? currentPolicy.length};
          return {data:{sha:request.tree_sha, truncated:scenario.truncated === (outer ? 'root' : 'child'), tree:scenario.missing === (outer ? 'directory' : 'policy') ? [] : [item]}};
        },
        getBlob: async request => {
          fault('blob');calls.push('blob');assert.equal(request.file_sha, hash('blob', currentPolicy));
          return {data:{sha:request.file_sha, encoding:scenario.encoding ?? 'base64', size:currentPolicy.length, content:(scenario.blobBytes ?? currentPolicy).toString('base64')}};
        },
      },
      repos:{
        get: async () => {fault('repository');calls.push('repository');repoReads++;return {data:{default_branch:scenario.defaultDrift && repoReads % 2 === 0 ? 'renamed' : 'main'}};},
        getBranch: async request => {
          fault('branch');calls.push('branch');branchReads++;assert.equal(request.branch,'main');
          return {data:{protected:!(scenario.unprotected || (scenario.protectionDrift && branchReads % 2 === 0)), commit:{sha:scenario.headDrift && branchReads % 2 === 0 ? 'd'.repeat(40) : head}}};
        },
        getReleaseByTag: async () => {if(!release || release.draft)throw Object.assign(new Error('no published release'),{status:404});return {data:release};},
        listReleases: async () => ({status:200,headers:{},data:release ? [release] : []}),
        createRelease: async request => {write('create');assert.equal(request.draft,true);assert.equal(request.target_commitish,target);release={id:7,tag_name:request.tag_name,body:request.body,draft:true};return {data:release};},
        uploadReleaseAsset: async request => {write('upload:'+request.name);assets.push({id:assets.length,name:request.name,bytes:request.data});return {data:{}};},
        updateRelease: async request => {write('publish');assert.equal(request.draft,false);release={...release,draft:false,html_url:'https://example.test/release'};return {data:release};},
        listReleaseAssets: async request => {assert.equal(request.release_id,release.id);return {status:200,headers:{},data:assets};},
        getRelease: async request => {assert.equal(request.release_id,release.id);return {data:release};},
      },
    },request:async (_route, request) => ({data:assets.find(asset => asset.id === request.asset_id).bytes})};
    const testRequire = name => {
      if (name === 'node:fs') return {...fs, mkdtempSync(prefix){const dir=fs.mkdtempSync(prefix);tempPaths.push(dir);return dir;}};
      if (name === 'node:child_process') return {execFileSync(command,args,options){
        assert.equal(command,'git');
        assert.deepEqual(Object.keys(options.env).sort(), ['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','HOME','PATH']);
        if(args.includes('verify-tag')){checks++;calls.push('verify');}
        return execFileSync(command,args,options);
      }};
      return require(name);
    };
    let error;
    try {
      await execute(github, {repo:repository}, {info(){},setOutput(name,value){outputs.set(name,value);}}, {env:{PATH:process.env.PATH, TAG:tagName, TARGET_SHA:target, EXPECTED_TAG_OBJECT:expectedTag, PAYLOAD:payload, REQUIRE_CURRENT_SIGNER:scenario.enabled ?? 'true'}}, testRequire);
    } catch (caught) {error=caught;}
    assert.ok(tempPaths.every(dir => !fs.existsSync(dir)), 'verification scratch must be cleaned on success and failure');
    for (let i=0;i<calls.length;i++) if(writes.includes(calls[i]) && scenario.enabled !== 'false') assert.equal(calls[i-1], 'branch', 'each mutation must immediately follow the fresh policy head recheck');
    return {error,writes,calls,checks,repoReads,outputs};
  };
  const test = async (name, scenario, writes, error) => {
    const result=await run(scenario);
    assert.deepEqual(result.writes,writes,name);
    if(error)assert.match(result.error?.message ?? '',error,name);else assert.equal(result.error,undefined,name);
    if(!error)assert.equal(result.outputs.get('release-url'),'https://example.test/release');
    cases++;console.log('PASS '+name);return result;
  };
  const success=await test('current and frozen signer publishes with real SSH verification',{},expectedWrites);
  assert.equal(success.checks,expectedWrites.length);assert.equal(success.repoReads,expectedWrites.length*2);
  await test('executable regular policy accepted',{policyMode:'100755'},expectedWrites);
  await test('SSH validity uses tag time, not current wall clock',{policy:Buffer.from('fixture@example.test valid-before="20250101Z" '+keys[0].public+'\n')},expectedWrites);
  await test('unapproved signer blocks before draft',{policy:removed},[],/Command failed/);
  await test('removed signer blocks existing draft retry',{policy:removed,release:'draft'},[],/Command failed/);
  await test('removed signer blocks partially uploaded draft retry',{policy:removed,release:'draft',assets:names.slice(0,2)},[],/Command failed/);
  for(let index=1;index<expectedWrites.length;index++)await test('revocation after write '+index+' blocks the next write',{revokeAfter:index},expectedWrites.slice(0,index),/Command failed/);
  await test('tag replacement during final signer verification blocks un-draft',{refDrift:true,refDriftAtCheck:expectedWrites.length},expectedWrites.slice(0,-1),/frozen tag object changed before release write/);
  const retry=await test('publisher-only retry rechecks before each remaining write',{release:'draft',assets:names.slice(0,2)},['upload:'+names[2],'publish']);
  assert.equal(retry.checks,2);
  const publicReplay=await test('public exact-byte replay succeeds after signer removal',{release:'public',policy:removed},[]);
  assert.equal(publicReplay.repoReads,0);assert.equal(publicReplay.checks,0);
  await test('public byte mismatch fails without authorization or writes',{release:'public',policy:removed,badAsset:true},[],/release bytes differ/);
  await test('public notes mismatch fails without writes',{release:'public',policy:removed,badNotes:true},[],/Expected values/);
  for(const [name,scenario,error] of [
    ['missing policy',{missing:'policy'},/missing or ambiguous/],
    ['missing directory',{missing:'directory'},/missing or ambiguous/],
    ['empty policy',{policy:Buffer.alloc(0)},/nonempty/],
    ['whitespace policy',{policy:Buffer.from(' \n')},/policy is empty/],
    ['oversized policy',{policySize:65537},/at most 64 KiB/],
    ['policy symlink',{policyMode:'120000'},/regular file/],
    ['policy submodule',{policyMode:'160000',policyType:'commit'},/Expected values/],
    ['directory symlink',{directoryMode:'120000',directoryType:'blob'},/Expected values/],
    ['wrong policy mode',{policyMode:'040000'},/regular file/],
    ['truncated root',{truncated:'root'},/truncated/],
    ['truncated child',{truncated:'child'},/truncated/],
    ['wrong policy hash',{blobBytes:Buffer.alloc(approved.length,65)},/blob hash differs/],
    ['wrong blob encoding',{encoding:'utf-8'},/Expected values/],
    ['unprotected branch',{unprotected:true},/must be protected/],
    ['default branch drift',{defaultDrift:true},/default branch changed/],
    ['protection drift',{protectionDrift:true},/lost protection/],
    ['head drift',{headDrift:true},/head changed/],
    ['changed tag object',{refSha:'f'.repeat(40)},/frozen tag object/],
    ['tag replacement during policy verification',{refDrift:true},/frozen tag object changed before release write/],
    ['lightweight tag',{refType:'commit'},/frozen tag object/],
    ['changed tag target',{target:'e'.repeat(40)},/frozen tag target/],
    ['indirect tag target',{targetType:'tag'},/frozen tag target/],
    ['missing signature payload',{tagData:{...tagData,verification:{}}},/payload/],
    ['wrong signature format',{tagData:{...tagData,verification:{...tagData.verification,signature:'not SSH'}}},/SSH signature/],
    ['wrong reconstructed tag hash',{tagData:{...tagData,verification:{...tagData.verification,payload:tagData.verification.payload+'changed'}}},/signed tag bytes differ/],
  ])await test(name,scenario,[],error);
  for(const apiError of ['repository','branch','commit','tree','blob'])await test('policy API 403: '+apiError,{apiError},[],/policy API forbidden/);
  const tamperedPayload=tagData.verification.payload.replace('Fixture release','Changed release');
  await test('cryptographic signature failure rejects GitHub verified badge',{tagData:{...tagData,sha:hash('tag',Buffer.from(tamperedPayload+tagData.verification.signature)),verification:{verified:true,payload:tamperedPayload,signature:tagData.verification.signature}}},[],/Command failed/);
  const optout=await test('opt-out retains legacy publisher behavior',{enabled:'false',policy:removed},expectedWrites);
  assert.equal(optout.repoReads,0);assert.equal(optout.checks,0);
  await test('failed write is not retried',{writeError:'create'},['create'],/write failed/);
  assert.equal(inputs['require-current-signer'].default,false);
  assert.equal(inputs.dry_run.default,true);
  assert.equal(publisher.with.retries,0);
  assert.match(workflow.jobs.publish.if,/!inputs\.dry_run/);
  assert.ok(!JSON.stringify(workflow.jobs.publish).includes('actions/checkout'));
  const inputEnv={...env,VERSION:'1.2.3',TAG_PREFIX:'v',TEST_RUNS_ON:'ubuntu-latest',SOURCE_ARCHIVES:'false',GO_MODULES:'[]',HOMEBREW_TAP:'example/tap',HOMEBREW_FORMULA:'',GENERATED_ASSET:'',GENERATED_INPUT_ARTIFACT_ID:'',GITHUB_OUTPUT:path.join(root,'outputs')};
  for(const [current,signed] of [['false','false'],['false','true'],['true','true']])execFileSync('/bin/bash',['-c',validate.run],{env:{...inputEnv,REQUIRE_CURRENT_SIGNER:current,REQUIRE_SIGNED_TAG:signed},stdio:'pipe'});
  assert.throws(()=>execFileSync('/bin/bash',['-c',validate.run],{env:{...inputEnv,REQUIRE_CURRENT_SIGNER:'true',REQUIRE_SIGNED_TAG:'false'},stdio:'pipe'}),/require-current-signer requires require-signed-tag/);
  const frozenPolicy=path.join(root,'frozen-policy');fs.writeFileSync(frozenPolicy,approved);
  git(['-c','gpg.format=ssh','-c','gpg.ssh.allowedSignersFile='+frozenPolicy,'verify-tag',tagSha]);
  console.log(`${cases} complete publisher cases passed; input defaults and native frozen SSH signature verified`);
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
