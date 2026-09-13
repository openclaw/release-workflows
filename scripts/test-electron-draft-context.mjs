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
const names = ['ASSET-INVENTORY.json', 'RELEASE-NOTES.md', 'SHA256SUMS', 'desktop.zip'];
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
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] !== 'release' || !['create', 'view'].includes(args[1])) process.exit(1);
if (args[1] === 'view') console.log('123');
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
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--draft'));
  assert.ok(calls[0].includes('--verify-tag'));
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--notes-file') + 2), names.map((name) => `release-assets/${name}`));
  assert.deepEqual(calls[1], ['release', 'view', 'v1.2.3', '--json', 'databaseId', '--jq', '.databaseId']);
  assert.equal(readFileSync(join(root, 'output'), 'utf8'), 'release-id=123\n');
  console.log('PASS Electron draft resolves repository and uploads only immutable payload files without a checkout');
} finally { rmSync(root, { recursive: true, force: true }); }
