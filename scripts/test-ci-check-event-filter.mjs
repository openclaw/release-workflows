#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const extractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  step = workflow.fetch('jobs').fetch('validate').fetch('steps').find do |candidate|
    candidate['name'] == 'Require independent CI green on frozen target'
  end
  abort 'CI gate step not found' unless step
  print step.fetch('with').fetch('script')
`;
const script = execFileSync('ruby', ['-rpsych', '-e', extractor, workflowPath], { encoding: 'utf8' });
const begin = '// ci-check-event-filter-begin';
const end = '// ci-check-event-filter-end';
const start = script.indexOf(begin);
const finish = script.indexOf(end);
assert.notEqual(start, -1);
assert.notEqual(finish, -1);
const source = `${script.slice(start + begin.length, finish)}\nreturn filterCheckRunsByEvent;`;
const loadFilter = new Function(source);
const filterCheckRunsByEvent = loadFilter();
const gateBegin = '// ci-check-gate-helpers-begin';
const gateEnd = '// ci-check-gate-helpers-end';
const gateStart = script.indexOf(gateBegin);
const gateFinish = script.indexOf(gateEnd);
assert.notEqual(gateStart, -1);
assert.notEqual(gateFinish, -1);
const gateSource = `${script.slice(gateStart + gateBegin.length, gateFinish)}
return { evaluateAllChecks, evaluateRequiredChecks, evaluateCiGate, waitForCiGate };`;
const loadGateHelpers = new Function(gateSource);
const { evaluateAllChecks, evaluateRequiredChecks, evaluateCiGate, waitForCiGate } = loadGateHelpers();

const actionsCheck = (name, runId) => ({
  name,
  details_url: `https://github.com/openclaw/fixture/actions/runs/${runId}/job/${runId + 1000}`,
});
const unresolvedCheck = { name: 'CodeQL', details_url: 'https://github.com/openclaw/fixture/runs/99' };

function runFilter(allowedEvents, workflowRunEvents = new Map([[1, 'push'], [2, 'schedule']])) {
  const info = [];
  const accepted = filterCheckRunsByEvent({
    checkRuns: [
      actionsCheck('ci', 1),
      actionsCheck('ci companion', 1),
      actionsCheck('publish', 2),
      actionsCheck('unresolved Actions check', 3),
      unresolvedCheck,
      { name: 'current release', details_url: 'https://github.com/openclaw/fixture/actions/runs/42/job/7' },
    ],
    allowedEvents: new Set(allowedEvents),
    currentRunMarker: '/actions/runs/42',
    workflowRunEvents,
    info: (message) => info.push(message),
  });
  return { accepted, info };
}

const unfiltered = runFilter([]);
assert.deepEqual(unfiltered.accepted.map((check) => check.name), [
  'ci', 'ci companion', 'publish', 'unresolved Actions check', 'CodeQL',
]);

const pushOnly = runFilter(['push', 'pull_request']);
assert.deepEqual(pushOnly.accepted.map((check) => check.name), [
  'ci', 'ci companion', 'unresolved Actions check', 'CodeQL',
]);
assert.deepEqual(pushOnly.info, ['Ignoring publish from Actions event schedule']);

const failedResolution = runFilter(['push'], new Map());
assert.equal(failedResolution.accepted.length, 5);

const acceptableConclusions = new Set(['success', 'neutral', 'skipped']);
const check = (name, status, conclusion = null, appId = 1) => ({
  name,
  status,
  conclusion,
  app: { id: appId },
});
const status = (context, state, login = 'github-actions[bot]') => ({
  context,
  state,
  creator: { login, type: 'Bot' },
});
const latestStatuses = (statuses) =>
  new Map(statuses.map((candidate) => [candidate.context.toLowerCase(), candidate]));

const wacrawlPending = evaluateAllChecks({
  checkRuns: [
    check('deps', 'completed', 'success'),
    check('release-check', 'in_progress'),
    check('secrets', 'completed', 'success'),
    check('lint', 'in_progress'),
    check('test', 'in_progress'),
  ],
  latestStatuses: new Map(),
  acceptableConclusions,
});
assert.equal(wacrawlPending.state, 'pending');
assert.deepEqual(wacrawlPending.observed, [
  'release-check=in_progress/null',
  'lint=in_progress/null',
  'test=in_progress/null',
]);

