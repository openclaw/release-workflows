#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  step = workflow.fetch('jobs').fetch('merge-builds').fetch('steps').find do |candidate|
    candidate['name'] == 'Merge host payloads without collisions'
  end
  abort 'split-host merge step not found' unless step
  print step.fetch('run')
`;
const mergeStep = execFileSync(
  'ruby',
  ['-rpsych', '-e', extractor, workflowPath],
  { encoding: 'utf8' },
);
const gateExtractor = String.raw`
  require "json"
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  jobs = workflow.fetch("jobs")
  print JSON.generate(
    %w[sign compare draft verify publish handoff closeout].to_h do |name|
      job = jobs.fetch(name)
      [name, { "if" => job.fetch("if"), "needs" => Array(job.fetch("needs")) }]
    end
  )
`;
const continuationGates = JSON.parse(execFileSync(
  'ruby',
  ['-rpsych', '-e', gateExtractor, workflowPath],
  { encoding: 'utf8' },
));

const requiredContinuationNeeds = {
  sign: ['validate', 'build', 'merge-builds'],
  compare: ['validate', 'build', 'sign', 'rebuild'],
  draft: ['validate', 'build', 'sign', 'compare'],
  verify: ['validate', 'draft'],
  publish: ['validate', 'draft', 'verify'],
  handoff: ['validate', 'draft', 'publish'],
};
for (const [job, requiredNeeds] of Object.entries(requiredContinuationNeeds)) {
  const gate = continuationGates[job];
  assert.deepEqual(gate.needs, requiredNeeds);
  assert.match(gate.if, /always\(\)/);
  for (const need of requiredNeeds) {
    assert.match(gate.if, new RegExp(`needs\\.${need.replaceAll('-', '\\-')}\\.result == 'success'`));
  }
}
assert.match(continuationGates.handoff.if, /inputs\.homebrew-formula != ''/);
assert.match(continuationGates.closeout.if, /always\(\)/);
assert.match(continuationGates.closeout.if, /needs\.validate\.result == 'success'/);
assert.match(continuationGates.closeout.if, /needs\.publish\.result == 'success'/);
assert.match(continuationGates.closeout.if, /needs\.handoff\.result == 'success'/);
assert.match(continuationGates.closeout.if, /needs\.handoff\.result == 'skipped'/);
console.log('PASS optional split skip cannot bypass release continuation gates');

const begin = '// split-host-artifact-merger-begin';
const end = '// split-host-artifact-merger-end';
const start = mergeStep.indexOf(begin);
const finish = mergeStep.indexOf(end);
assert.notEqual(start, -1, `missing marker: ${begin}`);
assert.notEqual(finish, -1, `missing marker: ${end}`);
const executeMerger = new Function('require', 'process', mergeStep.slice(start + begin.length, finish));

const artifact = (platform, type = 'Binary') => {
  const [goos, goarch] = platform.split('/');
  const extension = goos === 'windows' ? '.exe' : '';
  const member = `fixture_${goos}_${goarch}/fixture${extension}`;
  return {
    goarch,
    goos,
    name: `fixture${extension}`,
    path: `dist/${member}`,
    type,
  };
};

const runFixture = (mutate = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), 'release-split-host-'));
  const previousCwd = process.cwd();
  try {
    const primaryDist = join(root, 'primary', 'root', 'dist');
    const splitDist = join(root, 'split', 'root', 'dist');
    mkdirSync(primaryDist, { recursive: true });
    mkdirSync(splitDist, { recursive: true });
    mkdirSync(join(root, 'merged'));
    const primaryArtifacts = [artifact('darwin/amd64'), artifact('darwin/arm64')];
    const splitArtifacts = [artifact('linux/amd64'), artifact('linux/arm64'), artifact('windows/amd64')];
    for (const [dist, artifacts] of [[primaryDist, primaryArtifacts], [splitDist, splitArtifacts]]) {
      for (const row of artifacts) {
        const target = join(root, dist === primaryDist ? 'primary/root' : 'split/root', row.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${row.goos}/${row.goarch}\n`);
      }
      writeFileSync(join(dist, 'artifacts.json'), `${JSON.stringify(artifacts)}\n`);
    }
    mkdirSync(join(primaryDist, 'extra-package-payload'));
    writeFileSync(join(primaryDist, 'extra-package-payload', 'completion.txt'), 'completion\n');
    mkdirSync(join(root, 'primary', 'root', 'release-archive-files'));
    writeFileSync(join(root, 'primary', 'root', 'release-archive-files', 'README.md'), 'readme\n');
    mutate({ primaryArtifacts, primaryDist, root, splitArtifacts, splitDist });
    process.chdir(root);
    executeMerger(require, process);
    return {
      artifacts: JSON.parse(readFileSync(join(root, 'merged', 'dist', 'artifacts.json'), 'utf8')),
      root,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    process.chdir(previousCwd);
  }
};

