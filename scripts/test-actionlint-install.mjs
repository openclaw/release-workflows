#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow('ci.yml');
const install = workflowStep(workflow, 'validate', 'name', 'Install actionlint');
const steps = workflow.jobs.validate.steps;
const setupGo = steps.find(step => step.uses?.startsWith('actions/setup-go@'));
assert.equal(setupGo.uses, 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e');
assert.deepEqual(setupGo.with, { 'go-version': '1.27.3', cache: false });
assert.ok(steps.indexOf(setupGo) < steps.indexOf(install));
assert.equal(install.env.ACTIONLINT_COMMIT, '011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7');
assert.equal(install.env.ACTIONLINT_VERSION, 'v1.7.13-0.20260419144658-011a6d15e749');
assert.equal(workflowStep(workflow, 'validate', 'name', 'Validate workflows').run, 'scripts/validate-workflows.sh');
assert.deepEqual(workflow.permissions, { contents: 'read' });
assert.deepEqual(process.argv.slice(2), process.argv.includes('--installer-only') ? ['--installer-only'] : []);

const root = mkdtempSync(join(tmpdir(), 'actionlint-install-'));
const run = (command, args, options = {}) => spawnSync(command, args, {
  encoding: 'utf8', timeout: 30000, ...options,
});
const success = result => assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}${result.stderr}`);
try {
  const tools = join(root, 'tools');
  mkdirSync(tools);
  const binary = join(root, 'actionlint');
  writeFileSync(binary, '#!/bin/bash\n[ "$INSTALL_CASE" != version-failure ] || exit 3\nprintf "%s\\n" "$REPORTED_VERSION" "installed from fixture"\n');
  chmodSync(binary, 0o755);
  writeFileSync(join(tools, 'go'), `#!/bin/bash
set -eu
printf '%s\\n' "$@" > "$INSTALL_ARGS"
[ "$INSTALL_CASE" != install-failure ] || exit 2
[ "$INSTALL_CASE" != missing-binary ] || exit 0
mkdir -p "$GOBIN"
cp "$FIXTURE_BINARY" "$GOBIN/actionlint"
`);
  chmodSync(join(tools, 'go'), 0o755);
  for (const kind of ['success', 'install-failure', 'missing-binary', 'version-failure', 'wrong-version', 'empty-version']) {
    const runner = join(root, kind);
    mkdirSync(runner);
    const pathFile = join(runner, 'path');
    const argsFile = join(runner, 'args');
    writeFileSync(pathFile, 'existing-path\n');
    const result = run('/bin/bash', ['--noprofile', '--norc', '-c', install.run], { env: {
      ...process.env, ...install.env, PATH: `${tools}:${process.env.PATH}`,
      RUNNER_TEMP: runner, GITHUB_PATH: pathFile, INSTALL_CASE: kind,
      INSTALL_ARGS: argsFile, FIXTURE_BINARY: binary,
      REPORTED_VERSION: kind === 'wrong-version' ? '1.7.12' : kind === 'empty-version' ? '' : install.env.ACTIONLINT_VERSION,
    } });
    assert.equal(readFileSync(argsFile, 'utf8'), `install\ngithub.com/rhysd/actionlint/cmd/actionlint@${install.env.ACTIONLINT_COMMIT}\n`);
    if (kind === 'success') success(result);
    else assert.notEqual(result.status, 0, `${kind} must fail before PATH admission`);
    assert.equal(readFileSync(pathFile, 'utf8'), `existing-path\n${kind === 'success' ? join(runner, 'actionlint-bin') + '\n' : ''}`, kind);
  }
  console.log('actionlint production installer passed six admission cases');
  if (!process.argv.includes('--installer-only')) {
    const version = run('actionlint', ['-version']);
    success(version);
    assert.equal(version.stdout.split('\n')[0], install.env.ACTIONLINT_VERSION);
    success(run('shellcheck', ['--version']));
    // Exceed the pipe buffer and preserve a diagnostic at the very end of each input.
    const padding = '          # external checker stdin regression\n'.repeat(4096);
    const fixture = join(root, 'large.yml');
    const writeWorkflow = tail => writeFileSync(fixture, `name: Large shell input
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
${padding}          printf '%s\\n' "complete"
      - run: |
${padding}          ${tail}
`);
    writeWorkflow('printf \'%s\\n\' "complete"');
    success(run('actionlint', ['-color', fixture]));
    writeWorkflow('echo $GITHUB_SHA');
    const diagnostic = run('actionlint', ['-color', fixture]);
    assert.equal(diagnostic.status, 1, `${diagnostic.error ?? ''}\n${diagnostic.stdout}${diagnostic.stderr}`);
    assert.match(diagnostic.stdout, /SC2086/);
    console.log('actionlint completed concurrent large scripts and preserved the trailing ShellCheck diagnostic');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
