#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const extractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  job, name = ARGV.fetch(1), ARGV.fetch(2)
  step = workflow.fetch('jobs').fetch(job).fetch('steps').find { |candidate| candidate['name'] == name }
  abort "workflow step not found: #{job} #{name}" unless step
  print step.fetch('run')
`;
const extractStep = (job, name) => execFileSync(
  'ruby',
  ['-rpsych', '-e', extractor, workflowPath, job, name],
  { encoding: 'utf8' },
);

const inputScript = extractStep('validate', 'Validate inputs');
const signedTagScript = extractStep('validate', 'Verify required SSH-signed tag');
const publishSignedTagScript = extractStep('publish', 'Reverify required SSH-signed tag before publication');

const runInputs = (overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'release-policy-inputs-'));
  const output = join(root, 'github-output');
  try {
    execFileSync('/bin/bash', ['-c', inputScript], {
      cwd: root,
      env: {
        ...process.env,
        ARCHIVE_FILES: '[]',
        BUILD_RUNNER: 'ubuntu',
        CHECKSUM_FILENAME: 'SHA256SUMS',
        CI_CHECK_EVENTS: '[]',
        DARWIN_UNIVERSAL: 'auto',
        EXTRA_PACKAGES: '[]',
        GITHUB_OUTPUT: output,
        HOMEBREW_FORMULA: '',
        HOMEBREW_TAP: '',
        NFPM_MODE: 'auto',
        REPRODUCIBLE_REBUILD: 'disabled',
        REPOSITORY_TYPE: 'openclaw',
        SPLIT_GORELEASER_CONFIG: '',
        STABLE_IDENTIFIER: '',
        VERSION: '1.2.3',
        ...overrides,
      },
      stdio: 'pipe',
    });
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s, 2)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const makeSignedTagFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'release-signed-tag-'));
  const source = join(root, 'source');
  const origin = join(root, 'origin.git');
  const key = join(root, 'signing-key');
  mkdirSync(source);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  mkdirSync(join(source, '.github'));
  writeFileSync(join(source, '.github', 'release-allowed-signers'), `release@example.com ${publicKey}\n`);
  writeFileSync(join(source, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: source });
  const git = (args) => execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.com', ...args], { cwd: source });
  git(['commit', '-qm', 'fixture']);
  git(['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'tag', '-s', '-m', 'signed', 'v1.2.3']);
  git(['tag', '-a', '-m', 'unsigned', 'v1.2.4']);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: source });
  execFileSync('git', ['push', '-q', 'origin', 'main', 'refs/tags/v1.2.3', 'refs/tags/v1.2.4'], { cwd: source });
  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  return { origin, root, targetSha };
};

const runSignedTagPolicy = (fixture, tag, mutate = () => {}) => {
  const checkout = join(fixture.root, `checkout-${tag.replaceAll('.', '-')}-${Math.random().toString(16).slice(2)}`);
  execFileSync('git', ['clone', '-q', '--no-tags', '--branch', 'main', fixture.origin, checkout]);
  execFileSync('git', ['fetch', '-q', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: checkout });
  mutate(checkout);
  execFileSync('/bin/bash', ['-c', signedTagScript], {
    cwd: checkout,
    env: { ...process.env, TAG: tag, TARGET_SHA: fixture.targetSha },
    stdio: 'pipe',
  });
};

const tests = [
  ['optional defaults preserve current input behavior', () => {
    const output = runInputs();
    assert.equal(output.tag, 'v1.2.3');
    assert.equal(output['homebrew-tap'], 'openclaw/homebrew-tap');
  }],
  ['reverse-DNS stable identifier is accepted', () => {
    runInputs({ STABLE_IDENTIFIER: 'ai.openclaw.telecrawl' });
  }],
  ['invalid stable identifiers fail closed', () => {
    for (const value of ['openclaw', 'ai..telecrawl', '-ai.openclaw.telecrawl', 'ai.openclaw.telecrawl_']) {
      assert.throws(() => runInputs({ STABLE_IDENTIFIER: value }));
    }
  }],
  ['Darwin universal mode is tri-state', () => {
    for (const value of ['auto', 'enabled', 'disabled']) runInputs({ DARWIN_UNIVERSAL: value });
    assert.throws(() => runInputs({ DARWIN_UNIVERSAL: 'sometimes' }));
  }],
  ['reproducible rebuild defaults off and rejects unverifiable Darwin mode', () => {
    runInputs({ REPRODUCIBLE_REBUILD: 'disabled' });
    runInputs({ REPRODUCIBLE_REBUILD: 'non-darwin' });
    assert.throws(() => runInputs({ REPRODUCIBLE_REBUILD: 'all' }));
    assert.throws(() => runInputs({ REPRODUCIBLE_REBUILD: 'sometimes' }));
  }],
  ['split-host config requires a safe path and binary-only package mode', () => {
    runInputs({ NFPM_MODE: 'disabled', SPLIT_GORELEASER_CONFIG: '.goreleaser-linux-windows.yml' });
    for (const value of ['/tmp/config.yml', '../config.yml', 'configs/../config.yml', 'config\\windows.yml']) {
      assert.throws(() => runInputs({ NFPM_MODE: 'disabled', SPLIT_GORELEASER_CONFIG: value }));
    }
    assert.throws(() => runInputs({ NFPM_MODE: 'auto', SPLIT_GORELEASER_CONFIG: 'split.yml' }));
  }],
  ['CI check events accept unique Actions event names', () => {
    runInputs({ CI_CHECK_EVENTS: '["push","pull_request"]' });
    for (const value of ['["push","push"]', '["pull-request"]', '["Push"]', '{}']) {
      assert.throws(() => runInputs({ CI_CHECK_EVENTS: value }));
    }
  }],
  ['checksum filename accepts safe basenames and rejects paths or hidden names', () => {
    for (const value of ['SHA256SUMS', 'checksums.txt', 'sha256-sums_1.txt']) {
      runInputs({ CHECKSUM_FILENAME: value });
    }
    for (const value of [
      '.checksums', 'checksums.txt.', '../checksums.txt', 'nested/checksums.txt', 'checksums\\windows.txt', '',
      'ASSET-INVENTORY.json', 'release-notes.md', 'SIGNING-MANIFEST.json',
      'NUL', 'CON.txt', 'com1',
    ]) {
      assert.throws(() => runInputs({ CHECKSUM_FILENAME: value }));
    }
  }],
  ['archive files require safe relative paths and unique basenames', () => {
    runInputs({ ARCHIVE_FILES: '["CHANGELOG.md","docs/LICENSE"]' });
    for (const value of [
      '["/README.md"]', '["../README.md"]', '["-docs/README.md"]',
      '["a/README.md","b/README.md"]', '["a/README.md","b/readme.md"]',
      '["docs/NUL"]', '["docs/README."]',
    ]) {
      assert.throws(() => runInputs({ ARCHIVE_FILES: value }));
    }
  }],
  ['allowed SSH-signed tag is accepted', () => {
    const fixture = makeSignedTagFixture();
    try {
      runSignedTagPolicy(fixture, 'v1.2.3');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['publication repeats the exact signed-tag policy', () => {
    assert.equal(publishSignedTagScript, signedTagScript);
  }],
  ['unsigned annotated tag is rejected', () => {
    const fixture = makeSignedTagFixture();
    try {
      assert.throws(() => runSignedTagPolicy(fixture, 'v1.2.4'));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['missing allowed-signers policy is rejected', () => {
    const fixture = makeSignedTagFixture();
    try {
      assert.throws(() => runSignedTagPolicy(fixture, 'v1.2.3', (checkout) => {
        rmSync(join(checkout, '.github', 'release-allowed-signers'));
      }));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
];

for (const [name, test] of tests) {
  test();
  console.log(`PASS ${name}`);
}
console.log(`Go CLI policy input tests passed (${tests.length} scenarios)`);
