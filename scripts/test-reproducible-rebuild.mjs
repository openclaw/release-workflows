#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const extractor = String.raw`
  workflow = Psych.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false)
  step = workflow.fetch('jobs').fetch('compare').fetch('steps').find { |candidate| candidate['name'] == 'Require byte-identical independent rebuild' }
  abort 'reproducible rebuild step not found' unless step
  print step.fetch('run')
`;
const script = execFileSync('ruby', ['-rpsych', '-e', extractor, workflowPath], { encoding: 'utf8' });
const begin = '// reproducible-rebuild-verifier-begin';
const end = '// reproducible-rebuild-verifier-end';
const start = script.indexOf(begin);
const finish = script.indexOf(end);
assert.notEqual(start, -1);
assert.notEqual(finish, -1);
const verify = new Function('require', 'process', script.slice(start + begin.length, finish));

const targets = [
  ['linux', 'amd64', 'fixture'],
  ['linux', 'arm64', 'fixture'],
  ['windows', 'amd64', 'fixture.exe'],
  ['windows', 'arm64', 'fixture.exe'],
];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'release-reproducible-rebuild-'));
  const source = join(root, 'reproducible-source');
  const release = join(root, 'release-assets');
  mkdirSync(join(source, 'dist'), { recursive: true });
  mkdirSync(release);
  const artifacts = [];
  const binaryRows = [];
  const targetRows = [];
  for (const [goos, goarch, binary] of targets) {
    const target = `${goos}_${goarch}`;
    const binaryPath = join(source, 'dist', `fixture_${target}`, binary);
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, `reproducible:${target}\n`);
    chmodSync(binaryPath, 0o755);
    artifacts.push({ type: 'Binary', name: binary, path: `dist/fixture_${target}/${binary}`, goos, goarch });
    const archiveName = `fixture_1.2.3_${target}.${goos === 'windows' ? 'zip' : 'tar.gz'}`;
    const staging = join(root, `staging-${target}`);
    mkdirSync(staging);
    writeFileSync(join(staging, binary), `reproducible:${target}\n`);
    if (goos === 'windows') {
      execFileSync('zip', ['-q', join(release, archiveName), binary], { cwd: staging });
    } else {
      execFileSync('tar', ['-czf', join(release, archiveName), binary], { cwd: staging });
    }
    targetRows.push({ name: archiveName, target });
    binaryRows.push({ target, archive: archiveName, member: binary });
  }
  writeFileSync(join(source, 'dist', 'artifacts.json'), `${JSON.stringify(artifacts)}\n`);
  writeFileSync(join(release, '.ASSET-TARGETS.json'), `${JSON.stringify(targetRows)}\n`);
  writeFileSync(join(release, '.ASSET-BINARIES.json'), `${JSON.stringify(binaryRows)}\n`);
  return { root, source };
};

const run = (mutate = () => {}) => {
  const test = fixture();
  const previousCwd = process.cwd();
  const previous = new Map();
  const environment = {
    GITHUB_REPOSITORY: 'openclaw/fixture',
    GO_VERSION: 'go1.26.5',
    GORELEASER_VERSION: '2.17.1',
    REPRODUCIBLE_REBUILD: 'non-darwin',
    REPRODUCIBLE_REBUILD_PROOF: join(test.root, 'proof.json'),
    TAG: 'v1.2.3',
    TARGET_SHA: 'a'.repeat(40),
  };
  try {
    mutate(test);
    for (const [key, value] of Object.entries(environment)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    process.chdir(test.root);
    verify(require, process);
    return JSON.parse(readFileSync(environment.REPRODUCIBLE_REBUILD_PROOF, 'utf8'));
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(test.root, { recursive: true, force: true });
  }
};

const proof = run();
assert.equal(proof.mode, 'non-darwin');
assert.deepEqual(proof.targets.map((row) => row.target), [
  'linux_amd64', 'linux_arm64', 'windows_amd64', 'windows_arm64',
]);
assert.ok(proof.targets.every((row) => row.stagedSha256 === row.rebuiltSha256));
console.log('PASS all four non-Darwin staged binaries match an independent rebuild');

assert.throws(() => run(({ source }) => {
  writeFileSync(join(source, 'dist', 'fixture_linux_amd64', 'fixture'), 'different bytes\n');
}), /reproducible rebuild mismatch for linux_amd64/);
console.log('PASS a single-byte-independent mismatch fails closed');

assert.throws(() => run(({ root }) => {
  const manifest = join(root, 'release-assets', '.ASSET-BINARIES.json');
  const rows = JSON.parse(readFileSync(manifest, 'utf8'));
  rows.push({
    target: 'linux_amd64',
    archive: 'fixture_1.2.3_linux_amd64.tar.gz',
    member: 'extra',
  });
  writeFileSync(manifest, `${JSON.stringify(rows)}\n`);
}), /binary set differs/);
console.log('PASS an omitted staged binary fails exact-set comparison');

const aliasProof = run(({ source }) => {
  const manifest = join(source, 'dist', 'artifacts.json');
  const artifacts = JSON.parse(readFileSync(manifest, 'utf8'));
  artifacts.push({ ...artifacts.find((artifact) => artifact.path === 'dist/fixture_linux_amd64/fixture') });
  writeFileSync(manifest, `${JSON.stringify(artifacts)}\n`);
});
assert.equal(aliasProof.targets.length, 4);
console.log('PASS duplicate GoReleaser aliases for one physical binary are deduplicated');

assert.throws(() => run(({ root }) => {
  const archive = join(root, 'release-assets', 'fixture_1.2.3_linux_amd64.tar.gz');
  const staging = join(root, 'unsafe-staging');
  mkdirSync(staging);
  writeFileSync(join(staging, 'fixture'), 'reproducible:linux_amd64\n');
  writeFileSync(join(staging, '--checkpoint-action=echo'), 'unsafe\n');
  execFileSync('tar', ['-czf', archive, '--', 'fixture', '--checkpoint-action=echo'], { cwd: staging });
}), /unsafe archive member/);
console.log('PASS option-like archive members fail before extraction');

assert.throws(() => run(({ root }) => {
  const manifest = join(root, 'release-assets', '.ASSET-BINARIES.json');
  const rows = JSON.parse(readFileSync(manifest, 'utf8'));
  rows.find((row) => row.target === 'windows_amd64').member = 'fixture*.exe';
  writeFileSync(manifest, `${JSON.stringify(rows)}\n`);
}), /staged binary manifest contains an invalid row/);
console.log('PASS ZIP wildcard member names are rejected before extraction');

console.log('reproducible rebuild tests passed (6 scenarios)');
