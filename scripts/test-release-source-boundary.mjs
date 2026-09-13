#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const head = 'a'.repeat(40);
const frozen = 'b'.repeat(40);
let failures = 0;
for (const archetype of ['go-cli', 'swift-cli', 'electron']) {
  const script = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'validate', 'name', 'Resolve protected release target').with.script;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', script);
  for (const scenario of ['new tag', 'existing tag', 'unprotected', 'missing object', 'forbidden ref', 'outside history']) {
    const outputs = new Map();
    const errors = [];
    const github = { rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getBranch: async () => ({ data: { protected: scenario !== 'unprotected', commit: { sha: head } } }),
        compareCommitsWithBasehead: async () => ({ data: { status: scenario === 'outside history' ? 'diverged' : 'ahead' } }),
      },
      git: {
        getRef: async () => {
          if (scenario === 'new tag') throw Object.assign(new Error('ref missing'), { status: 404 });
          if (scenario === 'forbidden ref') throw Object.assign(new Error('ref forbidden'), { status: 403 });
          return { data: { object: { type: 'tag', sha: 'c'.repeat(40) } } };
        },
        getTag: async () => {
          if (scenario === 'missing object') throw Object.assign(new Error('object missing'), { status: 404 });
          return { data: { object: { type: 'commit', sha: frozen } } };
        },
      },
    } };
    try {
      await execute(github, { repo: { owner: 'openclaw', repo: 'fixture' }, ref: 'refs/heads/main', sha: head }, {
        info() {}, setFailed: (error) => errors.push(error), setOutput: (name, value) => outputs.set(name, value),
      }, { env: { TAG: 'v1.2.3', GITHUB_WORKFLOW_REF: 'openclaw/fixture/.github/workflows/release.yml@refs/heads/main' } });
    } catch (error) { errors.push(error.message); }
    try {
      if (['new tag', 'existing tag'].includes(scenario)) {
        assert.deepEqual(errors, []);
        assert.equal(outputs.get('target-sha'), scenario === 'new tag' ? head : frozen);
      } else {
        assert.ok(errors.length > 0, 'unsafe source must fail');
        assert.equal(outputs.has('target-sha'), false, 'unsafe source must not export a build target');
      }
      console.log(`PASS ${archetype}: ${scenario}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${archetype}: ${scenario}: ${error.message}`);
    }
  }
}
assert.equal(failures, 0);
