#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowPath = process.argv[2] ?? fileURLToPath(new URL('../.github/workflows/release-swift-cli.yml', import.meta.url));
const steps = JSON.parse(execFileSync('ruby', ['-rpsych', '-rjson', '-e', `
  workflow = Psych.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  puts JSON.generate(workflow.fetch('jobs').fetch('draft').fetch('steps'))
`, workflowPath], { encoding: 'utf8' }));
const release = steps.find((step) => step.id === 'release');
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
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, repo: process.env.GH_REPO }) + '\\n');
if (args[0] !== 'release' || !['create', 'view'].includes(args[1])) process.exit(1);
if (args[1] === 'view') console.log('123');
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
  assert.equal(calls.length, 2);
  const create = calls[0];
  const notesIndex = create.args.indexOf('--notes-file');
  assert.ok(notesIndex >= 0);
  assert.deepEqual(create.args.slice(notesIndex + 2), names.map((name) => `release-assets/${name}`).sort(), 'draft uploads must contain only immutable payload files');
  assert.ok(create.args.includes('--draft'));
  assert.ok(create.args.includes('--verify-tag'));
  for (const call of calls) assert.equal(call.repo, 'openclaw/release-workflows', 'gh must resolve the repository without a checkout');
  assert.equal(readFileSync(output, 'utf8'), 'release-id=123\n');
  for (const name of names) assert.equal(readFileSync(join(workspace, 'release-assets', name), 'utf8'), `frozen ${name}\n`);
  console.log('PASS Swift draft uploads only frozen archive members despite colliding caller source paths');
  console.log('PASS explicit repository context and draft ID output without a source checkout');
} finally {
  rmSync(root, { recursive: true, force: true });
}
