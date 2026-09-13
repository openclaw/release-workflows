#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const preflightScript = workflowStep(loadWorkflow(), 'validate', 'name', 'Validate signing credentials').run;
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
