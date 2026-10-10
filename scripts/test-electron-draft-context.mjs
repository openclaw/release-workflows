#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow('release-electron.yml');
assert.ok(workflow.jobs.draft.steps.every((step) => !step.uses?.startsWith('actions/checkout@')));
const release = workflowStep(workflow, 'draft', 'id', 'release');
const root = mkdtempSync(join(tmpdir(), 'electron-draft-context-'));
const names = ['ASSET-INVENTORY.json', 'Foo+Bar.zip', 'RELEASE-NOTES.md', 'SHA256SUMS'];
try {
  mkdirSync(join(root, 'staging', 'release-assets'), { recursive: true });
  mkdirSync(join(root, 'workspace'));
  mkdirSync(join(root, 'bin'));
  for (const name of names) writeFileSync(join(root, 'staging', 'release-assets', name), `frozen ${name}\n`);
  execFileSync('tar', ['-czf', join(root, 'workspace', 'electron-release-assets.tar.gz'), '-C', join(root, 'staging'), 'release-assets']);
  writeFileSync(join(root, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.GH_REPO !== 'openclaw/release-workflows') throw new Error('missing explicit repository in checkout-free draft');
const inputIndex = args.indexOf('--input');
const stdin = inputIndex >= 0 && args[inputIndex + 1] === '-' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, stdin }) + '\\n');
const endpoint = args.find((arg) => arg.startsWith('repos/') || arg.startsWith('https://uploads.github.com/'));
if (!endpoint || !(endpoint.startsWith('repos/openclaw/release-workflows/') || endpoint.startsWith('https://uploads.github.com/repos/openclaw/release-workflows/releases/'))) process.exit(1);
if (endpoint.endsWith('/releases')) console.log('{"id":123,"upload_url":"https://uploads.github.com/repos/openclaw/release-workflows/releases/123/assets{?name,label}"}');
`, { mode: 0o755 });
  const result = spawnSync('bash', ['-c', release.run], {
    cwd: join(root, 'workspace'), encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`, TAG: 'v1.2.3',
      GITHUB_OUTPUT: join(root, 'output'), CALLS: join(root, 'calls'),
      ...(release.env.GH_REPO === '${{ github.repository }}' ? { GH_REPO: 'openclaw/release-workflows' } : {}),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2 + names.length);
  assert.deepEqual(calls[0].args, ['api', 'repos/openclaw/release-workflows/git/ref/tags/v1.2.3']);
  assert.deepEqual(calls[1].args, ['api', '--method', 'POST', '--input', '-', 'repos/openclaw/release-workflows/releases']);
  const created = JSON.parse(calls[1].stdin);
  assert.equal(created.draft, true);
  assert.equal(created.tag_name, 'v1.2.3');
  assert.equal(created.name, 'v1.2.3');
  assert.equal(created.body, 'frozen RELEASE-NOTES.md\n');
  const uploads = calls.slice(2);
  assert.deepEqual(uploads.map((call) => call.args.filter((arg) => arg.startsWith('https://uploads.github.com/'))), names.map((name) => {
    const encoded = execFileSync('jq', ['-rn', '--arg', 'name', name, '$name|@uri'], { encoding: 'utf8' }).trim();
    return [`https://uploads.github.com/repos/openclaw/release-workflows/releases/123/assets?name=${encoded}`];
  }));
  assert.ok(!uploads.some((call) => call.args.some((arg) => arg.includes('api.github.com') || (arg.startsWith('repos/') && arg.includes('/assets')))));
  for (const [index, call] of uploads.entries()) {
    assert.deepEqual(call.args.slice(0, 5), ['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream']);
    assert.deepEqual(call.args.slice(-2), ['--input', `release-assets/${names[index]}`]);
  }
  assert.ok(!calls.some((call) => call.args.includes('view') || call.args.includes('release')));
  assert.equal(readFileSync(join(root, 'output'), 'utf8'), 'release-id=123\n');
  console.log('PASS Electron draft resolves repository and uploads only immutable payload files without a checkout');
} finally { rmSync(root, { recursive: true, force: true }); }
