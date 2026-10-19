#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow('release-swift-cli.yml');
const prepare = workflowStep(workflow, 'build-linux', 'name', 'Resolve and patch SwiftPM dependencies').run;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'swift-git-owner-')));
try {
  const workspace = join(root, 'checkout with spaces');
  const unrelated = join(root, 'unrelated');
  const home = join(root, 'home');
  const tools = join(root, 'tools');
  for (const dir of [workspace, unrelated, home, tools]) mkdirSync(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GITHUB_WORKSPACE: workspace,
    PATH: `${tools}:${process.env.PATH}`,
  });
  const run = (command, args, cwd = workspace, runEnv = env) =>
    spawnSync(command, args, { cwd, env: runEnv, encoding: 'utf8' });
  const success = result => assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const cwd of [workspace, unrelated]) {
    success(run('git', ['init', '-q'], cwd));
    writeFileSync(join(cwd, 'Package.resolved'), '{"pins":[]}\n');
    success(run('git', ['add', 'Package.resolved'], cwd));
    success(run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], cwd));
  }
  env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  const before = run('git', ['diff', '--exit-code', '--', 'Package.resolved']);
  assert.equal(before.status, 129, 'fixture must reproduce the failing release diff');
  assert.match(run('git', ['status', '--short']).stderr, /dubious ownership/);

  // Execute the production shell without installing packages or resolving real dependencies.
  for (const tool of ['apt-get', 'swift']) {
    writeFileSync(join(tools, tool), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  const caller = join(tools, 'caller');
  writeFileSync(caller, '#!/bin/bash\nset -eu\ngit diff --exit-code -- Package.resolved\n', { mode: 0o755 });
  env.GENERATE_VERSION_SCRIPT = caller;
  env.PREPARE_SCRIPT = caller;
  success(run('bash', ['-c', prepare]));
  assert.deepEqual(run('git', ['config', '--global', '--get-all', 'safe.directory']).stdout.trim().split('\n'),
    [workspace], 'trust must name only the exact checkout');
  success(run('git', ['diff', '--exit-code', '--', 'Package.resolved']));
  writeFileSync(join(workspace, 'Package.resolved'), '{"pins":["changed"]}\n');
  assert.equal(run('git', ['diff', '--exit-code', '--', 'Package.resolved']).status, 1,
    'lockfile drift must still fail');
  const other = run('git', ['diff', '--exit-code', '--', 'Package.resolved'], unrelated);
  assert.notEqual(other.status, 0, 'unrelated checkouts must remain untrusted');
  assert.match(run('git', ['status', '--short'], unrelated).stderr, /dubious ownership/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('Swift Linux checkout ownership regression passed');
