#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { loadWorkflow, workflowStep, extractMarkedSource } from './workflow-source.cjs';

const w = loadWorkflow('release-sparkle-app.yml');
const contract = w.on?.workflow_call ?? w.true.workflow_call;
const step = (job, name) => workflowStep(w, job, 'name', name);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);

test('environment secrets are explicit, scoped to signing, and all public writes follow approval', () => {
  assert.deepEqual(Object.keys(contract.secrets).sort(), ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY_P8', 'MACOS_SIGNING_P12', 'MACOS_SIGNING_P12_PASSWORD', 'SPARKLE_PRIVATE_KEY']);
  assert.ok(Object.values(contract.secrets).every(s => s.required));
  assert.equal(w.jobs.sign.environment, '${{ inputs.signing-environment }}');
  for (const [name, job] of Object.entries(w.jobs)) {
    if (name !== 'sign') assert.doesNotMatch(JSON.stringify(job), /secrets\./);
  }
  assert.deepEqual(w.jobs.sign.permissions, { actions: 'read' });
  assert.deepEqual(w.jobs.verify.permissions, { actions: 'read' });
  assert.doesNotMatch(JSON.stringify(w.jobs.sign), /actions\/checkout|app-build-script|cli-build-script|npm-pack-script/);
  assert.doesNotMatch(JSON.stringify(w.jobs.verify), /actions\/checkout|listReleaseAssets|getRelease|secrets\./);
  assert.deepEqual(w.jobs.tag.needs, ['validate', 'sign', 'package']);
  for (const name of ['tag', 'draft', 'publish', 'handoff', 'closeout']) assert.match(w.jobs[name].if, /!inputs.dry-run/);
  assert.match(w.jobs.verify.if, /always\(\).*inputs.dry-run/);
  assert.equal(contract.inputs['build-runner'].default, 'xcode-27');
  assert.deepEqual(w.jobs.verify.strategy.matrix.include, [
    { arch: 'arm64', runner: 'macos-15' }, { arch: 'x86_64', runner: 'macos-15-intel' }, { arch: 'arm64', runner: 'macos-26' },
  ]);
  assert.ok(w.jobs.build.steps.some(s => s.with?.submodules === 'recursive'));
  assert.ok(w.jobs.verify.steps.some(s => s.with?.path === '${{ runner.temp }}/sparkle-payload/verified-sparkle-attestation.json'));
  for (const job of ['draft', 'verify', 'closeout']) assert.ok(JSON.stringify(w.jobs[job]).includes('payload.py'));
  for (const job of Object.values(w.jobs)) for (const s of job.steps) {
    if (s.uses) assert.match(s.uses, /@[a-f0-9]{40}$/);
  }
});

test('protected source and tag-event guards freeze the intended commit', async () => {
  const resolver = step('validate', 'Resolve protected release target').with.script;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', resolver);
  for (const scenario of ['main', 'dry', 'tag', 'moved', 'unprotected']) {
    const outputs = new Map(); const errors = []; let tagReads = 0;
    const github = {rest:{repos:{
      get:async()=>({data:{default_branch:'main'}}),
      getBranch:async()=>({data:{protected:scenario!=='unprotected',commit:{sha:'b'.repeat(40)}}}),
      compareCommitsWithBasehead:async()=>({data:{status:'ahead'}}),
    },git:{
      getRef:async()=>{tagReads++;return {data:{object:{type:'tag',sha:'c'.repeat(40)}}};},
      getTag:async()=>({data:{object:{type:'commit',sha:'a'.repeat(40)}}}),
    }}};
    const tagged=['tag','moved'].includes(scenario);
    const context={repo:{owner:'openclaw',repo:'fixture'},eventName:tagged?'push':'workflow_dispatch',ref:tagged?'refs/tags/v1.2.3':'refs/heads/main',sha:tagged?(scenario==='moved'?'d':'a').repeat(40):'b'.repeat(40)};
    try {
      await execute(github,context,{info(){},setFailed:e=>errors.push(e),setOutput:(k,v)=>outputs.set(k,v)},{env:{TAG:'v1.2.3',DRY_RUN:String(scenario==='dry'),GITHUB_WORKFLOW_REF:'openclaw/fixture/.github/workflows/release.yml@'+context.ref}});
    } catch (error) { errors.push(error.message); }
    if (['moved','unprotected'].includes(scenario)) {assert.ok(errors.length);assert.equal(outputs.has('target-sha'),false);}
    else {assert.deepEqual(errors,[]);assert.equal(outputs.get('target-sha'),(scenario==='dry'?'b':'a').repeat(40));}
    if (scenario==='dry') assert.equal(tagReads,0);
  }
  const freeze = step('tag', 'Create or reuse immutable annotated tag').with.script;
  for (const guard of ['EXPECTED_TAG_OBJECT', 'tag disappeared after validation', 'tag object changed after validation', 'tag appeared after validation']) assert.ok(freeze.includes(guard));
});

test('signer pins tool checksums, private seed file permissions, and always-run cleanup', () => {
  const install = step('sign', 'Install checksum-pinned release tools').run;
  assert.match(install, /c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c/);
  assert.match(install, /--require-hashes/);
  assert.match(install, /--only-binary=:all:/);
  assert.equal((install.match(/--hash=sha256:[a-f0-9]{64}/g) ?? []).length, 3);
  const sign = step('sign', 'Sign app inside out and notarize release payload').run;
  assert.match(sign, /chmod 600 "\$NOTARY_KEY" "\$sparkle_key"/);
  assert.match(sign, /--ed-key-file "\$sparkle_key"/);
  assert.match(sign, /--entitlements frozen-inputs\/app.entitlements/);
  assert.doesNotMatch(sign, /--deep.*--sign|--sign.*--deep/);
  assert.equal(step('sign', 'Restore signing keychain').if, 'always()');
});

test('Downloader record is captured before signing and bound to every independent verifier', () => {
  const unpack = step('sign', 'Validate and unpack frozen unsigned payload');
  const sign = step('sign', 'Sign app inside out and notarize release payload').run;
  assert.ok(w.jobs.sign.steps.indexOf(unpack) < w.jobs.sign.steps.findIndex(s => s.id === 'signer'));
  assert.match(unpack.run, /downloader.py" capture "unsigned\/\$APP_NAME.app" "\$RUNNER_TEMP\/downloader-entitlements.json"/);
  assert.match(sign, /downloader.py" sign "\$app" "\$RUNNER_TEMP\/downloader-entitlements.json"/);
  assert.match(sign, /data\['downloaderEntitlements'\]=json.loads\(Path\(e\['RUNNER_TEMP'\],'downloader-entitlements.json'\).read_text\(\)\)/);
  assert.ok(sign.indexOf('downloader.py" sign') < sign.indexOf('--entitlements frozen-inputs/app.entitlements'));
  assert.ok(sign.indexOf('downloader.py" verify') > sign.indexOf('--entitlements frozen-inputs/app.entitlements'));
  const verify = step('verify', 'Verify inventory, Sparkle signature, sealed app, DMG, and CLI').run;
  assert.match(verify, /downloader.py" verify-manifest "\$app" release-assets\/SIGNING-MANIFEST.json/);
  assert.ok(verify.indexOf('downloader.py" verify-manifest') < verify.indexOf("verdict='verified'"));
  assert.match(verify, /bind_signed\(Path\(e\['GITHUB_WORKSPACE'\]\)/);
  for (const job of ['sign', 'verify']) {
    const tools = w.jobs[job].steps.map(s => s.run ?? '').join('\n');
    const downloader = extractMarkedSource(tools, '# BEGIN downloader.py\n', '# END downloader.py');
    assert.match(downloader, /for path in \(bundle,executable\) for arch in \('arm64','x86_64'\)/);
  }
});

test('unsigned-feed policy runs on the built plist before signing, tag or draft effects', () => {
  assert.ok(w.jobs.sign.needs.includes('build'));
  const build = step('build', 'Validate and freeze raw build outputs').run;
  assert.ok(build.indexOf('metadata.py') < build.indexOf('codesign --verify'));
  assert.ok(build.indexOf('metadata.py') < build.indexOf('mkdir raw'));
  for (const job of ['build', 'sign', 'verify']) {
    const tools = w.jobs[job].steps.map(s => s.run ?? '').join('\n');
    const metadata = extractMarkedSource(tools, '# BEGIN metadata.py\n', '# END metadata.py');
    assert.match(metadata, /require\(data.get\('SURequireSignedFeed',False\) is False/);
    assert.doesNotMatch(metadata, /data.get\('SUVerifyUpdateBeforeExtraction'/);
    const commands = w.jobs[job].steps.map(s => s.run ?? '').join('\n').split('# END metadata.py')[1];
    assert.match(commands, /python3 "\$RUNNER_TEMP\/sparkle-tools\/metadata.py"/);
  }
});

function publisherFixture(scenario = '') {
  const notes = scenario === 'crlf' ? '## 1.2.3 - 2026-10-01\r\n\r\nFixture release.\r\n' : '## 1.2.3 - 2026-10-01\n\nFixture release.\n';
  const payloads = new Map([
    ['app.zip', Buffer.from('signed bytes')], ['ASSET-INVENTORY.json', Buffer.from('{}')],
    ['RELEASE-NOTES.md', Buffer.from(notes)], ['SIGNING-MANIFEST.json', Buffer.from(JSON.stringify({ toolchain: {}, submissions: { app: 'submission' } }))],
  ]);
  const sums = [...payloads].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`).join('');
  payloads.set('checksums.txt', Buffer.from(sums));
  const assets = [...payloads].map(([name, bytes], id) => ({ name, bytes, id }));
  if (scenario === 'tamper') assets[0].bytes = Buffer.from('changed');
  if (scenario === 'extra') assets.push({ id: 55, name: 'extra', bytes: Buffer.from('extra') });
  if (scenario === 'duplicate') assets.push(assets[0]);
  const events = [];
  let attempts = 0;
  const github = {
    paginate: async () => assets,
    request: async (_route, { asset_id }) => {
      events.push('download');
      if (scenario === 'retry' && attempts++ < 2) throw Object.assign(new Error('server'), { status: 503 });
      if (scenario === 'forbidden') throw Object.assign(new Error('denied'), { status: 403 });
      return { data: assets.find(a => a.id === asset_id).bytes };
    },
    rest: {
      repos: {
        getRelease: async ({ release_id }) => { assert.equal(release_id, 123); return { data: { draft: true, prerelease: scenario === 'prerelease-mismatch', tag_name: scenario === 'retag' ? 'v9' : 'v1.2.3' } }; },
        listReleaseAssets: 'assets',
        updateRelease: async request => { events.push('publish'); assert.ok(request.body.startsWith(notes)); assert.match(request.body, /## Verification/); return { data: { draft: false, published_at: '2026-10-01', html_url: 'release' } }; },
      },
      git: {
        getRef: async () => { events.push('tag'); return { data: { object: { type: scenario === 'lightweight' ? 'commit' : 'tag', sha: 'object' } } }; },
        getTag: async () => ({ data: { object: { type: 'commit', sha: scenario === 'moved' ? 'moved' : 'commit' } } }),
      },
    },
  };
  const readFileSync = path => {
    const runner = path.split('/')[1];
    return JSON.stringify({ schemaVersion: 1, repository: 'openclaw/fixture', runId: '42', payloadArtifact: 'payload', tag: 'v1.2.3', commit: scenario === 'attestation' && runner === 'macos-26' ? 'changed' : 'commit', architecture: runner === 'macos-15-intel' ? 'x86_64' : 'arm64', runner, verdict: 'verified', assetInventory: '{}', sha256sums: sums, releaseNotes: notes });
  };
  return { github, events, require: name => name === 'fs' ? { readFileSync } : require(name) };
}
for (const scenario of ['', 'tamper', 'extra', 'duplicate', 'retag', 'moved', 'lightweight', 'attestation', 'retry', 'forbidden', 'crlf', 'prerelease-mismatch']) {
  test(`publisher binds three attestations, creation ID, and draft bytes: ${scenario || 'success'}`, async () => {
    const fixture = publisherFixture(scenario);
    const delays = [];
    const execute = new AsyncFunction('github', 'context', 'core', 'process', 'require', 'setTimeout', step('publish', 'Bind draft bytes and publish').with.script);
    const run = () => execute(fixture.github, { repo: { owner: 'openclaw', repo: 'fixture' }, runId: 42 }, { info() {}, warning() {}, setOutput() {} }, { env: { RELEASE_ID: '123', CHECKSUM_FILENAME: 'checksums.txt', TAG: 'v1.2.3', TARGET_SHA: 'commit', VERIFICATION_ARTIFACT: 'payload' } }, fixture.require, (resolve, ms) => { delays.push(ms); resolve(); });
    if (scenario === '' || scenario === 'retry' || scenario === 'crlf') {
      await run(); assert.equal(fixture.events.at(-1), 'publish');
      assert.ok(fixture.events.indexOf('tag') > fixture.events.lastIndexOf('download'));
      assert.deepEqual(delays, scenario === 'retry' ? [1000, 2000] : []);
    } else { await assert.rejects(run); assert.ok(!fixture.events.includes('publish')); assert.deepEqual(delays, []); }
  });
}

test('handoff injects scheduler and binds the newly dispatched run before success', async () => {
  const source = step('handoff', 'Dispatch and await downstream workflows').with.script;
  const block = extractMarkedSource(source, '// BEGIN handoff', '// END handoff');
  const execute = new AsyncFunction('github', 'context', 'core', 'process', 'wait', `${block}\nreturn handoff('publish.yml', wait, () => 0);`);
  let reads = 0; let dispatched = false; const delays = [];
  const github = { paginate: async () => ++reads < 3 ? [] : [{ id: 7, head_sha: 'head', actor: { login: 'github-actions[bot]' }, status: 'completed', conclusion: 'success', html_url: 'run' }], rest: { users: { getAuthenticated: async () => ({ data: { login: 'bot' } }) }, repos: { getBranch: async () => ({ data: { commit: { sha: 'head' } } }) }, actions: { listWorkflowRuns: 'list', createWorkflowDispatch: async request => { dispatched = true; assert.deepEqual(request.inputs, { version: '1.2.3' }); } } } };
  await execute(github, { repo: { owner: 'openclaw', repo: 'fixture' } }, { info() {} }, { env: { DEFAULT_BRANCH: 'main', VERSION: '1.2.3' } }, async ms => delays.push(ms));
  assert.ok(dispatched); assert.deepEqual(delays, [15000]);
});

for (const scenario of ['create', 'existing', 'stale', 'unavailable-blob']) {
  test(`closeout uses a tree SHA and creates only a release branch: ${scenario}`, async () => {
    const source = step('closeout', 'Open one closeout PR without writing protected branch').with.script;
    const calls = [];
    const github = { rest: {
      pulls: { list: async () => ({ data: scenario === 'existing' ? [{ html_url: 'existing' }] : [] }), create: async () => { calls.push('pr'); return { data: { html_url: 'new' } }; } },
      repos: { getBranch: async () => ({ data: { commit: { sha: 'head' } } }), getContent: async ({ path, ref }) => ({ data: { type: 'file', encoding: 'none', content: '', sha: (path === 'CHANGELOG.md' ? 'c' : scenario === 'stale' && ref === 'head' ? 'd' : 'a').repeat(40) } }) },
      git: { getBlob: async ({ file_sha }) => ({ data: { encoding: scenario === 'unavailable-blob' ? 'none' : 'base64', content: Buffer.from(file_sha[0] === 'c' ? '# Changes\n\n## 1.2.3 - 2026-10-01\n' : file_sha[0] === 'd' ? 'changed' : 'old feed').toString('base64') } }), getCommit: async ({ commit_sha }) => { assert.equal(commit_sha, 'head'); return { data: { tree: { sha: 'base-tree' } } }; }, createTree: async request => { assert.equal(request.base_tree, 'base-tree'); calls.push('tree'); return { data: { sha: 'new-tree' } }; }, createCommit: async request => { assert.deepEqual(request.parents, ['head']); return { data: { sha: 'new-commit' } }; }, createRef: async request => { assert.equal(request.ref, 'refs/heads/release/sparkle-closeout-v1.2.3'); calls.push('ref'); } },
    } };
    const execute = new AsyncFunction('github', 'context', 'core', 'process', 'require', source);
    const run = () => execute(github, { repo: { owner: 'openclaw', repo: 'fixture' } }, { info() {} }, { env: { APPCAST_PATH: 'appcast.xml', DEFAULT_BRANCH: 'main', TAG: 'v1.2.3', TARGET_SHA: 'frozen', RUNNER_TEMP: '/tmp/fixture' } }, name => name === 'node:fs' ? { readFileSync: () => 'published feed' } : require(name));
    if (scenario === 'stale' || scenario === 'unavailable-blob') { await assert.rejects(run, scenario === 'stale' ? /appcast changed/ : /complete closeout blob/); assert.deepEqual(calls, []); }
    else { await run(); assert.deepEqual(calls, scenario === 'existing' ? [] : ['tree', 'ref', 'pr']); }
  });
}

test('frozen inputs and signed payloads are downloaded by immutable ID', () => {
  for (const job of Object.values(w.jobs)) for (const item of job.steps ?? []) {
    if (!item.uses?.startsWith('actions/download-artifact@')) continue;
    if (item.with['artifact-ids'] || /^\$\{\{ needs\.(validate|sign|package)\.outputs\.[^}]+ \}\}$/.test(item.with.name ?? '')) {
      assert.ok(item.with['artifact-ids']);
      assert.equal(item.with['merge-multiple'], true);
      assert.equal(item.with.name, undefined);
    }
  }
  assert.equal(w.jobs.validate.outputs['frozen-inputs-id'], '${{ steps.frozen-upload.outputs.artifact-id }}');
  assert.equal(w.jobs.sign.outputs['artifact-id'], '${{ steps.signed-upload.outputs.artifact-id }}');
  assert.equal(w.jobs.package.outputs['artifact-id'], '${{ steps.package-upload.outputs.artifact-id }}');
});
