#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let failures = 0;
for (const archetype of ['go-cli', 'swift-cli', 'electron']) {
  const script = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'validate', 'name', 'Require independent CI green on frozen target').with.script;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', script);
  for (const prefixCollision of [false, true]) {
    const check = (id, conclusion) => ({ name: `check-${id}`, status: 'completed', conclusion, details_url: `https://github.com/openclaw/fixture/actions/runs/${id}/job/7` });
    const checks = [check(42, 'failure'), check(101, 'success')];
    if (prefixCollision) checks.push(check(421, 'failure'));
    const errors = [];
    const github = {
      rest: {
        actions: { listWorkflowRunsForRepo: 'runs' },
        checks: { listForRef: 'checks' },
        repos: { listCommitStatusesForRef: 'statuses', getBranch: async () => ({ data: {} }) },
      },
      paginate: async (route) => {
        if (route === 'checks') return checks;
        if (route === 'runs') return [42, 101, 421].map((id) => ({ id, event: 'push' }));
        if (route === 'statuses' || route.includes('/rules/branches/')) return [];
        throw new Error(`unexpected API route ${route}`);
      },
    };
    await execute(github, { repo: { owner: 'openclaw', repo: 'fixture' }, runId: 42 }, {
      info() {}, warning() {}, setFailed: (message) => errors.push(message),
    }, { env: { CI_CHECK_EVENTS: '["push"]', DEFAULT_BRANCH: 'main', STRICT_CHECKS: 'false', TARGET_SHA: 'a'.repeat(40) } });
    try {
      assert.equal(errors.length > 0, prefixCollision, 'only the exact current run may be excluded');
      if (prefixCollision) assert.match(errors[0], /check-421=completed\/failure/);
      console.log(`PASS ${archetype}: ${prefixCollision ? 'independent prefix run blocks release' : 'exact current run excluded'}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${archetype}: ${error.message}`);
    }
  }
}
assert.equal(failures, 0);
