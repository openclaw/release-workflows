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
let failures = 0;
for (const archetype of ['go-cli', 'swift-cli', 'electron']) {
  const script = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'publish', 'id', 'publish').with.script;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', 'require', script);
  for (const scenario of scenarios) {
    const calls = [];
    let thrown;
    const github = {
      paginate: async () => assets,
      request: async (_route, request) => {
        calls.push('download');
        return { data: assets.find((asset) => asset.id === request.asset_id).bytes };
      },
      rest: {
        git: {
          getRef: async (request) => {
            assert.deepEqual(request, { ...repository, ref: `tags/${tag}` });
            calls.push('ref');
            if (scenario.refError) throw Object.assign(new Error('ref unavailable'), { status: scenario.refError });
            return { data: { object: { type: scenario.refType ?? 'tag', sha: 'b'.repeat(40) } } };
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
          getReleaseByTag: async () => { throw Object.assign(new Error('no public release'), { status: 404 }); },
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
      await execute(github, { repo: repository, runId: Number(runId) }, {
        info() {}, warning() {}, setOutput() {}, setFailed(message) { throw new Error(message); },
      }, { env: { CHECKSUM_FILENAME: 'SHA256SUMS', RELEASE_ID: '7', TAG: tag, TARGET_SHA: targetSha, GITHUB_RUN_ID: runId, VERIFICATION_ARTIFACT: artifact, VERIFICATION_PAYLOAD_ARTIFACT: artifact } }, testRequire);
    } catch (error) { thrown = error; }
    try {
      if (scenario.valid) {
        assert.equal(thrown, undefined);
        assert.equal(calls.filter((call) => call === 'publish').length, 1);
        assert.ok(calls.indexOf('ref') > calls.lastIndexOf('download'), 'recheck source after binding the asset bytes');
        assert.ok(calls.indexOf('publish') > calls.indexOf('tag'));
      } else {
        assert.ok(thrown, 'changed source must fail before publication');
        assert.match(thrown.message, scenario.error);
        assert.ok(!calls.includes('publish'), 'failure must not publish');
      }
      console.log(`PASS ${archetype}: ${scenario.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${archetype}: ${scenario.name}: ${error.message}`);
    }
  }
}
assert.equal(failures, 0);
