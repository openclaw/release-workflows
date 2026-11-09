#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow();
const extractStep = (job, name) => workflowStep(workflow, job, 'name', name).run;

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
  const home = join(root, 'home');
  mkdirSync(home);
  const globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '');
  // Fixture commits and tags must never use an operator's config or signing agent.
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GNUPGHOME: home,
    TMPDIR: root, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C',
  };
  const git = (args, cwd = source, input) => execFileSync('git', [
    '-c', 'user.name=Release Test', '-c', 'user.email=release@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
  ], { cwd, env, input, encoding: 'utf8', stdio: 'pipe' });
  mkdirSync(source);
  git(['init', '-q', '-b', 'main']);
  for (const file of [key, `${key}-other`]) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release@example.com', '-f', file], { env });
  }
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  const otherPublicKey = readFileSync(`${key}-other.pub`, 'utf8').trim();
  mkdirSync(join(source, '.github'));
  writeFileSync(join(source, '.github', 'release-allowed-signers'), `release@example.com ${publicKey}\n`);
  writeFileSync(join(source, 'README.md'), 'fixture\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  git(['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'tag', '-s', '-m', 'signed', 'v1.2.3']);
  git(['tag', '-a', '-m', 'unsigned', 'v1.2.4']);
  git(['tag', 'v1.2.5']);
  git(['init', '-q', '--bare', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'main', '--tags']);
  const targetSha = git(['rev-parse', 'HEAD']).trim();
  return { env, git, key, origin, otherPublicKey, publicKey, root, targetSha };
};

const runSignedTagPolicy = (fixture, script, tag = 'v1.2.3', mutate = () => ({})) => {
  const checkout = join(fixture.root, `checkout-${tag.replaceAll('.', '-')}-${Math.random().toString(16).slice(2)}`);
  fixture.git(['clone', '-q', '--no-tags', '--branch', 'main', fixture.origin, checkout]);
  fixture.git(['fetch', '-q', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], checkout);
  const expected = fixture.git(['rev-parse', `refs/tags/${tag}`], checkout).trim();
  const overrides = mutate(checkout, fixture) ?? {};
  execFileSync('/bin/bash', ['-c', script], {
    cwd: checkout,
    env: { ...fixture.env, TAG: tag, TARGET_SHA: fixture.targetSha, EXPECTED_TAG_OBJECT: expected, ...overrides },
    stdio: 'pipe',
  });
};

const withSignedTagFixture = (test) => {
  const fixture = makeSignedTagFixture();
  try {
    for (const script of [signedTagScript, publishSignedTagScript]) test(fixture, script);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
};

const replaceTag = (checkout, fixture, transform) => {
  const raw = fixture.git(['cat-file', 'tag', 'refs/tags/v1.2.3'], checkout);
  const object = fixture.git(['hash-object', '-t', 'tag', '-w', '--stdin'], checkout, transform(raw)).trim();
  fixture.git(['update-ref', 'refs/tags/v1.2.3', object], checkout);
  return { EXPECTED_TAG_OBJECT: object };
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
  ['allowed SSH-signed tag is accepted by both gates', () => withSignedTagFixture((fixture, script) => {
    runSignedTagPolicy(fixture, script);
  })],
  ['publication repeats the exact signed-tag policy', () => {
    assert.equal(publishSignedTagScript, signedTagScript);
  }],
  ['unsigned and lightweight tags are rejected by both gates', () => withSignedTagFixture((fixture, script) => {
    for (const tag of ['v1.2.4', 'v1.2.5']) assert.throws(() => runSignedTagPolicy(fixture, script, tag));
  })],
  ['missing policy, unlisted key and wrong namespace are rejected', () => withSignedTagFixture((fixture, script) => {
    for (const policy of [null, `release@example.com ${fixture.otherPublicKey}\n`, `release@example.com namespaces="file" ${fixture.publicKey}\n`]) {
      assert.throws(() => runSignedTagPolicy(fixture, script, 'v1.2.3', (checkout) => {
        const path = join(checkout, '.github', 'release-allowed-signers');
        if (policy === null) rmSync(path);
        else writeFileSync(path, policy);
      }));
    }
  })],
  ['tampered signed payload fails real cryptographic verification', () => withSignedTagFixture((fixture, script) => {
    assert.throws(() => runSignedTagPolicy(fixture, script, 'v1.2.3', (checkout) =>
      replaceTag(checkout, fixture, (raw) => raw.replace('\nsigned\n', '\ntampered\n'))));
  })],
  ['replacement signed object at the same commit is rejected', () => withSignedTagFixture((fixture, script) => {
    assert.throws(() => runSignedTagPolicy(fixture, script, 'v1.2.3', (checkout) => {
      fixture.git(['-c', 'gpg.format=ssh', '-c', `user.signingkey=${fixture.key}`, 'tag', '-fs', '-m', 'replacement', 'v1.2.3'], checkout);
    }));
  })],
  ['wrong frozen target is rejected', () => withSignedTagFixture((fixture, script) => {
    assert.throws(() => runSignedTagPolicy(fixture, script, 'v1.2.3', () => ({ TARGET_SHA: 'f'.repeat(40) })));
  })],
  ['non-SSH armor and trailing data fail before any non-SSH verifier runs', () => withSignedTagFixture((fixture, script) => {
    const marker = join(fixture.root, 'non-ssh-verifier-called');
    const verifier = join(fixture.root, 'non-ssh-verifier');
    writeFileSync(verifier, '#!/bin/sh\nprintf called > "$GPG_CALL_LOG"\nexit 97\n', { mode: 0o755 });
    for (const transform of [
      (raw) => raw.replace(/-----BEGIN SSH SIGNATURE-----[\s\S]*/, '-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n'),
      (raw) => raw.replace(/-----BEGIN SSH SIGNATURE-----[\s\S]*/, '-----BEGIN SIGNED MESSAGE-----\nfixture\n-----END SIGNED MESSAGE-----\n'),
      (raw) => `${raw}-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n`,
      (raw) => `${raw}trailing data\n`,
    ]) {
      assert.throws(() => runSignedTagPolicy(fixture, script, 'v1.2.3', (checkout) => {
        fixture.git(['config', 'gpg.program', verifier], checkout);
        fixture.git(['config', 'gpg.x509.program', verifier], checkout);
        return { ...replaceTag(checkout, fixture, transform), GPG_CALL_LOG: marker };
      }));
      assert.equal(existsSync(marker), false, 'format admission must precede verifier dispatch');
    }
  })],
];

let failures = 0;
for (const [name, test] of tests) {
  try {
    test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
assert.equal(failures, 0);
console.log(`Go CLI policy input tests passed (${tests.length} scenarios)`);
