#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

for (const archetype of ['swift-cli', 'electron']) {
  const workflow = loadWorkflow(`release-${archetype}.yml`);
  const inputs = workflowStep(workflow, 'validate', 'name', 'Validate inputs');
  const defaults = Object.fromEntries(Object.entries(inputs.env).map(([name, expression]) => {
    const input = expression.match(/^\$\{\{ inputs\.(.+) \}\}$/)[1];
    return [name, String(workflow.true.workflow_call.inputs[input].default ?? '')];
  }));
  const collisions = ['ASSET-INVENTORY.json', 'release-notes.md'];
  if (archetype === 'swift-cli') collisions.push('SIGNING-MANIFEST.json', defaults.MACOS_ARCHIVE_NAME, defaults.LINUX_ARCHIVE_NAME.toUpperCase());
  for (const filename of ['SHA256SUMS', 'checksums.txt', ...collisions]) {
    test(`${archetype} checksum input ${filename}`, () => {
      const root = mkdtempSync(path.join(tmpdir(), 'checksum-input-'));
      try {
        const result = spawnSync('/bin/bash', ['-c', inputs.run], {
          cwd: root, encoding: 'utf8',
          env: {
            PATH: process.env.PATH, ...defaults, VERSION: '1.2.3', REPOSITORY_TYPE: 'openclaw',
            PRODUCT_NAME: 'Fixture', BUNDLE_IDENTIFIER: 'org.example.fixture',
            CHECKSUM_FILENAME: filename, GITHUB_OUTPUT: path.join(root, 'output'),
          },
        });
        if (collisions.includes(filename)) {
          assert.notEqual(result.status, 0, 'checksum output must not overwrite a release asset');
          assert.match(result.stderr, /checksum-filename collides/);
          assert.ok(!existsSync(path.join(root, 'output')), 'invalid inputs must not emit release outputs');
        } else assert.equal(result.status, 0, result.stderr);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

const assembly = workflowStep(loadWorkflow('release-electron.yml'), 'assemble', 'name', 'Assemble inventory and checksum manifest').run;
for (const filename of ['checksums.txt', 'server.tar.gz', 'SERVER.TAR.GZ']) {
  test(`Electron assembly preserves payload with checksum ${filename}`, { skip: process.platform !== 'linux' }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'checksum-assembly-'));
    try {
      mkdirSync(path.join(root, 'inputs')); mkdirSync(path.join(root, 'notes'));
      writeFileSync(path.join(root, 'inputs', 'server.tar.gz'), 'synthetic server archive');
      writeFileSync(path.join(root, 'notes', 'RELEASE-NOTES.md'), 'Synthetic release notes.\n');
      const result = spawnSync('/bin/bash', ['-c', assembly], {
        cwd: root, encoding: 'utf8',
        env: { PATH: process.env.PATH, RUNNER_TEMP: root, CHECKSUM_FILENAME: filename, TAG: 'v1.2.3', TARGET_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'openclaw/fixture' },
      });
      if (filename === 'checksums.txt') {
        assert.equal(result.status, 0, result.stderr);
        const manifest = readFileSync(path.join(root, 'release-assets', filename), 'utf8');
        assert.match(manifest, /^[a-f0-9]{64}  server\.tar\.gz$/m);
        assert.ok(existsSync(path.join(root, 'electron-release-assets.tar.gz')));
      } else {
        assert.notEqual(result.status, 0, 'assembly must reject checksum/payload collisions');
        assert.match(result.stderr, /checksum-filename collides/);
        assert.ok(!existsSync(path.join(root, 'electron-release-assets.tar.gz')));
      }
      assert.equal(readFileSync(path.join(root, 'release-assets', 'server.tar.gz'), 'utf8'), 'synthetic server archive');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
