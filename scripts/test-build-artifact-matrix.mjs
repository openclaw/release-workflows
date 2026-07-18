#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const extractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  job, selector, value = ARGV.fetch(1), ARGV.fetch(2), ARGV.fetch(3)
  step = workflow.fetch('jobs').fetch(job).fetch('steps').find { |candidate| candidate[selector] == value }
  abort "workflow step not found: #{job} #{selector}=#{value}" unless step
  print step.fetch('run')
`;
const extractStep = (job, selector, value) => execFileSync(
  'ruby',
  ['-rpsych', '-e', extractor, workflowPath, job, selector, value],
  { encoding: 'utf8' },
);
const extractMarkedSource = (script, begin, end) => {
  const start = script.indexOf(begin);
  const finish = script.indexOf(end);
  assert.notEqual(start, -1, `missing marker: ${begin}`);
  assert.notEqual(finish, -1, `missing marker: ${end}`);
  return script.slice(start + begin.length, finish);
};

const buildModeScript = extractStep('build', 'id', 'build-mode');
const assemblerScript = extractStep('sign', 'name', 'Assemble signed archives and nFPM packages');
const inventoryScript = extractStep('draft', 'name', 'Create frozen inventory and checksums');
const verifierScript = extractStep('verify', 'name', 'Verify exact inventory, signatures, DR, and notarization');
const executeAssembler = new Function(
  'require',
  'process',
  extractMarkedSource(assemblerScript, '// artifact-assembler-begin', '// artifact-assembler-end'),
);
const executeInventoryBuilder = new Function(
  'require',
  'process',
  extractMarkedSource(inventoryScript, '// asset-inventory-builder-begin', '// asset-inventory-builder-end'),
);
const packageVerifierScript = extractMarkedSource(
  verifierScript,
  '# nfpm-checksum-verifier-begin',
  '# nfpm-checksum-verifier-end',
);

const withEnvironment = (values, callback) => {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const runBuildMode = (mode, config, configPath = '.goreleaser.yml') => {
  const root = mkdtempSync(join(tmpdir(), 'release-build-mode-'));
  try {
    mkdirSync(join(root, configPath, '..'), { recursive: true });
    writeFileSync(join(root, configPath), config);
    const output = join(root, 'github-output');
    execFileSync('/bin/bash', ['-c', buildModeScript], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output, NFPM_MODE: mode },
      stdio: 'pipe',
    });
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s, 2)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const baseArtifacts = () => [
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_darwin_amd64_v1/fixture', goos: 'darwin', goarch: 'amd64' },
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_darwin_arm64_v8.0/fixture', goos: 'darwin', goarch: 'arm64' },
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_linux_amd64_v1/fixture', goos: 'linux', goarch: 'amd64' },
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_linux_arm64_v8.0/fixture', goos: 'linux', goarch: 'arm64' },
];
const packageArtifacts = () => [
  { type: 'Linux Package', name: 'fixture_1.2.3_amd64.deb', path: 'dist/fixture_1.2.3_amd64.deb', goos: 'linux', goarch: 'amd64' },
  { type: 'Linux Package', name: 'fixture-1.2.3-1.x86_64.rpm', path: 'dist/fixture-1.2.3-1.x86_64.rpm', goos: 'linux', goarch: 'amd64' },
  { type: 'Linux Package', name: 'fixture_1.2.3_arm64.deb', path: 'dist/fixture_1.2.3_arm64.deb', goos: 'linux', goarch: 'arm64' },
  { type: 'Linux Package', name: 'fixture-1.2.3-1.aarch64.rpm', path: 'dist/fixture-1.2.3-1.aarch64.rpm', goos: 'linux', goarch: 'arm64' },
];

const runAssembler = ({ nfpm = false, mutate = () => {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifact-assembler-'));
  const originalCwd = process.cwd();
  try {
    const dist = join(root, 'dist');
    const releaseAssets = join(root, 'release-assets');
    mkdirSync(dist);
    mkdirSync(releaseAssets);
    const artifacts = baseArtifacts();
    for (const artifact of artifacts) {
      const directory = join(root, artifact.path, '..');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(root, artifact.path), `${artifact.goos}/${artifact.goarch}\n`);
      chmodSync(join(root, artifact.path), 0o755);
    }
    mkdirSync(join(dist, 'universal_darwin_all'));
    writeFileSync(join(dist, 'universal_darwin_all', 'fixture'), 'universal\n');
    mkdirSync(join(dist, 'extra-package-payload'));
    writeFileSync(join(dist, 'extra-package-payload', 'extra.txt'), 'extra\n');
    if (nfpm) {
      for (const artifact of packageArtifacts()) {
        artifacts.push(artifact);
        writeFileSync(join(root, artifact.path), `${artifact.name}\n`);
      }
    }
    mutate({ artifacts, dist, releaseAssets, root });
    writeFileSync(join(dist, 'artifacts.json'), `${JSON.stringify(artifacts)}\n`);
    writeFileSync(join(releaseAssets, 'SIGNING-MANIFEST.json'), '{}\n');
    process.chdir(root);
    withEnvironment({
      NFPM_ENABLED: nfpm ? 'true' : 'false',
      RELEASE_VERSION: '1.2.3',
      REPOSITORY_NAME: 'fixture',
    }, () => executeAssembler(require, process));
    return {
      packageMap: JSON.parse(readFileSync(join(releaseAssets, '.NFPM-PACKAGES.json'), 'utf8')),
      releaseAssets,
      root,
      targetMap: JSON.parse(readFileSync(join(releaseAssets, '.ASSET-TARGETS.json'), 'utf8')),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    process.chdir(originalCwd);
  }
};

const finishAssembler = (fixture) => rmSync(fixture.root, { recursive: true, force: true });

const writeAsset = (root, name, contents = name) => {
  const file = join(root, 'release-assets', name);
  writeFileSync(file, contents);
  return file;
};
const verifyPackages = (root) => execFileSync(
  '/bin/bash',
  ['-e', '-u', '-o', 'pipefail', '-c', packageVerifierScript],
  { cwd: join(root, 'release-assets'), encoding: 'utf8', stdio: 'pipe' },
);
const runInventory = ({ extraAssets = [], homebrew = false, packages = [], targets = [] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'release-inventory-'));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(root, 'release-assets'));
    writeAsset(root, 'RELEASE-NOTES.md', '## 1.2.3 - 2026-07-18\n\n- Fixture.\n');
    writeAsset(root, 'SIGNING-MANIFEST.json', '{}\n');
    for (const row of targets) writeAsset(root, row.name, `archive:${row.target}\n`);
    for (const row of packages) writeAsset(root, row.name, `package:${row.platform}:${row.format}\n`);
    for (const name of extraAssets) writeAsset(root, name, `extra:${name}\n`);
    const targetPath = join(root, 'targets.json');
    const packagePath = join(root, 'packages.json');
    writeFileSync(targetPath, `${JSON.stringify(targets)}\n`);
    writeFileSync(packagePath, `${JSON.stringify(packages)}\n`);
    process.chdir(root);
    withEnvironment({
      ASSET_TARGETS_PATH: targetPath,
      GITHUB_REPOSITORY: 'openclaw/fixture',
      HOMEBREW_FORMULA: homebrew ? 'fixture' : '',
      NFPM_PACKAGES_PATH: packagePath,
      TAG: 'v1.2.3',
      TARGET_SHA: 'a'.repeat(40),
    }, () => executeInventoryBuilder(require, process));
    return {
      checksums: readFileSync(join(root, 'release-assets', 'SHA256SUMS'), 'utf8'),
      inventory: JSON.parse(readFileSync(join(root, 'release-assets', 'ASSET-INVENTORY.json'), 'utf8')),
      root,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    process.chdir(originalCwd);
  }
};

const fourTargets = [
  { name: 'fixture_1.2.3_darwin_amd64.tar.gz', target: 'darwin_amd64' },
  { name: 'fixture_1.2.3_darwin_arm64.tar.gz', target: 'darwin_arm64' },
  { name: 'fixture_1.2.3_linux_amd64.tar.gz', target: 'linux_amd64' },
  { name: 'fixture_1.2.3_linux_arm64.tar.gz', target: 'linux_arm64' },
];
const fourPackages = [
  { name: 'fixture_1.2.3_amd64.deb', platform: 'linux_amd64', format: 'deb' },
  { name: 'fixture-1.2.3-1.x86_64.rpm', platform: 'linux_amd64', format: 'rpm' },
  { name: 'fixture_1.2.3_arm64.deb', platform: 'linux_arm64', format: 'deb' },
  { name: 'fixture-1.2.3-1.aarch64.rpm', platform: 'linux_arm64', format: 'rpm' },
];

const tests = [
  ['auto mode enables configured nFPMs', () => {
    const output = runBuildMode('auto', 'version: 2\nnfpms:\n  - id: packages\n');
    assert.equal(output['nfpm-enabled'], 'true');
    assert.match(output.args, /^release /);
    assert.match(output.args, /--release-notes=\/dev\/null/);
  }],
  ['auto mode preserves binary-only build', () => {
    const output = runBuildMode('auto', 'version: 2\nbuilds: []\n');
    assert.equal(output['nfpm-enabled'], 'false');
    assert.equal(output.args, 'build --config=.goreleaser.yml --clean --timeout 60m');
  }],
  ['enabled mode requires configured nFPMs', () => {
    assert.throws(() => runBuildMode('enabled', 'version: 2\nbuilds: []\n'));
  }],
  ['disabled mode overrides configured nFPMs', () => {
    const output = runBuildMode('disabled', 'version: 2\nnfpms:\n  - id: packages\n');
    assert.equal(output['nfpm-enabled'], 'false');
    assert.equal(output.args, 'build --config=.goreleaser.yml --clean --timeout 60m');
  }],
  ['empty nFPM list stays disabled', () => {
    assert.equal(runBuildMode('auto', 'version: 2\nnfpms: []\n')['nfpm-enabled'], 'false');
  }],
  ['canonical alternate config path is selected explicitly', () => {
    const output = runBuildMode('auto', 'version: 2\nnfpms:\n  - id: packages\n', '.config/goreleaser.yml');
    assert.equal(output['nfpm-enabled'], 'true');
    assert.match(output.args, /--config=\.config\/goreleaser\.yml/);
  }],
  ['archive target matrix resolves from GoReleaser metadata', () => {
    const fixture = runAssembler();
    try {
      assert.deepEqual(fixture.targetMap.map((row) => row.target).sort(), [
        'darwin_amd64', 'darwin_arm64', 'darwin_universal', 'linux_amd64', 'linux_arm64',
      ]);
      assert.deepEqual(fixture.packageMap, []);
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['nFPM package matrix copies exact artifacts and metadata', () => {
    const fixture = runAssembler({ nfpm: true });
    try {
      assert.deepEqual(fixture.packageMap, [...fourPackages].sort((a, b) => a.name.localeCompare(b.name)));
      for (const row of fourPackages) assert.equal(readFileSync(join(fixture.releaseAssets, row.name), 'utf8'), `${row.name}\n`);
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['enabled nFPM mode requires package artifacts', () => {
    assert.throws(() => runAssembler({ nfpm: true, mutate: ({ artifacts }) => artifacts.splice(4) }), /emitted no Linux Package/);
  }],
  ['disabled nFPM mode rejects unexpected package artifacts', () => {
    assert.throws(() => runAssembler({ mutate: ({ artifacts, dist }) => {
      const artifact = packageArtifacts()[0];
      artifacts.push(artifact);
      writeFileSync(join(dist, artifact.name), 'unexpected\n');
    } }), /mode is disabled/);
  }],
  ['mixed-platform archive directory fails closed', () => {
    assert.throws(() => runAssembler({ mutate: ({ artifacts }) => artifacts.push({
      type: 'Binary', name: 'other', path: 'dist/fixture_linux_amd64_v1/other', goos: 'linux', goarch: 'arm64',
    }) }), /mixes GoReleaser platforms/);
  }],
  ['colliding archive slugs fail closed', () => {
    assert.throws(() => runAssembler({ mutate: ({ dist }) => {
      mkdirSync(join(dist, 'collision+target'));
      mkdirSync(join(dist, 'collision-target'));
      writeFileSync(join(dist, 'collision+target', 'one'), 'one\n');
      writeFileSync(join(dist, 'collision-target', 'two'), 'two\n');
    } }), /duplicate release archive name/);
  }],
  ['unsafe nFPM filename fails closed', () => {
    assert.throws(() => runAssembler({ nfpm: true, mutate: ({ artifacts, dist }) => {
      const packageArtifact = artifacts.find((artifact) => artifact.type === 'Linux Package');
      const unsafe = 'fixture~1.2.3_amd64.deb';
      packageArtifact.name = unsafe;
      packageArtifact.path = `dist/${unsafe}`;
      writeFileSync(join(dist, unsafe), 'unsafe\n');
    } }), /unsafe nFPM package filename/);
  }],
  ['package outside top-level dist fails closed', () => {
    assert.throws(() => runAssembler({ nfpm: true, mutate: ({ artifacts, dist }) => {
      const packageArtifact = artifacts.find((artifact) => artifact.type === 'Linux Package');
      mkdirSync(join(dist, 'nested'));
      packageArtifact.path = `dist/nested/${packageArtifact.name}`;
      writeFileSync(join(dist, 'nested', packageArtifact.name), 'nested\n');
    } }), /top-level dist artifact/);
  }],
  ['inventory binds all nFPM packages and checksums', () => {
    const fixture = runInventory({ targets: fourTargets, packages: fourPackages });
    try {
      assert.match(verifyPackages(fixture.root), /verified nFPM package payloads/);
      const packagePayloads = fixture.inventory.payloads.filter((payload) => payload.kind === 'nfpm');
      assert.equal(packagePayloads.length, 4);
      for (const payload of packagePayloads) {
        assert.match(payload.sha256, /^[0-9a-f]{64}$/);
        assert.match(payload.platform, /^linux_(?:amd64|arm64)$/);
        assert.ok(['deb', 'rpm'].includes(payload.packageFormat));
        assert.match(fixture.checksums, new RegExp(`^[0-9a-f]{64}  ${payload.name.replaceAll('.', '\\.')}$`, 'm'));
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['binary-only inventory remains backward compatible', () => {
    const fixture = runInventory({ targets: fourTargets });
    try {
      assert.equal(fixture.inventory.payloads.some((payload) => 'kind' in payload), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['unmapped package file fails closed', () => {
    assert.throws(() => runInventory({ extraAssets: ['unmapped.deb'] }), /unmapped nFPM package asset/);
  }],
  ['duplicate package metadata fails closed', () => {
    assert.throws(() => runInventory({ packages: [fourPackages[0], fourPackages[0]] }), /duplicate inventory asset name/);
  }],
  ['package extension and format must agree', () => {
    assert.throws(() => runInventory({ packages: [{ ...fourPackages[0], format: 'rpm' }] }), /invalid row/);
  }],
  ['verifier rejects a package missing inventory metadata', () => {
    const fixture = runInventory({ packages: fourPackages });
    try {
      const inventoryPath = join(fixture.root, 'release-assets', 'ASSET-INVENTORY.json');
      const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      delete inventory.payloads.find((payload) => payload.kind === 'nfpm').kind;
      writeFileSync(inventoryPath, `${JSON.stringify(inventory)}\n`);
      assert.throws(() => verifyPackages(fixture.root));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['verifier rejects an extra raw package file', () => {
    const fixture = runInventory({ packages: fourPackages });
    try {
      writeAsset(fixture.root, 'unattested.deb', 'unattested\n');
      assert.throws(() => verifyPackages(fixture.root), /Command failed/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['Homebrew target matrix coexists with nFPM packages', () => {
    const fixture = runInventory({ homebrew: true, targets: fourTargets, packages: fourPackages });
    try {
      assert.equal(fixture.inventory.payloads.filter((payload) => payload.kind === 'nfpm').length, 4);
      assert.equal(fixture.inventory.payloads.filter((payload) => payload.target).length, 4);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['Homebrew target matrix still fails when an archive is missing', () => {
    assert.throws(() => runInventory({ homebrew: true, targets: fourTargets.slice(0, 3), packages: fourPackages }), /requires exactly one GoReleaser archive/);
  }],
];

for (const [name, test] of tests) {
  test();
  console.log(`PASS ${name}`);
}
console.log(`build artifact matrix tests passed (${tests.length} scenarios)`);
