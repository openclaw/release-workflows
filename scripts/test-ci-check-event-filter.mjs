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

console.log('CI check event filter tests passed');
