#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const rubyExtractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  step = workflow.fetch('jobs').fetch('validate').fetch('steps').find do |candidate|
    candidate['name'] == 'Validate signing credentials'
  end
  abort 'signing credential preflight step not found' unless step
  print step.fetch('run')
`;
const preflightScript = execFileSync(
  'ruby',
  ['-rpsych', '-e', rubyExtractor, workflowPath],
  { encoding: 'utf8' },
);
const required = [
  'MACOS_SIGNING_P12',
  'MACOS_SIGNING_P12_PASSWORD',
  'ASC_KEY_ID',
  'ASC_ISSUER_ID',
  'ASC_PRIVATE_KEY_P8',
];

const completeEnv = Object.fromEntries(required.map((name) => [name, `fixture-${name}`]));
const baseEnv = { HOME: '/tmp', PATH: process.env.PATH };
const bashArgs = ['--noprofile', '--norc', '-euo', 'pipefail', '-c', preflightScript];
const success = spawnSync('/bin/bash', bashArgs, {
  encoding: 'utf8',
  env: { ...baseEnv, ...completeEnv },
});
assert.equal(success.status, 0, success.stderr);
assert.equal(success.stdout, '');
assert.equal(success.stderr, '');

for (const missingName of required) {
  const env = { ...baseEnv, ...completeEnv };
  delete env[missingName];
  const failure = spawnSync('/bin/bash', bashArgs, {
    encoding: 'utf8',
    env,
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, new RegExp(`missing required release secret\\(s\\): ${missingName}`));
  for (const value of Object.values(completeEnv)) {
    assert.equal(failure.stderr.includes(value), false);
  }
}

console.log(`signing credential preflight tests passed (${required.length + 1} scenarios)`);