const wacrawlGreen = evaluateAllChecks({
  checkRuns: [
    check('deps', 'completed', 'success'),
    check('release-check', 'completed', 'success'),
    check('secrets', 'completed', 'success'),
    check('lint', 'completed', 'success'),
    check('test', 'completed', 'success'),
  ],
  latestStatuses: new Map(),
  acceptableConclusions,
});
assert.equal(wacrawlGreen.state, 'success');

const completedFailure = evaluateAllChecks({
  checkRuns: [check('test', 'completed', 'failure')],
  latestStatuses: new Map(),
  acceptableConclusions,
});
assert.equal(completedFailure.state, 'failure');
assert.deepEqual(completedFailure.observed, ['test=completed/failure']);

const noSignal = evaluateAllChecks({
  checkRuns: [],
  latestStatuses: new Map(),
  acceptableConclusions,
});
assert.equal(noSignal.state, 'pending');
assert.deepEqual(noSignal.observed, ['no independent CI check or commit status']);

const pendingStatus = evaluateAllChecks({
  checkRuns: [],
  latestStatuses: latestStatuses([status('legacy-ci', 'pending')]),
  acceptableConclusions,
});
assert.equal(pendingStatus.state, 'pending');
assert.deepEqual(pendingStatus.observed, ['legacy-ci=status/pending']);

const required = new Map([
  ['lint\u0000*', { name: 'lint', normalizedName: 'lint', appId: null }],
  ['test\u00001', { name: 'test', normalizedName: 'test', appId: 1 }],
]);
const requiredPending = await evaluateRequiredChecks({
  required,
  checkRuns: [check('lint', 'completed', 'success')],
  allStatuses: [],
  latestStatuses: new Map(),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: async () => null,
});
assert.equal(requiredPending.state, 'pending');
assert.deepEqual(requiredPending.observed, ['test@app:1=missing']);

const requiredFailure = await evaluateRequiredChecks({
  required,
  checkRuns: [
    check('lint', 'completed', 'success'),
    check('test', 'completed', 'failure'),
  ],
  allStatuses: [],
  latestStatuses: new Map(),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: async () => null,
});
assert.equal(requiredFailure.state, 'failure');
assert.deepEqual(requiredFailure.observed, ['test@app:1=completed/failure']);

const requiredGreen = await evaluateRequiredChecks({
  required,
  checkRuns: [
    check('lint', 'completed', 'success'),
    check('test', 'completed', 'success'),
  ],
  allStatuses: [],
  latestStatuses: new Map(),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: async () => null,
});
assert.equal(requiredGreen.state, 'success');

const optionalPending = check('optional', 'in_progress');
const defaultRequiredGate = await evaluateCiGate({
  required,
  strictChecks: false,
  checkRuns: [
    check('lint', 'completed', 'success'),
    check('test', 'completed', 'success'),
    optionalPending,
  ],
  allStatuses: [],
  latestStatuses: new Map(),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: async () => null,
});
assert.equal(defaultRequiredGate.state, 'success');
assert.equal(defaultRequiredGate.mode, 'required');

const strictRequiredGate = await evaluateCiGate({
  required,
  strictChecks: true,
  checkRuns: [
    check('lint', 'completed', 'success'),
    check('test', 'completed', 'success'),
    optionalPending,
  ],
  allStatuses: [],
  latestStatuses: new Map(),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: async () => null,
});
assert.equal(strictRequiredGate.state, 'pending');
assert.equal(strictRequiredGate.mode, 'all');
assert.deepEqual(strictRequiredGate.observed, ['optional=in_progress/null']);

const strictTerminalFailure = await evaluateCiGate({
  required,
  strictChecks: true,
  checkRuns: [
    check('lint', 'completed', 'success'),
    check('test', 'in_progress'),
    check('optional', 'completed', 'failure'),
  ],
  allStatuses: [],
  latestStatuses: new Map(),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: async () => null,
});
assert.equal(strictTerminalFailure.state, 'failure');
assert.equal(strictTerminalFailure.mode, 'all');
assert.deepEqual(strictTerminalFailure.observed, ['optional=completed/failure']);

