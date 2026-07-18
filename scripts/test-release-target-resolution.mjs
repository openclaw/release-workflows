#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const workflowPath = new URL('../.github/workflows/release-go-cli.yml', import.meta.url).pathname;
const rubyExtractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  step = workflow.fetch('jobs').fetch('validate').fetch('steps').find do |candidate|
    candidate['id'] == 'repository'
  end
  abort 'release target resolver step not found' unless step
  print step.fetch('with').fetch('script')
`;
const resolverScript = execFileSync(
  'ruby',
  ['-rpsych', '-e', rubyExtractor, workflowPath],
  { encoding: 'utf8' },
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executeResolver = new AsyncFunction('github', 'context', 'core', 'process', resolverScript);

async function runScenario({
  branchHead = 'b'.repeat(40),
  callerSha = branchHead,
  callerRef = 'refs/heads/main',
  comparisonStatus = 'ahead',
  tagCommit = 'a'.repeat(40),
  tagObjectType = 'commit',
  tagRefType = 'tag',
  tagState = 'annotated',
} = {}) {
  const outputs = new Map();
  const failures = [];
  const comparisons = [];
  const missing = () => Object.assign(new Error('not found'), { status: 404 });
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getBranch: async () => ({ data: { protected: true, commit: { sha: branchHead } } }),
        compareCommitsWithBasehead: async (request) => {
          comparisons.push(request.basehead);
          return { data: { status: comparisonStatus } };
        },
      },
      git: {
        getRef: async () => {
          if (tagState === 'absent') throw missing();
          return { data: { object: { type: tagRefType, sha: 'c'.repeat(40) } } };
        },
        getTag: async () => {
          if (tagState === 'missing-object') throw missing();
          return { data: { object: { type: tagObjectType, sha: tagCommit } } };
        },
      },
    },
  };
  const context = {
    ref: callerRef,
    repo: { owner: 'openclaw', repo: 'fixture' },
    sha: callerSha,
  };
  const core = {
    info: () => {},
    setFailed: (message) => failures.push(message),
    setOutput: (name, value) => outputs.set(name, value),
  };
  let thrown;
  try {
    await executeResolver(github, context, core, { env: { TAG: 'v1.2.3' } });
  } catch (error) {
    thrown = error;
  }
  return { comparisons, failures, outputs, thrown };
}

const tests = [
  ['no tag freezes protected head', async () => {
    const result = await runScenario({ tagState: 'absent' });
    assert.deepEqual(result.failures, []);
    assert.equal(result.thrown, undefined);
    assert.equal(result.outputs.get('target-sha'), 'b'.repeat(40));
    assert.equal(result.outputs.get('target-source'), 'protected-head');
    assert.deepEqual(result.comparisons, []);
  }],
  ['existing annotated tag freezes peeled commit', async () => {
    const result = await runScenario();
    assert.deepEqual(result.failures, []);
    assert.equal(result.outputs.get('target-sha'), 'a'.repeat(40));
    assert.equal(result.outputs.get('target-source'), 'annotated-tag');
    assert.deepEqual(result.comparisons, [`${'a'.repeat(40)}...${'b'.repeat(40)}`]);
  }],
  ['tag at current head remains valid', async () => {
    const sha = 'd'.repeat(40);
    const result = await runScenario({ branchHead: sha, tagCommit: sha, comparisonStatus: 'identical' });
    assert.deepEqual(result.failures, []);
    assert.equal(result.outputs.get('target-sha'), sha);
  }],
  ['lightweight tag fails closed', async () => {
    const result = await runScenario({ tagRefType: 'commit' });
    assert.match(result.failures[0], /lightweight/);
    assert.equal(result.outputs.has('target-sha'), false);
  }],
  ['indirect annotated tag fails closed', async () => {
    const result = await runScenario({ tagObjectType: 'tag' });
    assert.match(result.failures[0], /peel directly to a commit/);
    assert.equal(result.outputs.has('target-sha'), false);
  }],
  ['tag outside protected ancestry fails closed', async () => {
    const result = await runScenario({ comparisonStatus: 'diverged' });
    assert.match(result.failures[0], /not reachable/);
    assert.equal(result.outputs.has('target-sha'), false);
  }],
  ['missing annotated tag object never falls back to head', async () => {
    const result = await runScenario({ tagState: 'missing-object' });
    assert.equal(result.failures.length, 0);
    assert.equal(result.outputs.has('target-sha'), false);
    assert.equal(result.thrown?.status, 404);
  }],
  ['caller still runs at current protected head', async () => {
    const result = await runScenario({ callerSha: 'e'.repeat(40) });
    assert.match(result.failures[0], /caller must run at protected main head/);
    assert.equal(result.outputs.has('target-sha'), false);
  }],
];

for (const [name, test] of tests) {
  await test();
  console.log(`PASS ${name}`);
}
console.log(`release target resolution tests passed (${tests.length} scenarios)`);
