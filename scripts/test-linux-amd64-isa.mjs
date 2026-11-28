#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow();
const build = workflow.jobs['build-split'];
const rebuild = workflow.jobs.rebuild;
assert.equal(build['runs-on'], 'ubuntu-24.04');
assert.match(rebuild['runs-on'], /split-goreleaser-config != '' && 'ubuntu-24.04'/);
assert.equal(
  workflowStep(workflow, 'build-split', 'name', 'Install fixed cross-compilers').run,
  workflowStep(workflow, 'rebuild', 'name', 'Install fixed cross-compilers for split rebuild').run,
);
const gate = workflowStep(workflow, 'build-split', 'name', 'Verify Linux amd64 baseline ISA');
const rebuildGate = workflowStep(workflow, 'rebuild', 'name', 'Verify Linux amd64 baseline ISA');
assert.equal(gate.run, rebuildGate.run);
assert.equal(gate.if, undefined);
assert.equal(rebuildGate.if, "inputs.reproducible-rebuild != 'disabled' && inputs.split-goreleaser-config != ''");
assert.equal(rebuildGate['working-directory'], 'reproducible-source');
assert.ok(build.steps.indexOf(gate) < build.steps.findIndex((step) => step.name === 'Upload raw split matrix'));
assert.ok(rebuild.steps.indexOf(rebuildGate) < rebuild.steps.findIndex((step) => step.name === 'Upload raw independent rebuild'));

// Use actual ELF notes, so the regression exercises readelf rather than a mock.
// Exclude host startup objects: their own ISA notes must not taint the fixtures.
const root = mkdtempSync(join(tmpdir(), 'linux-amd64-isa-'));
mkdirSync(join(root, 'dist'));
writeFileSync(join(root, 'fixture.c'), 'int main(void) { return 0; }\n');
for (const level of ['baseline', 'v2', 'v3', 'v4']) {
  execFileSync('gcc', ['fixture.c', '-nostdlib', '-Wl,-e,main', '-o', `dist/${level}`, `-Wl,-z,x86-64-${level}`], { cwd: root });
}
const run = (binary) => {
  writeFileSync(join(root, 'dist/artifacts.json'), JSON.stringify(binary ? [
    { type: 'Binary', goos: 'linux', goarch: 'amd64', path: `dist/${binary}` },
    { type: 'Binary', goos: 'linux', goarch: 'arm64', path: 'not-an-x86-ELF' },
  ] : []));
  return spawnSync('bash', ['-c', gate.run], { cwd: root, encoding: 'utf8' });
};
assert.equal(run('baseline').status, 0);
for (const level of ['v2', 'v3', 'v4']) {
  const result = run(level);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported x86 ISA needed/);
}
assert.equal(run().status, 0); // Windows/arm64-only split configurations remain valid.
assert.notEqual(run('missing').status, 0);
writeFileSync(join(root, 'dist/invalid'), 'not an ELF\n');
assert.notEqual(run('invalid').status, 0);
console.log('PASS matched CGO runners and baseline-only ELF gate (v2/v3/v4, missing and invalid ELF rejected)');
