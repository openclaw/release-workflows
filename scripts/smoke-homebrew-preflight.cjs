const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

module.exports = async ({ github, core }) => {
  const workflowPath = path.join(__dirname, '../.github/workflows/release-go-cli.yml');
  const handoff = execFileSync('ruby', ['-rpsych', '-e', `
    workflow = Psych.safe_load(File.read(ARGV.fetch(0)), aliases: false)
    step = workflow.fetch('jobs').fetch('handoff').fetch('steps').find do |candidate|
      candidate['name'] == 'Dispatch configured tap and verify formula hashes'
    end
    print step.fetch('with').fetch('script')
  `, workflowPath], { encoding: 'utf8' });
  const start = handoff.indexOf("const [owner, repo] = process.env.HOMEBREW_TAP.split('/');");
  const end = handoff.indexOf('const sleep = ', start);
  assert.ok(start >= 0 && end > start, 'production preflight block must be present');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const preflight = new AsyncFunction('github', 'core', 'process', handoff.slice(start, end));
  const realTap = { owner: 'openclaw', repo: 'homebrew-tap' };
  assert.equal((await github.rest.repos.get(realTap)).data.full_name.toLowerCase(), 'openclaw/homebrew-tap');
  assert.equal((await github.rest.actions.getWorkflow({ ...realTap, workflow_id: 'update-formula.yml' })).data.state, 'active');
  // Missing resources exercise real API failures without failed-login throttling.
  const missingResource = `release-workflows-preflight-missing-${randomUUID()}`;
  for (const failure of ['repository', 'workflow']) {
    const params = failure === 'repository' ? { ...realTap, repo: missingResource } : realTap;
    const tap = `${params.owner}/${params.repo}`;
    const workflowParams = { ...params, workflow_id: 'update-formula.yml' };
    const requests = [];
    const client = {
      rest: {
        repos: {
          get: async (args) => {
            assert.deepEqual(args, params);
            requests.push('repository');
            return github.rest.repos.get(args);
          },
        },
        actions: {
          getWorkflow: async (args) => {
            assert.deepEqual(args, workflowParams);
            requests.push('workflow');
            return github.rest.actions.getWorkflow({ ...args, workflow_id: `${missingResource}.yml` });
          },
          createWorkflowDispatch: () => {
            requests.push('dispatch');
            throw new Error('integration proof must never dispatch');
          },
        },
      },
    };
    const prefix = failure === 'repository'
      ? `TAP_TOKEN cannot access configured Homebrew tap ${tap}`
      : `TAP_TOKEN cannot read update-formula.yml in configured Homebrew tap ${tap}`;
    const expected = `${prefix} (HTTP 404): Not Found`;
    await assert.rejects(
      preflight(client, core, { env: { HOMEBREW_TAP: tap } }),
      (error) => {
        assert.equal(error.message, expected);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(requests, failure === 'repository' ? ['repository'] : ['repository', 'workflow']);
    core.info(`PASS live ${failure} preflight: ${expected}; no dispatch`);
  }
  await require('./smoke-homebrew-formula.cjs').smoke({ github, core });
};
