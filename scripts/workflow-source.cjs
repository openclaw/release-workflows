const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function loadWorkflow(filename = 'release-go-cli.yml') {
  const workflowPath = path.resolve(__dirname, '../.github/workflows', filename);
  return JSON.parse(execFileSync('ruby', ['-rpsych', '-rjson', '-e', `
    workflow = Psych.safe_load(
      File.read(ARGV.fetch(0)),
      permitted_classes: [], permitted_symbols: [], aliases: false
    )
    puts JSON.generate(workflow)
  `, workflowPath], { encoding: 'utf8' }));
}

function workflowStep(workflow, job, selector, value) {
  const steps = workflow.jobs[job].steps.filter((step) => step[selector] === value);
  assert.equal(steps.length, 1, `expected one workflow step: ${job} ${selector}=${value}`);
  return steps[0];
}

function extractMarkedSource(source, begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  assert.ok(start >= 0 && finish > start, `missing or unordered source markers: ${begin}, ${end}`);
  return source.slice(start + begin.length, finish);
}

module.exports = { loadWorkflow, workflowStep, extractMarkedSource };