const tests = [
  ['merges disjoint Darwin and Linux/Windows artifact matrices', () => {
    const fixture = runFixture();
    try {
      assert.deepEqual(
        fixture.artifacts.map((row) => `${row.goos}/${row.goarch}`).sort(),
        ['darwin/amd64', 'darwin/arm64', 'linux/amd64', 'linux/arm64', 'windows/amd64'],
      );
      assert.equal(readFileSync(join(fixture.root, 'merged', 'dist', 'extra-package-payload', 'completion.txt'), 'utf8'), 'completion\n');
      assert.equal(readFileSync(join(fixture.root, 'merged', 'release-archive-files', 'README.md'), 'utf8'), 'readme\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['ignores host-local checksum metadata', () => {
    const fixture = runFixture(({ splitArtifacts, splitDist }) => {
      writeFileSync(join(splitDist, 'checksums.txt'), 'host-local\n');
      splitArtifacts.push({ name: 'checksums.txt', path: 'dist/checksums.txt', type: 'Checksum' });
      writeFileSync(join(splitDist, 'artifacts.json'), `${JSON.stringify(splitArtifacts)}\n`);
    });
    try {
      assert.equal(fixture.artifacts.some((row) => row.type === 'Checksum'), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }],
  ['rejects a cross-host artifact collision', () => {
    assert.throws(() => runFixture(({ splitArtifacts, splitDist }) => {
      const collision = artifact('darwin/amd64');
      splitArtifacts.push(collision);
      const target = join(splitDist, collision.path.slice('dist/'.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'collision\n');
      writeFileSync(join(splitDist, 'artifacts.json'), `${JSON.stringify(splitArtifacts)}\n`);
    }), /split-host artifact collision/);
  }],
  ['rejects artifact path escapes and symlinks', () => {
    assert.throws(() => runFixture(({ splitArtifacts, splitDist }) => {
      splitArtifacts.push({ name: 'outside', path: 'dist/../outside', type: 'Binary' });
      writeFileSync(join(splitDist, '..', 'outside'), 'outside\n');
      writeFileSync(join(splitDist, 'artifacts.json'), `${JSON.stringify(splitArtifacts)}\n`);
    }), /escapes dist/);
    assert.throws(() => runFixture(({ splitArtifacts, splitDist }) => {
      const row = { ...artifact('linux/ppc64'), path: 'dist/link/fixture' };
      splitArtifacts.push(row);
      mkdirSync(join(splitDist, 'link'));
      symlinkSync(join(splitDist, 'fixture_linux_amd64', 'fixture'), join(splitDist, 'link', 'fixture'));
      writeFileSync(join(splitDist, 'artifacts.json'), `${JSON.stringify(splitArtifacts)}\n`);
    }), /not a regular file/);
  }],
];

for (const [name, test] of tests) {
  test();
  console.log(`PASS ${name}`);
}
console.log(`split-host build tests passed (${tests.length} scenarios)`);
