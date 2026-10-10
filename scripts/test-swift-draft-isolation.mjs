#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow(process.argv[2] ? resolve(process.argv[2]) : 'release-swift-cli.yml');
const steps = workflow.jobs.draft.steps;
const release = workflowStep(workflow, 'draft', 'id', 'release');
const root = mkdtempSync(join(tmpdir(), 'swift-draft-isolation-'));
const workspace = join(root, 'workspace');
const source = join(root, 'tagged-source');
const staging = join(root, 'staging');
const names = ['ASSET-INVENTORY.json', 'RELEASE-NOTES.md', 'SHA256SUMS', 'SIGNING-MANIFEST.json', 'cli-linux.tar.gz', 'cli-macos.zip'];

try {
  for (const directory of [workspace, join(source, 'release-assets'), join(staging, 'release-assets'), join(root, 'bin')]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(source, 'release-assets', 'extra.bin'), 'caller-controlled file');
  for (const name of names) writeFileSync(join(staging, 'release-assets', name), `frozen ${name}\n`);
  for (const step of steps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) {
    cpSync(source, join(workspace, step.with?.path ?? '.'), { recursive: true });
  }
  execFileSync('tar', ['-czf', join(workspace, 'swift-release-assets.tar.gz'), '-C', staging, 'release-assets']);
  writeFileSync(join(root, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');
const stdin = inputIndex >= 0 && args[inputIndex + 1] === '-' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, repo: process.env.GH_REPO, stdin }) + '\\n');
const endpoint = args.find((arg) => arg.startsWith('repos/') || arg.startsWith('https://uploads.github.com/'));
if (process.env.GH_REPO !== 'openclaw/release-workflows') process.exit(1);
if (!endpoint || !(endpoint.startsWith('repos/' + process.env.GH_REPO + '/') || endpoint.startsWith('https://uploads.github.com/repos/' + process.env.GH_REPO + '/releases/'))) process.exit(1);
if (endpoint.endsWith('/releases')) console.log('{"id":123,"upload_url":"https://uploads.github.com/repos/' + process.env.GH_REPO + '/releases/123/assets{?name,label}"}');
`, { mode: 0o755 });
  const output = join(root, 'output');
  const callsPath = join(root, 'calls');
  execFileSync('bash', ['-c', release.run], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      TMPDIR: tmpdir(),
      TAG: 'v1.2.3',
      GITHUB_OUTPUT: output,
      CALLS: callsPath,
      ...(release.env.GH_REPO === '${{ github.repository }}' ? { GH_REPO: 'openclaw/release-workflows' } : {}),
    },
  });
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 2 + names.length);
  assert.deepEqual(calls[0].args, ['api', 'repos/openclaw/release-workflows/git/ref/tags/v1.2.3']);
  assert.deepEqual(calls[1].args, ['api', '--method', 'POST', '--input', '-', 'repos/openclaw/release-workflows/releases']);
  const created = JSON.parse(calls[1].stdin);
  assert.equal(created.draft, true);
  assert.equal(created.tag_name, 'v1.2.3');
  assert.equal(created.body, 'frozen RELEASE-NOTES.md\n');
  const uploads = calls.slice(2);
  assert.deepEqual(uploads.map((call) => call.args.at(-1)), names.map((name) => `release-assets/${name}`), 'draft uploads must contain only immutable payload files');
  assert.deepEqual(uploads.map((call) => call.args.filter((arg) => arg.startsWith('https://uploads.github.com/'))), names.map((name) => {
    const encoded = execFileSync('jq', ['-rn', '--arg', 'name', name, '$name|@uri'], { encoding: 'utf8' }).trim();
    return [`https://uploads.github.com/repos/openclaw/release-workflows/releases/123/assets?name=${encoded}`];
  }));
  assert.ok(!uploads.some((call) => call.args.some((arg) => arg.includes('api.github.com') || (arg.startsWith('repos/') && arg.includes('/assets')))));
  for (const call of calls) assert.equal(call.repo, 'openclaw/release-workflows', 'gh must resolve the repository without a checkout');
  assert.ok(calls.every((call) => call.args[0] === 'api'));
  assert.equal(readFileSync(output, 'utf8'), 'release-id=123\n');
  for (const name of names) assert.equal(readFileSync(join(workspace, 'release-assets', name), 'utf8'), `frozen ${name}\n`);
  console.log('PASS Swift draft uploads only frozen archive members despite colliding caller source paths');
  console.log('PASS explicit repository context and draft ID output without a source checkout');
} finally {
  rmSync(root, { recursive: true, force: true });
}
