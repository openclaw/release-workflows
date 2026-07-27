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

const binaryArtifacts = () => [
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_darwin_amd64_v1/fixture', goos: 'darwin', goarch: 'amd64' },
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_darwin_arm64_v8.0/fixture', goos: 'darwin', goarch: 'arm64' },
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_linux_amd64_v1/fixture', goos: 'linux', goarch: 'amd64' },
  { type: 'Binary', name: 'fixture', path: 'dist/fixture_linux_arm64_v8.0/fixture', goos: 'linux', goarch: 'arm64' },
  { type: 'Binary', name: 'fixture.exe', path: 'dist/fixture_windows_amd64_v1/fixture.exe', goos: 'windows', goarch: 'amd64' },
  { type: 'Binary', name: 'fixture.exe', path: 'dist/fixture_windows_arm64_v8.0/fixture.exe', goos: 'windows', goarch: 'arm64' },
];
const archiveArtifacts = () => [
  { type: 'Archive', name: 'fixture_1.2.3_darwin_amd64.tar.gz', path: 'dist/fixture_1.2.3_darwin_amd64.tar.gz', goos: 'darwin', goarch: 'amd64', extra: { Format: 'tar.gz' } },
  { type: 'Archive', name: 'fixture_1.2.3_darwin_arm64.tar.gz', path: 'dist/fixture_1.2.3_darwin_arm64.tar.gz', goos: 'darwin', goarch: 'arm64', extra: { Format: 'tar.gz' } },
  { type: 'Archive', name: 'fixture_1.2.3_linux_amd64.tar.gz', path: 'dist/fixture_1.2.3_linux_amd64.tar.gz', goos: 'linux', goarch: 'amd64', extra: { Format: 'tar.gz' } },
  { type: 'Archive', name: 'fixture_1.2.3_linux_arm64.tar.gz', path: 'dist/fixture_1.2.3_linux_arm64.tar.gz', goos: 'linux', goarch: 'arm64', extra: { Format: 'tar.gz' } },
  { type: 'Archive', name: 'fixture_1.2.3_windows_amd64.zip', path: 'dist/fixture_1.2.3_windows_amd64.zip', goos: 'windows', goarch: 'amd64', extra: { Format: 'zip' } },
  { type: 'Archive', name: 'fixture_1.2.3_windows_arm64.zip', path: 'dist/fixture_1.2.3_windows_arm64.zip', goos: 'windows', goarch: 'arm64', extra: { Format: 'zip' } },
];
const baseArtifacts = () => [...binaryArtifacts(), ...archiveArtifacts()];
const packageArtifacts = () => [
  { type: 'Linux Package', name: 'fixture_1.2.3_amd64.deb', path: 'dist/fixture_1.2.3_amd64.deb', goos: 'linux', goarch: 'amd64' },
  { type: 'Linux Package', name: 'fixture-1.2.3-1.x86_64.rpm', path: 'dist/fixture-1.2.3-1.x86_64.rpm', goos: 'linux', goarch: 'amd64' },
  { type: 'Linux Package', name: 'fixture_1.2.3_arm64.deb', path: 'dist/fixture_1.2.3_arm64.deb', goos: 'linux', goarch: 'arm64' },
  { type: 'Linux Package', name: 'fixture-1.2.3-1.aarch64.rpm', path: 'dist/fixture-1.2.3-1.aarch64.rpm', goos: 'linux', goarch: 'arm64' },
];

