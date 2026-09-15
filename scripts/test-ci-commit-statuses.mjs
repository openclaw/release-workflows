#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const targetSha = 'a'.repeat(40);
const status = (state, context = 'external-ci') => ({ context, state });
const scenarios = [
  { name: 'failed status blocks a passing check', statuses: [status('failure')], failure: /external-ci=status\/failure/ },
  { name: 'errored status blocks a passing check', statuses: [status('error')], failure: /external-ci=status\/error/ },
  { name: 'pending status blocks a passing check', statuses: [status('pending')], failure: /external-ci=status\/pending/ },
  { name: 'new success supersedes old failure regardless of context case', statuses: [status('success', 'External-CI'), status('failure')] },
  { name: 'new failure supersedes old success', statuses: [status('failure'), status('success')], failure: /external-ci=status\/failure/ },
  { name: 'one failing context blocks other successful contexts', statuses: [status('success', 'lint'), status('failure')], failure: /external-ci=status\/failure/ },
  { name: 'successful statuses alone supply CI evidence', checks: false, statuses: [status('success')] },
  { name: 'no independent signal fails closed', checks: false, statuses: [], failure: /no independent CI/ },
  { name: 'status API failures fail closed', statuses: [], apiFailure: true, failure: /status service unavailable/ },
];

let failures = 0;
for (const archetype of ['swift-cli', 'electron']) {
  const script = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'validate', 'name', 'Require independent CI green on frozen target').with.script;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', script);
  for (const scenario of scenarios) {
    const errors = [];
    let statusReads = 0;
    const github = {
      rest: {
        actions: { listWorkflowRunsForRepo: 'runs' },
        checks: { listForRef: 'checks' },
        repos: { listCommitStatusesForRef: 'statuses' },
      },
      paginate: async (route, request) => {
        assert.deepEqual({ owner: request.owner, repo: request.repo }, { owner: 'openclaw', repo: 'fixture' });
        if (route === 'runs') {
          assert.equal(request.head_sha, targetSha);
          return [{ id: 101, event: 'push' }, { id: 102, event: 'schedule' }];
        }
        assert.equal(request.ref, targetSha, 'CI evidence must come from the frozen commit');
        if (route === 'checks') return [
          ...(scenario.checks === false ? [] : [{ name: 'build', status: 'completed', conclusion: 'success', details_url: 'https://github.com/openclaw/fixture/actions/runs/101/job/1' }]),
          { name: 'scheduled', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/openclaw/fixture/actions/runs/102/job/2' },
        ];
        assert.equal(route, 'statuses');
        assert.equal(request.per_page, 100);
        statusReads += 1;
        if (scenario.apiFailure) throw new Error('status service unavailable');
        return scenario.statuses;
      },
    };
    try {
      await execute(github, { repo: { owner: 'openclaw', repo: 'fixture' }, runId: 42 }, {
        setFailed: (message) => errors.push(message),
      }, { env: { CI_CHECK_EVENTS: '["push"]', TARGET_SHA: targetSha } });
    } catch (error) {
      errors.push(error.message);
    }
    try {
      if (scenario.failure) assert.match(errors.join('\n'), scenario.failure);
      else assert.deepEqual(errors, []);
      assert.equal(statusReads, 1, 'commit statuses must be fetched even when event filtering is enabled');
      console.log(`PASS ${archetype}: ${scenario.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${archetype}: ${scenario.name}: ${error.message}`);
    }
  }
}
assert.equal(failures, 0);
