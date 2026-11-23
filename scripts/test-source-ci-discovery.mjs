#!/usr/bin/env node
import assert from 'node:assert/strict';
import { extractMarkedSource, loadWorkflow, workflowStep } from './workflow-source.cjs';

const script = workflowStep(loadWorkflow('release-source.yml'), 'validate', 'name', 'Require independent CI green on frozen target').with.script;
const load = (begin, end, names) => new Function(`${extractMarkedSource(script, begin, end)}\nreturn { ${names} };`)();
const { collectCheckRuns } = load('// ci-check-collector-begin', '// ci-check-collector-end', 'collectCheckRuns');
const { filterCheckRunsByEvent } = load('// ci-check-event-filter-begin', '// ci-check-event-filter-end', 'filterCheckRunsByEvent');
const { evaluateAllChecks } = load('// ci-check-gate-helpers-begin', '// ci-check-gate-helpers-end', 'evaluateAllChecks');
const targetSha = 'a'.repeat(40);
const repo = { owner: 'openclaw', repo: 'fixture' };
const currentRunId = 42;
const allowedEvents = new Set(['push']);
const suite = (id, event = 'schedule', runId = id + 10000) => ({ databaseId: id, workflowRun: event === null ? null : { databaseId: runId, event } });
const check = (name, runId, conclusion = 'success') => ({
  name, status: 'completed', conclusion,
  details_url: runId === null ? 'https://example.invalid/check' : `https://github.com/openclaw/fixture/actions/runs/${runId}/job/7`,
});

function fixture(suites, checks = new Map()) {
  const pages = [];
  const fetched = [];
  const github = {
    graphql: async (query, request) => {
      assert.match(query, /checkSuites\(first: 100, after: \$cursor\)/);
      assert.match(query, /\$sha: GitObjectID!/);
      assert.deepEqual({ owner: request.owner, repo: request.repo, sha: request.sha }, { ...repo, sha: targetSha });
      const offset = request.cursor === null ? 0 : Number(request.cursor);
      pages.push(offset);
      const end = Math.min(offset + 100, suites.length);
      return { repository: { object: { oid: targetSha, checkSuites: {
        nodes: suites.slice(offset, end),
        pageInfo: { hasNextPage: end < suites.length, endCursor: String(end) },
      } } } };
    },
    rest: { checks: { listForSuite: 'suite-checks' } },
    paginate: async (route, request) => {
      assert.equal(route, 'suite-checks', 'never query either capped repository-wide endpoint');
      assert.deepEqual(request, { ...repo, check_suite_id: request.check_suite_id, per_page: 100, filter: 'latest' });
      fetched.push(request.check_suite_id);
      return checks.get(request.check_suite_id) ?? [];
    },
  };
  return { github, pages, fetched, args: { github, repo, targetSha, allowedEvents, currentRunId } };
}

// Real history: old push CI falls outside REST's newest 1,000 suites.
const history = [suite(1, 'push'), suite(2, 'push'), ...Array.from({ length: 1100 }, (_, index) => suite(index + 3))];
history.push(suite(1103, null), suite(1104, 'push', currentRunId));
const checks = new Map([
  [1, [check('build', 10001)]],
  [2, [check('build', 10002)]],
  [1103, [check('custom', null), check('unresolved Actions run', 99999), check('known schedule from unknown suite', 10003)]],
]);
const large = fixture(history, checks);
const result = await collectCheckRuns(large.args);
assert.equal(large.pages.length, 12, 'pagination must continue beyond 1,000 newer suites');
assert.deepEqual(large.fetched, [1, 2, 1103]);
assert.equal(result.workflowRunEvents.size, 1103, 'record events even when their suites are not fetched');
const accepted = filterCheckRunsByEvent({ ...result, allowedEvents, currentRunId, info() {} });
assert.deepEqual(accepted.map(({ name }) => name), ['build', 'build', 'custom', 'unresolved Actions run']);
assert.equal(accepted.filter(({ name }) => name === 'build').length, 2, 'same-name checks in distinct suites remain independent');
const evaluate = checkRuns => evaluateAllChecks({ checkRuns, latestStatuses: new Map(), acceptableConclusions: new Set(['success', 'neutral', 'skipped']) });
assert.equal(evaluate(accepted).state, 'success');
checks.set(2, [check('build', 10002, 'failure')]);
const failed = await collectCheckRuns(fixture(history, checks).args);
assert.equal(evaluate(filterCheckRunsByEvent({ ...failed, allowedEvents, currentRunId, info() {} })).state, 'failure');

const unfiltered = fixture([suite(1), suite(2, null), suite(3, 'push', currentRunId)]);
await collectCheckRuns({ ...unfiltered.args, allowedEvents: new Set() });
assert.deepEqual(unfiltered.fetched, [1, 2], 'empty event filter includes all independent suites');

async function rejectsMutation(mutate, message) {
  const test = fixture([suite(1, 'push')]);
  const original = test.github.graphql;
  test.github.graphql = async (...args) => mutate(await original(...args));
  await assert.rejects(collectCheckRuns(test.args), message);
}
await rejectsMutation(response => { response.repository.object.oid = 'b'.repeat(40); return response; }, /frozen commit/);
await rejectsMutation(response => { response.repository.object.checkSuites.nodes = null; return response; }, /Incomplete/);
await rejectsMutation(response => { response.repository.object.checkSuites.nodes[0].databaseId = null; return response; }, /identity/);
await rejectsMutation(response => { delete response.repository.object.checkSuites.nodes[0].workflowRun; return response; }, /identity/);
await rejectsMutation(response => { response.repository.object.checkSuites.nodes[0].workflowRun.databaseId = null; return response; }, /identity/);
await rejectsMutation(response => { response.repository.object.checkSuites.nodes[0].workflowRun.event = null; return response; }, /identity/);
await rejectsMutation(response => {
  response.repository.object.checkSuites.pageInfo = { hasNextPage: true, endCursor: null };
  return response;
}, /pagination/);
const duplicate = fixture([suite(1), suite(1)]);
await assert.rejects(collectCheckRuns(duplicate.args), /duplicate/);
const cyclic = fixture([suite(1)]);
cyclic.github.graphql = async () => ({ repository: { object: { oid: targetSha, checkSuites: {
  nodes: [], pageInfo: { hasNextPage: true, endCursor: 'repeat' },
} } } });
await assert.rejects(collectCheckRuns(cyclic.args), /pagination/);
const partial = fixture(history);
const readPage = partial.github.graphql;
partial.github.graphql = async (query, request) => {
  if (request.cursor !== null) throw new Error('next page unavailable');
  return readPage(query, request);
};
await assert.rejects(collectCheckRuns(partial.args), /next page unavailable/);
const unavailable = fixture([suite(1, 'push')]);
unavailable.github.paginate = async () => { throw new Error('checks unavailable'); };
await assert.rejects(collectCheckRuns(unavailable.args), /checks unavailable/);

console.log('Source CI discovery: paginated 1104 suites; retained eligible failures and unknown checks; incomplete reads rejected');
