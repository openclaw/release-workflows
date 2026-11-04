#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const repository = { owner: 'openclaw', repo: 'fixture' };
const tag = 'v1.2.3';
const targetSha = 'a'.repeat(40);
const runId = '42';
const artifact = 'immutable-payload-42-1';
const releaseNotes = '## 1.2.3 - 2026-09-15\n\n- Synthetic release.\n';
const assetInventory = JSON.stringify({ schemaVersion: 1, repository: 'openclaw/fixture', tag, commit: targetSha });
const payloads = new Map([
  ['ASSET-INVENTORY.json', Buffer.from(assetInventory)],
  ['RELEASE-NOTES.md', Buffer.from(releaseNotes)],
  ['fixture.zip', Buffer.from('synthetic signed payload')],
]);
const sha256sums = [...payloads].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`).join('');
const assets = [...payloads, ['SHA256SUMS', Buffer.from(sha256sums)]].map(([name, bytes], id) => ({ id, name, bytes }));
const scenarios = [
  { name: 'unchanged annotated tag publishes', valid: true },
  { name: 'retagged draft is rejected', draftTag: 'v9.9.9', error: /draft identity/ },
  { name: 'moved annotated tag is rejected', commit: 'c'.repeat(40), error: /tag target changed/ },
  { name: 'lightweight replacement is rejected', refType: 'commit', error: /no longer annotated/ },
  { name: 'indirect tag is rejected', objectType: 'tag', error: /tag target changed/ },
  { name: 'deleted tag is rejected', refError: 404, error: /ref unavailable/ },
  { name: 'unreadable tag object is rejected', objectError: 403, error: /object unavailable/ },
];

async function freezeGoTag(existing) {
  const outputs = {};
  const script = workflowStep(loadWorkflow(), 'tag', 'name', 'Create immutable annotated tag').with.script;
  await new AsyncFunction('github', 'context', 'core', 'process', script)({ rest: { git: {
    getRef: async () => {
      if (!existing) throw Object.assign(new Error('missing'), { status: 404 });
      return { data: { object: { type: 'tag', sha: 'b'.repeat(40) } } };
    },
    getTag: async () => ({ data: { object: { type: 'commit', sha: targetSha } } }),
    createTag: async () => ({ data: { sha: 'b'.repeat(40) } }),
    createRef: async (request) => { assert.equal(request.sha, 'b'.repeat(40)); },
  } } }, { repo: repository }, {
    info() {}, setFailed(message) { throw new Error(message); },
    setOutput(name, value) { outputs[name] = value; },
  }, { env: { DRY_RUN: 'false', EXPECTED_TAG_OBJECT: existing ? 'b'.repeat(40) : '', TAG: tag, TARGET_SHA: targetSha, REPOSITORY_TYPE: 'openclaw' } });
  assert.equal(outputs['tag-object-sha'], 'b'.repeat(40));
  return outputs['tag-object-sha'];
}

let failures = 0;
for (const archetype of ['go-cli', 'swift-cli', 'electron']) {
  const script = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'publish', 'id', 'publish').with.script;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', 'require', script);
  const cases = [...scenarios];
  if (['go-cli', 'swift-cli'].includes(archetype)) {
    cases.push({ name: 'replaced signed tag object is rejected', expectedTagObject: 'd'.repeat(40), error: /tag object changed/ });
  }
  if (archetype === 'go-cli') {
    cases.push(
      { name: 'workflow-created tag publishes with producer identity', producer: 'created', valid: true },
      { name: 'existing tag publishes with producer identity', producer: 'existing', valid: true },
      { name: 'existing public release replay preserves the frozen object', publicReplay: true, valid: true },
      { name: 'replacement object blocks public release replay', publicReplay: true, expectedTagObject: 'd'.repeat(40), error: /tag object changed/ },
      { name: 'replacement during public asset download blocks replay', publicReplay: true, replaceDuringPublicDownload: true, error: /tag object changed/ },
      { name: 'replacement during public release lookup blocks publication', replaceDuringReleaseLookup: true, error: /tag object changed/ },
      { name: 'missing producer identity blocks publication', expectedTagObject: '', error: /tag object changed/ },
      { name: 'missing producer identity blocks public replay', publicReplay: true, expectedTagObject: '', error: /tag object changed/ },
    );
  }
  for (const scenario of cases) {
    const calls = [];
    let refSha = 'b'.repeat(40);
    let thrown;
    const github = {
      paginate: async () => assets,
      request: async (_route, request) => {
        calls.push('download');
        if (scenario.replaceDuringPublicDownload && calls.filter((call) => call === 'download').length > assets.length) {
          refSha = 'd'.repeat(40);
        }
        return { data: assets.find((asset) => asset.id === request.asset_id).bytes };
      },
      rest: {
        git: {
          getRef: async (request) => {
            assert.deepEqual(request, { ...repository, ref: `tags/${tag}` });
            calls.push('ref');
            if (scenario.refError) throw Object.assign(new Error('ref unavailable'), { status: scenario.refError });
            return { data: { object: { type: scenario.refType ?? 'tag', sha: refSha } } };
          },
          getTag: async (request) => {
            assert.deepEqual(request, { ...repository, tag_sha: 'b'.repeat(40) });
            calls.push('tag');
            if (scenario.objectError) throw Object.assign(new Error('object unavailable'), { status: scenario.objectError });
            return { data: { object: { type: scenario.objectType ?? 'commit', sha: scenario.commit ?? targetSha } } };
          },
        },
        repos: {
          getRelease: async () => ({ data: { id: 7, draft: true, tag_name: scenario.draftTag ?? tag } }),
          listReleaseAssets: 'assets',
          getReleaseByTag: async () => {
            if (scenario.replaceDuringReleaseLookup) refSha = 'd'.repeat(40);
            if (scenario.publicReplay) return { data: { id: 8, draft: false, tag_name: tag, body: releaseNotes, published_at: '2026-09-15', html_url: 'https://example.test/release' } };
            throw Object.assign(new Error('no public release'), { status: 404 });
          },
          deleteRelease: async (request) => {
            assert.equal(request.release_id, 7);
            calls.push('delete');
          },
          updateRelease: async (request) => {
            calls.push('publish');
            assert.equal(request.release_id, 7);
            assert.equal(request.draft, false);
            assert.equal(request.body, releaseNotes);
            return { data: { body: request.body, draft: false, published_at: '2026-09-15', html_url: 'https://example.test/release' } };
          },
        },
      },
    };
    const testRequire = (name) => name === 'fs' ? {
      readFileSync: (path) => {
        const architecture = path.includes('/arm64/') ? 'arm64' : 'x86_64';
        assert.ok(path.includes(`/${architecture}/`));
        return JSON.stringify({ schemaVersion: 1, repository: 'openclaw/fixture', runId, payloadArtifact: artifact, tag, commit: targetSha, architecture, verdict: 'verified', checksumFilename: 'SHA256SUMS', assetInventory, releaseNotes, sha256sums });
      },
    } : require(name);
    try {
      const expectedTagObject = scenario.producer
        ? await freezeGoTag(scenario.producer === 'existing')
        : scenario.expectedTagObject ?? (archetype === 'go-cli' ? 'b'.repeat(40) : undefined);
      await execute(github, { repo: repository, runId: Number(runId) }, {
        info() {}, warning() {}, setOutput() {}, setFailed(message) { throw new Error(message); },
      }, { env: { EXPECTED_TAG_OBJECT: expectedTagObject, CHECKSUM_FILENAME: 'SHA256SUMS', RELEASE_ID: '7', TAG: tag, TARGET_SHA: targetSha, GITHUB_RUN_ID: runId, VERIFICATION_ARTIFACT: artifact, VERIFICATION_PAYLOAD_ARTIFACT: artifact } }, testRequire);
    } catch (error) { thrown = error; }
    try {
      if (scenario.valid) {
        assert.equal(thrown, undefined);
        assert.equal(calls.filter((call) => call === 'publish').length, scenario.publicReplay ? 0 : 1);
        assert.equal(calls.filter((call) => call === 'delete').length, scenario.publicReplay ? 1 : 0);
        assert.equal(calls.slice(0, calls.indexOf('ref')).filter((call) => call === 'download').length,
          assets.length * (scenario.publicReplay ? 2 : 1),
          'recheck source only after every release asset has been downloaded and bound');
        const mutation = calls.indexOf(scenario.publicReplay ? 'delete' : 'publish');
        assert.ok(mutation > calls.indexOf('tag'));
        assert.ok(mutation > calls.lastIndexOf('download'));
        if (archetype === 'go-cli') assert.deepEqual(calls.slice(mutation - 2, mutation), ['ref', 'tag']);
      } else {
        assert.ok(thrown, 'changed source must fail before publication');
        assert.match(thrown.message, scenario.error);
        assert.ok(!calls.includes('publish'), 'failure must not publish');
        assert.ok(!calls.includes('delete'), 'failure must not delete a draft');
      }
      console.log(`PASS ${archetype}: ${scenario.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${archetype}: ${scenario.name}: ${error.message}`);
    }
  }
}
assert.equal(failures, 0);