const wrongAppPending = status('test', 'pending', 'wrong-app[bot]');
const correctAppPending = status('test', 'pending', 'correct-app[bot]');
const correctAppSuccess = status('test', 'success', 'correct-app[bot]');
const correctAppFailure = status('test', 'failure', 'correct-app[bot]');
const appIdByLogin = new Map([
  ['wrong-app[bot]', 2],
  ['correct-app[bot]', 1],
]);
const resolveStatusAppId = async (candidate) => appIdByLogin.get(candidate.creator.login) ?? null;
const appBoundPending = await evaluateRequiredChecks({
  required: new Map([['test\u00001', { name: 'test', normalizedName: 'test', appId: 1 }]]),
  checkRuns: [],
  allStatuses: [wrongAppPending, correctAppPending],
  latestStatuses: latestStatuses([wrongAppPending]),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: resolveStatusAppId,
});
assert.equal(appBoundPending.state, 'pending');
assert.deepEqual(appBoundPending.observed, ['test@app:1=status/pending']);

const appBoundSuccess = await evaluateRequiredChecks({
  required: new Map([['test\u00001', { name: 'test', normalizedName: 'test', appId: 1 }]]),
  checkRuns: [],
  allStatuses: [wrongAppPending, correctAppSuccess],
  latestStatuses: latestStatuses([wrongAppPending]),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: resolveStatusAppId,
});
assert.equal(appBoundSuccess.state, 'success');

const appBoundFailure = await evaluateRequiredChecks({
  required: new Map([['test\u00001', { name: 'test', normalizedName: 'test', appId: 1 }]]),
  checkRuns: [],
  allStatuses: [correctAppFailure],
  latestStatuses: latestStatuses([correctAppFailure]),
  acceptableConclusions,
  normalizeContext: (name) => name.toLowerCase(),
  statusAppId: resolveStatusAppId,
});
assert.equal(appBoundFailure.state, 'failure');
assert.deepEqual(appBoundFailure.observed, ['test@app:1=status/failure']);

let nowMs = 0;
let loads = 0;
const sleeps = [];
const messages = [];
const snapshots = [wacrawlPending, wacrawlGreen];
const recovered = await waitForCiGate({
  loadEvaluation: async () => {
    loads += 1;
    return snapshots.shift();
  },
  timeoutMs: 30_000,
  intervalMs: 10_000,
  now: () => nowMs,
  sleep: async (delayMs) => {
    sleeps.push(delayMs);
    nowMs += delayMs;
  },
  info: (message) => messages.push(message),
});
assert.equal(recovered.state, 'success');
assert.equal(loads, 2);
assert.deepEqual(sleeps, [10_000]);
assert.deepEqual(messages, [
  'CI checks pending: release-check=in_progress/null, lint=in_progress/null, test=in_progress/null; retrying in 10s',
]);

nowMs = 0;
const timeoutSleeps = [];
const timedOut = await waitForCiGate({
  loadEvaluation: async () => noSignal,
  timeoutMs: 25_000,
  intervalMs: 10_000,
  now: () => nowMs,
  sleep: async (delayMs) => {
    timeoutSleeps.push(delayMs);
    nowMs += delayMs;
  },
  info: () => {},
});
assert.equal(timedOut.state, 'failure');
assert.equal(timedOut.timedOut, true);
assert.deepEqual(timedOut.observed, ['no independent CI check or commit status']);
assert.deepEqual(timeoutSleeps, [10_000, 10_000, 5_000]);

let terminalSleeps = 0;
const failedImmediately = await waitForCiGate({
  loadEvaluation: async () => completedFailure,
  timeoutMs: 30_000,
  intervalMs: 10_000,
  now: () => 0,
  sleep: async () => {
    terminalSleeps += 1;
  },
  info: () => {},
});
assert.equal(failedImmediately.state, 'failure');
assert.equal(terminalSleeps, 0);

console.log('CI check gate tests passed');
