#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-resume-test-'));
const repo = {owner:'example', repo:'fixture'}, tag = 'v1.2.3';
const target = 'a'.repeat(40), tagObject = 'b'.repeat(40), releaseId = 71;
const files = {'ASSET-INVENTORY.json':'{}\n', 'RELEASE-NOTES.md':'Fixture notes\n', 'SHA256SUMS':'checksums\n'};
const names = Object.keys(files).sort();
let cases = 0;
try {
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(root,name),data);
  for (const filename of ['release-source.yml','release-npm-package.yml']) {
    const script = workflowStep(loadWorkflow(filename),'publish','id','release').with.script;
    const execute = new AsyncFunction('github','context','core','process','require',script);
    const run = async (scenario = {}) => {
      const writes = [], reads = [];
      let release = scenario.state ? {id:releaseId,tag_name:tag,body:files['RELEASE-NOTES.md'],
        draft:scenario.state !== 'public',html_url:'https://example.test/release'} : undefined;
      let assets = (scenario.assets ?? (scenario.state === 'public' ? names : [])).map((name,index) =>
        ({id:100+index,name,bytes:Buffer.from(files[name] ?? 'extra')}));
      if (scenario.badBytes) assets[0].bytes = Buffer.from('changed');
      if (scenario.badNotes) release.body = 'changed';
      let assetReads = 0;
      const list = (kind, request) => {
        assert.equal(request.owner,repo.owner);assert.equal(request.repo,repo.repo);
        assert.equal(request.per_page,100);assert.ok(Number.isSafeInteger(request.page) && request.page > 0);
        if (kind === 'assets') {
          assert.equal(request.release_id,releaseId);
          if (request.page === 1) assetReads++;
        }
        reads.push(`${kind}:${request.page}`);
        const fault = scenario.failure;
        if (fault?.kind === kind && fault.page === request.page && (!fault.call || fault.call === assetReads)) {
          throw Object.assign(new Error(`listing ${kind} failed ${fault.status}`),{status:fault.status});
        }
        let pages;
        if (kind === 'releases') {
          pages = scenario.releasePages ? scenario.releasePages.map(page => page.map(value =>
            value === 'match' ? release : value === 'duplicate' ? {...release,id:72} :
              value === 'public-duplicate' ? {...release,id:72,draft:false} : {id:1,tag_name:'v0.0.1',draft:false})) : [release ? [release] : []];
        } else {
          pages = scenario.assetPages ? [assets.slice(0,1),assets.slice(1)] : [assets];
        }
        const next = request.page < pages.length;
        return {status:scenario.invalidStatus ?? 200,headers:next ?
          {link:`<https://api.github.com/repos/example/fixture/releases?page=${request.page+1}>; rel="next"`} : {},
        data:scenario.invalidData ? {} : pages[request.page-1] ?? []};
      };
      const github = {rest:{git:{
        getRef:async()=>({data:{object:{type:'tag',sha:tagObject}}}),
        getTag:async()=>({data:{object:{type:'commit',sha:target}}}),
      },repos:{
        // GitHub's tag endpoint is published-only, even for authenticated writers.
        getReleaseByTag:async()=>{if(!release || release.draft)throw Object.assign(new Error('no published release'),{status:404});return {data:release};},
        listReleases:async request=>list('releases',request),
        listReleaseAssets:async request=>list('assets',request),
        createRelease:async request=>{
          assert.equal(release,undefined,'must resume the existing draft instead of creating another');
          assert.equal(request.tag_name,tag);assert.equal(request.draft,true);
          writes.push('create');release={id:releaseId,...request};return {data:release};
        },
        uploadReleaseAsset:async request=>{
          assert.equal(request.release_id,releaseId);assert.ok(!assets.some(a=>a.name===request.name));
          writes.push('upload:'+request.name);assets.push({id:100+assets.length,name:request.name,bytes:request.data});return {data:{}};
        },
        getRelease:async request=>{assert.equal(request.release_id,releaseId);return {data:release};},
        updateRelease:async request=>{
          assert.equal(request.release_id,releaseId);assert.equal(request.draft,false);
          writes.push('publish');release={...release,...request,html_url:'https://example.test/release'};return {data:release};
        },
      }},request:async(_route,request)=>({data:assets.find(a=>a.id===request.asset_id).bytes})};
      let error, url;
      try {
        await execute(github,{repo},{info(){},setOutput(_name,value){url=value;}},
          {env:{TAG:tag,TARGET_SHA:target,EXPECTED_TAG_OBJECT:tagObject,PAYLOAD:root,REQUIRE_CURRENT_SIGNER:'false'}},require);
      } catch (caught) {error=caught;}
      return {writes,reads,error,url};
    };
    const test = async (name, scenario, writes, error) => {
      const result = await run(scenario);
      assert.deepEqual(result.writes,writes,`${filename}: ${name}`);
      if (error) assert.match(result.error?.message ?? '',error,name);
      else {assert.equal(result.error,undefined,name);assert.equal(result.url,'https://example.test/release');}
      cases++;console.log(`PASS ${filename}: ${name}`);return result;
    };
    await test('absent release creates once',{},['create',...names.map(n=>'upload:'+n),'publish']);
    await test('partial draft resumes same ID',{state:'draft',assets:[names[0]]},names.slice(1).map(n=>'upload:'+n).concat('publish'));
    await test('complete draft only un-drafts',{state:'draft',assets:names},['publish']);
    const later = await test('short and empty Link pages do not mean absence',
      {state:'draft',assets:names,releasePages:[['other'],[],['match']]},['publish']);
    assert.deepEqual(later.reads.slice(0,3),['releases:1','releases:2','releases:3']);
    await test('asset pagination preserves existing bytes',{state:'draft',assets:names,assetPages:true},['publish']);
    await test('public exact replay is read-only',{state:'public'},[]);
    await test('public byte mismatch is read-only',{state:'public',badBytes:true},[],/release bytes differ/);
    await test('public notes mismatch is read-only',{state:'public',badNotes:true},[],/Expected values/);
    await test('draft byte mismatch refuses overwrite',{state:'draft',assets:[names[0]],badBytes:true},[],/existing draft differs/);
    await test('unknown draft asset blocks writes',{state:'draft',assets:['extra.txt']},[],/unexpected existing draft asset/);
    for (const duplicate of ['duplicate','public-duplicate']) {
      await test('ambiguous exact tag '+duplicate,{state:'draft',releasePages:[['match'],[duplicate]]},[],/multiple releases/);
    }
    for (const status of [403,404,409,503]) {
      await test('first release page error '+status,{failure:{kind:'releases',page:1,status}},[],/listing releases failed/);
      await test('error after matching release '+status,
        {state:'draft',releasePages:[['match'],[]],failure:{kind:'releases',page:2,status}},[],/listing releases failed/);
      await test('existing draft asset error '+status,
        {state:'draft',failure:{kind:'assets',page:1,status}},[],/listing assets failed/);
    }
    await test('new draft asset error preserves only create',
      {failure:{kind:'assets',page:1,status:409}},['create'],/listing assets failed/);
    await test('later asset page error blocks writes',
      {state:'draft',assets:names,assetPages:true,failure:{kind:'assets',page:2,status:409}},[],/listing assets failed/);
    await test('comparison error preserves uploads and blocks un-draft',
      {failure:{kind:'assets',page:1,call:2,status:409}},['create',...names.map(n=>'upload:'+n)],/listing assets failed/);
    await test('non-200 listing is not absence',{invalidStatus:204},[],/release listing failed/);
    await test('non-array listing is not absence',{invalidData:true},[],/invalid release listing/);
  }
  console.log(`${cases} complete source/npm publisher resume cases passed`);
} finally {fs.rmSync(root,{recursive:true,force:true});}
