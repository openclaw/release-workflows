#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const rubyExtractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  step = workflow.fetch('jobs').fetch('tag').fetch('steps').find do |candidate|
    candidate['name'] == 'Create immutable annotated tag'
  end
  abort 'tag freeze step not found' unless step
  print step.fetch('with').fetch('script')
`;
const tagScript = execFileSync(
  'ruby',
  ['-rpsych', '-e', rubyExtractor, workflowPath],
  { encoding: 'utf8' },
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executeTag = new AsyncFunction('github', 'context', 'core', 'process', tagScript);

const targetSha = 'a'.repeat(40);
const expectedTagObject = 'b'.repeat(40);

async function runScenario({
  currentTagObject = null,
  currentTagType = 'tag',
  expected = '',
  peeledTarget = targetSha,
  peeledType = 'commit',
} = {}) {
  const failures = [];
  const info = [];
  const mutations = [];
  const missing = () => Object.assign(new Error('not found'), { status: 404 });
  const github = {
    rest: {
      git: {
        getRef: async () => {
          if (currentTagObject === null) throw missing();
          return { data: { object: { type: currentTagType, sha: currentTagObject } } };
        },
        getTag: async ({ tag_sha: tagSha }) => {
          assert.equal(tagSha, expectedTagObject);
          return { data: { object: { type: peeledType, sha: peeledTarget } } };
        },
        createTag: async (request) => {
          mutations.push(['createTag', request.object]);
          return { data: { sha: 'c'.repeat(40) } };
        },
        createRef: async (request) => {
          mutations.push(['createRef', request.ref, request.sha]);
        },
      },
    },
  };
  const context = { repo: { owner: 'openclaw', repo: 'fixture' } };
  const core = {
    info: (message) => info.push(message),
    setFailed: (message) => failures.push(message),
  };
  let thrown;
  try {
    await executeTag(github, context, core, {
      env: {
        EXPECTED_TAG_OBJECT: expected,
        REPOSITORY_TYPE: 'openclaw',
        TAG: 'v1.2.3',
        TARGET_SHA: targetSha,
      },
    });
  } catch (error) {
    thrown = error;
  }
  return { failures, info, mutations, thrown };
}

const absent = await runScenario();
assert.deepEqual(absent.failures, []);
assert.equal(absent.thrown, undefined);
assert.deepEqual(absent.mutations, [
  ['createTag', targetSha],
  ['createRef', 'refs/tags/v1.2.3', 'c'.repeat(40)],
]);

const exact = await runScenario({
  currentTagObject: expectedTagObject,
  expected: expectedTagObject,
});
assert.deepEqual(exact.failures, []);
assert.equal(exact.thrown, undefined);
assert.deepEqual(exact.mutations, []);
assert.match(exact.info[0], /reusing exact/);

const appeared = await runScenario({ currentTagObject: expectedTagObject });
assert.match(appeared.failures[0], /appeared after validation/);
assert.deepEqual(appeared.mutations, []);

const disappeared = await runScenario({ expected: expectedTagObject });
assert.match(disappeared.failures[0], /disappeared after validation/);
assert.deepEqual(disappeared.mutations, []);

const changed = await runScenario({
  currentTagObject: 'd'.repeat(40),
  expected: expectedTagObject,
});
assert.match(changed.failures[0], /object changed after validation/);
assert.deepEqual(changed.mutations, []);

const lightweight = await runScenario({
  currentTagObject: expectedTagObject,
  currentTagType: 'commit',
  expected: expectedTagObject,
});
assert.match(lightweight.failures[0], /lightweight/);
assert.deepEqual(lightweight.mutations, []);

const retargeted = await runScenario({
  currentTagObject: expectedTagObject,
  expected: expectedTagObject,
  peeledTarget: 'e'.repeat(40),
});
assert.match(retargeted.failures[0], /does not freeze/);
assert.deepEqual(retargeted.mutations, []);

console.log('tag freeze tests passed (7 scenarios)');
