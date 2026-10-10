#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const names = ['ASSET-INVENTORY.json', 'RELEASE-NOTES.md', 'SHA256SUMS', 'SIGNING-MANIFEST.json', 'Foo+Bar.zip', 'cli-linux.tar.gz'];
const older = { id: 122, tag_name: 'v1.2.3', draft: true, assets: { 'old.zip': 'older bytes' } };
const gh = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(state));
const read = (file) => fs.readFileSync(file).toString('base64');
const tagExists = () => { if (scenario === 'missing-tag') process.exit(1); };
assert.equal(process.env.GH_REPO, 'openclaw/fixture');
// Model both the old tag lookup and the API path against the same two-draft state.
if (args[0] === 'release') {
  if (args[1] === 'create') {
    tagExists();
    state.push({ id: 123, tag_name: args[2], draft: true, assets: Object.fromEntries(args.filter((arg) => arg.startsWith('release-assets/')).map((file) => [file.split('/').at(-1), read(file)])) });
    save();
  } else if (args[1] === 'view') console.log(state[0].id);
  else process.exit(1);
  process.exit(0);
}
assert.equal(args[0], 'api');
const endpoint = args.find((arg) => arg.startsWith('repos/') || arg.startsWith('https://'));
if (endpoint === 'repos/openclaw/fixture/git/ref/tags/v1.2.3') {
  tagExists();
} else if (endpoint === 'repos/openclaw/fixture/releases') {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.push({ ...payload, id: 123, assets: {} });
  save();
  const response = { id: 123, upload_url: 'https://uploads.github.com/repos/openclaw/fixture/releases/123/assets{?name,label}' };
  if (scenario === 'invalid-id') response.id = 'invalid';
  if (scenario === 'wrong-host') response.upload_url = response.upload_url.replace('uploads.github.com', 'example.invalid');
  if (scenario === 'wrong-repository') response.upload_url = response.upload_url.replace('openclaw/fixture', 'openclaw/other');
  if (scenario === 'wrong-release') response.upload_url = response.upload_url.replace('/123/', '/122/');
  console.log(JSON.stringify(response));
} else {
  const url = new URL(endpoint);
  assert.equal(url.origin, 'https://uploads.github.com');
  assert.equal(url.pathname, '/repos/openclaw/fixture/releases/123/assets');
  if (scenario === 'upload-failure' && Object.keys(state[1].assets).length === 1) process.exit(1);
  const file = args[args.indexOf('--input') + 1];
  assert.equal(url.searchParams.get('name'), file.split('/').at(-1));
  state[1].assets[url.searchParams.get('name')] = read(file);
  save();
}
`;

function runDraft(archetype, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'draft-create-binding-'));
  try {
    for (const dir of ['workspace', 'staging/release-assets', 'bin']) mkdirSync(join(root, dir), { recursive: true });
    for (const name of names) writeFileSync(join(root, 'staging/release-assets', name), `frozen ${name}\r\n`);
    const archive = archetype === 'swift-cli' ? 'swift-release-assets.tar.gz' : 'electron-release-assets.tar.gz';
    execFileSync('tar', ['-czf', join(root, 'workspace', archive), '-C', join(root, 'staging'), 'release-assets']);
    writeFileSync(join(root, 'bin/gh'), gh, { mode: 0o755 });
    writeFileSync(join(root, 'state'), JSON.stringify([older]));
    const step = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'draft', 'id', 'release');
    const result = spawnSync('bash', ['-c', step.run], {
      cwd: join(root, 'workspace'), encoding: 'utf8',
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH}`, TAG: 'v1.2.3',
        GH_REPO: 'openclaw/fixture', STATE: join(root, 'state'), SCENARIO: scenario,
        GITHUB_OUTPUT: join(root, 'output'),
      },
    });
    return {
      ...result,
      state: JSON.parse(readFileSync(join(root, 'state'), 'utf8')),
      output: existsSync(join(root, 'output')) ? readFileSync(join(root, 'output'), 'utf8') : '',
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const archetype of ['electron', 'swift-cli']) {
  test(`${archetype}: exports the created draft despite an older same-tag draft`, () => {
    const result = runDraft(archetype, 'success');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'release-id=123\n');
    assert.deepEqual(result.state[0], older);
    const created = result.state[1];
    assert.equal(created.tag_name, 'v1.2.3');
    assert.equal(created.draft, true);
    assert.equal(created.body, 'frozen RELEASE-NOTES.md\r\n');
    assert.deepEqual(created.assets, Object.fromEntries(names.map((name) => [name, Buffer.from(`frozen ${name}\r\n`).toString('base64')])));
  });
  for (const scenario of ['missing-tag', 'invalid-id', 'wrong-host', 'wrong-repository', 'wrong-release', 'upload-failure']) {
    test(`${archetype}: ${scenario} cannot export a publishable draft`, () => {
      const result = runDraft(archetype, scenario);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.output, '');
      assert.deepEqual(result.state[0], older);
      if (scenario === 'missing-tag') assert.equal(result.state.length, 1);
      else assert.equal(Object.keys(result.state[1].assets).length, scenario === 'upload-failure' ? 1 : 0);
    });
  }
}
