#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadWorkflow, workflowStep, extractMarkedSource } from './workflow-source.cjs';

const workflows = new Map(['release-sparkle-app.yml', 'release-electron.yml'].map((name) => [name, loadWorkflow(name)]));
const expected = [
  ['release-sparkle-app.yml', 'sign', 'Sign app inside out and notarize release payload'],
  ['release-sparkle-app.yml', 'verify', 'Verify inventory, Sparkle signature, sealed app, DMG, and CLI'],
  ['release-electron.yml', 'sign', 'Sign, notarize, staple, and package macOS apps'],
  ['release-electron.yml', 'verify', 'Verify checksums, sealed app, stapling, and cross-platform formats'],
];
const begin = '# BEGIN stapler-validate\n';
const end = '# END stapler-validate';
const sources = expected.map(([filename, job, name]) => workflowStep(workflows.get(filename), job, 'name', name).run);
const helper = extractMarkedSource(sources[0], begin, end);

test('contract: exactly four steps share one identical helper before two validation calls', () => {
  const found = [];
  for (const [filename, workflow] of workflows) {
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      for (const step of definition.steps ?? []) {
        if (/stapler validate|stapler_validate/.test(step.run ?? '')) found.push([filename, job, step.name]);
      }
    }
  }
  assert.deepEqual(found, expected);
  for (const source of sources) {
    assert.equal(source.split(begin).length - 1, 1, 'expected exactly one begin marker');
    assert.equal(source.split(end).length - 1, 1, 'expected exactly one end marker');
    assert.equal(extractMarkedSource(source, begin, end), helper, 'production helpers differ');
    const remainder = source.replace(begin + helper + end, '');
    assert.doesNotMatch(remainder, /xcrun stapler validate/);
    assert.equal([...remainder.matchAll(/stapler_validate "/g)].length, 2);
    assert.ok(source.indexOf(end) + end.length < source.indexOf('stapler_validate "'), 'helper must precede its calls');
    assert.ok(source.startsWith('set -euo pipefail\n' + begin), 'helper must follow shell safety flags');
  }
});

const shim = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const responses = JSON.parse(fs.readFileSync(process.env.RESPONSES, 'utf8'));
const response = responses.shift();
if (!response) { console.error('unexpected extra validation call'); process.exit(99); }
fs.writeFileSync(process.env.RESPONSES, JSON.stringify(responses));
process[response.stream ?? 'stdout'].write(response.output + '\\n');
process.exit(response.code);
`;
const target = '/synthetic release/Fixture.app';
const success = { code: 0, output: 'The validate action worked!' };
const missingTicket = { code: 65, output: `${target} does not have a ticket stapled to it.` };
const transient = (code) => ({ code: 68, output: `Error Domain=NSURLErrorDomain Code=${code} "network failure"` });

function run(responses, { exitCode, delays = [], after = false }) {
  const root = mkdtempSync(join(tmpdir(), 'stapler-validate-'));
  try {
    const callsPath = join(root, 'calls.jsonl');
    const delaysPath = join(root, 'delays');
    const responsesPath = join(root, 'responses.json');
    writeFileSync(join(root, 'xcrun'), shim, { mode: 0o755 });
    writeFileSync(callsPath, '');
    writeFileSync(delaysPath, '');
    writeFileSync(responsesPath, JSON.stringify(responses));
    const script = `${helper}\nsleep() { printf '%s\\n' "$1" >>"$DELAYS"; }\nstapler_validate "$T"${after ? '; echo AFTER' : ''}\n`;
    const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', script], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS: callsPath, DELAYS: delaysPath, RESPONSES: responsesPath, T: target },
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, exitCode, result.stderr + result.stdout);
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(calls, responses.map(() => ['stapler', 'validate', target]));
    const actualDelays = readFileSync(delaysPath, 'utf8').trim().split('\n').filter(Boolean).map(Number);
    assert.deepEqual(actualDelays, delays);
    for (const response of responses) assert.ok(result.stdout.includes(response.output), `missing original output: ${response.output}`);
    if (exitCode !== 0) assert.ok(result.stderr.includes(`stapler validate failed for ${target} (exit ${exitCode})`));
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a: first-attempt success needs one call and no delay', () => {
  run([success], { exitCode: 0 });
});

test('b: the real CloudKit -1005 failure retries and then succeeds', () => {
  const lostConnection = {
    code: 68,
    stream: 'stderr',
    output: 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." UserInfo={... NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup ...}\nThe validate action failed! Error 68.',
  };
  const result = run([lostConnection, success], { exitCode: 0, delays: [10] });
  assert.match(result.stdout, /attempt 1\/4/);
  assert.match(result.stdout, /attempt 2\/4/);
});

for (const code of [-1001, -1003, -1004, -1009]) {
  test(`c: transient ${code} retries and then succeeds`, () => {
    run([transient(code), success], { exitCode: 0, delays: [10] });
  });
}

test('d: missing ticket fails immediately with its original exit code and output', () => {
  run([missingTicket], { exitCode: 65 });
});

for (const code of [-1200, -1011, -10050]) {
  test(`e: non-listed or prefix-collision code ${code} fails immediately`, () => {
    run([transient(code)], { exitCode: 68 });
  });
}

test('e: invalid signature fails immediately', () => {
  run([{ code: 65, output: 'The code signature is invalid.' }], { exitCode: 65 });
});

test('f: exhausted transients stop after four calls and 10/20/40 delays', () => {
  run([-1001, -1003, -1004, -1005].map(transient), { exitCode: 68, delays: [10, 20, 40] });
});

test('g: a non-transient after a transient stops with the last exit code', () => {
  run([transient(-1005), missingTicket], { exitCode: 65, delays: [10] });
});

test('h: non-conditional semicolon call aborts the caller under errexit', () => {
  const result = run([missingTicket], { exitCode: 65, after: true });
  assert.doesNotMatch(result.stdout + result.stderr, /AFTER/);
});