const runAssembler = ({ archiveFiles = [], nfpm = false, universal = true, mutate = () => {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifact-assembler-'));
  const originalCwd = process.cwd();
  try {
    const dist = join(root, 'dist');
    const releaseAssets = join(root, 'release-assets');
    mkdirSync(dist);
    mkdirSync(releaseAssets);
    const artifacts = baseArtifacts();
    for (const artifact of artifacts.filter((candidate) => candidate.type === 'Binary')) {
      const directory = join(root, artifact.path, '..');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(root, artifact.path), `${artifact.goos}/${artifact.goarch}\n`);
      chmodSync(join(root, artifact.path), 0o755);
    }
    for (const artifact of artifacts.filter((candidate) => candidate.type === 'Archive')) {
      writeFileSync(join(root, artifact.path), `unsigned:${artifact.name}\n`);
    }
    if (universal) {
      mkdirSync(join(dist, 'universal_darwin_all'));
      writeFileSync(join(dist, 'universal_darwin_all', 'fixture'), 'universal\n');
    }
    mkdirSync(join(dist, 'extra-package-payload'));
    writeFileSync(join(dist, 'extra-package-payload', 'extra.txt'), 'extra\n');
    if (archiveFiles.length > 0) {
      mkdirSync(join(root, 'release-archive-files'));
      for (const name of archiveFiles) writeFileSync(join(root, 'release-archive-files', name), `archive:${name}\n`);
    }
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
      ARCHIVE_FILES: JSON.stringify(archiveFiles),
      NFPM_ENABLED: nfpm ? 'true' : 'false',
      RELEASE_VERSION: '1.2.3',
      REPOSITORY_NAME: 'fixture',
    }, () => executeAssembler(require, process));
    return {
      binaryMap: JSON.parse(readFileSync(join(releaseAssets, '.ASSET-BINARIES.json'), 'utf8')),
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
const runInventory = ({ checksumFilename = 'SHA256SUMS', extraAssets = [], homebrew = false, packages = [], targets = [] } = {}) => {
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
      CHECKSUM_FILENAME: checksumFilename,
      GITHUB_REPOSITORY: 'openclaw/fixture',
      HOMEBREW_FORMULA: homebrew ? 'fixture' : '',
      NFPM_PACKAGES_PATH: packagePath,
      REPRODUCIBLE_REBUILD: 'disabled',
      TAG: 'v1.2.3',
      TARGET_SHA: 'a'.repeat(40),
    }, () => executeInventoryBuilder(require, process));
    return {
      checksumFilename,
      checksums: readFileSync(join(root, 'release-assets', checksumFilename), 'utf8'),
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
    assert.match(output.args, /^release /);
    assert.match(output.args, /--skip=.*nfpm/);
  }],
  ['enabled mode requires configured nFPMs', () => {
    assert.throws(() => runBuildMode('enabled', 'version: 2\nbuilds: []\n'));
  }],
  ['disabled mode overrides configured nFPMs', () => {
    const output = runBuildMode('disabled', 'version: 2\nnfpms:\n  - id: packages\n');
    assert.equal(output['nfpm-enabled'], 'false');
    assert.match(output.args, /^release /);
    assert.match(output.args, /--skip=.*nfpm/);
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
        'windows_amd64', 'windows_arm64',
      ]);
      assert.deepEqual(
        fixture.targetMap.filter((row) => row.target.startsWith('windows_')).map((row) => row.name).sort(),
        ['fixture_1.2.3_windows_amd64.zip', 'fixture_1.2.3_windows_arm64.zip'],
      );
      assert.equal(fixture.binaryMap.length, 6);
      assert.deepEqual(fixture.binaryMap.filter((row) => row.target.startsWith('windows_')).map((row) => row.member), [
        'fixture.exe', 'fixture.exe',
      ]);
      assert.deepEqual(fixture.packageMap, []);
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['disabled universal mode leaves the six native platform archives', () => {
    const fixture = runAssembler({ universal: false });
    try {
      assert.deepEqual(fixture.targetMap.map((row) => row.target).sort(), [
        'darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_arm64',
        'windows_amd64', 'windows_arm64',
      ]);
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['duplicate GoReleaser aliases map to one staged binary member', () => {
    const fixture = runAssembler({ mutate: ({ artifacts }) => {
      artifacts.push({ ...artifacts.find((artifact) => artifact.type === 'Binary' && artifact.goos === 'linux' && artifact.goarch === 'amd64') });
    } });
    try {
      assert.equal(fixture.binaryMap.length, 6);
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['caller archive-files directory does not affect the empty default', () => {
    const fixture = runAssembler({ mutate: ({ root }) => {
      mkdirSync(join(root, 'archive-files'));
      writeFileSync(join(root, 'archive-files', 'caller.txt'), 'caller source\n');
    } });
    try {
      assert.equal(fixture.targetMap.length, 7);
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['opt-in archive files are included in every platform archive', () => {
    const fixture = runAssembler({ archiveFiles: ['CHANGELOG.md', 'LICENSE', 'README.md'], universal: false });
    try {
      for (const row of fixture.targetMap) {
        const archive = join(fixture.releaseAssets, row.name);
        const members = (row.name.endsWith('.zip')
          ? execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n')
          : execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'))
          .map((name) => name.replace(/^\.\//, ''))
          .filter(Boolean);
        assert.deepEqual(members.sort(), [
          row.target.startsWith('windows_') ? 'fixture.exe' : 'fixture',
          'CHANGELOG.md',
          'LICENSE',
          'README.md',
        ].sort());
      }
    } finally {
      finishAssembler(fixture);
    }
  }],
  ['archive files cannot case-fold onto a built payload', () => {
    assert.throws(() => runAssembler({ archiveFiles: ['Fixture'], universal: false }), /collides with a built payload/);
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
    assert.throws(() => runAssembler({ nfpm: true, mutate: ({ artifacts }) => {
      for (let index = artifacts.length - 1; index >= 0; index -= 1) {
        if (artifacts[index].type === 'Linux Package') artifacts.splice(index, 1);
      }
    } }), /emitted no Linux Package/);
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
  ['archive format must come from a single GoReleaser artifact', () => {
    assert.throws(() => runAssembler({ mutate: ({ artifacts }) => {
      const archive = artifacts.find((artifact) => artifact.type === 'Archive' && artifact.goos === 'windows' && artifact.goarch === 'amd64');
      archive.extra.Format = '7z';
    } }), /unsupported GoReleaser archive format/);
  }],
  ['archive metadata extension must match its allowlisted format', () => {
    assert.throws(() => runAssembler({ mutate: ({ artifacts, dist }) => {
      const archive = artifacts.find((artifact) => artifact.type === 'Archive' && artifact.goos === 'windows' && artifact.goarch === 'amd64');
      archive.name = 'fixture_1.2.3_windows_amd64.tar.gz';
      archive.path = `dist/${archive.name}`;
      writeFileSync(join(dist, archive.name), 'unsigned\n');
    } }), /unsafe or inconsistent GoReleaser archive metadata/);
  }],
  ['multiple GoReleaser archives for one canonical target fail closed', () => {
    assert.throws(() => runAssembler({ mutate: ({ artifacts, dist }) => {
      const archive = artifacts.find((artifact) => artifact.type === 'Archive' && artifact.goos === 'linux' && artifact.goarch === 'amd64');
      const duplicate = { ...archive, name: 'fixture_1.2.3_linux_amd64-extra.tar.gz', path: 'dist/fixture_1.2.3_linux_amd64-extra.tar.gz' };
      artifacts.push(duplicate);
      writeFileSync(join(dist, duplicate.name), 'unsigned\n');
    } }), /expected exactly one GoReleaser Archive artifact/);
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
  ['custom checksum filename preserves the inventory and digest set', () => {
    const fixture = runInventory({ checksumFilename: 'checksums.txt', targets: fourTargets });
    try {
      assert.equal(fixture.checksumFilename, 'checksums.txt');
      assert.match(fixture.checksums, /^[0-9a-f]{64}  ASSET-INVENTORY\.json$/m);
      assert.equal(fixture.inventory.payloads.some((payload) => payload.name === 'checksums.txt'), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['checksum filename cannot case-fold onto an existing asset', () => {
    assert.throws(
      () => runInventory({ checksumFilename: 'release-notes.md', targets: fourTargets }),
      /release controls already exist/,
    );
  }],
  ['inventory accepts allowlisted Windows zip targets', () => {
    const windowsTargets = [
      { name: 'fixture_1.2.3_windows_amd64.zip', target: 'windows_amd64' },
      { name: 'fixture_1.2.3_windows_arm64.zip', target: 'windows_arm64' },
    ];
    const fixture = runInventory({ targets: [...fourTargets, ...windowsTargets] });
    try {
      assert.deepEqual(
        fixture.inventory.payloads.filter((payload) => payload.target?.startsWith('windows_')).map((payload) => payload.name).sort(),
        windowsTargets.map((row) => row.name).sort(),
      );
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
