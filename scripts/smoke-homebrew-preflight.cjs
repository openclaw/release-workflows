const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
  const tap = 'openclaw/homebrew-tap';
  const params = { owner: 'openclaw', repo: 'homebrew-tap' };
  const workflowParams = { ...params, workflow_id: 'update-formula.yml' };

  // Confirm these are real resources before deliberately rejecting each GET.
  assert.equal((await github.rest.repos.get(params)).data.full_name.toLowerCase(), tap);
  assert.equal((await github.rest.actions.getWorkflow(workflowParams)).data.state, 'active');
  const invalidToken = 'release-workflows-deliberately-invalid-test-token';
  // Octokit's auth hook overwrites per-request Authorization headers.
  const invalidGithub = new github.constructor({ auth: invalidToken });
  for (const failure of ['repository', 'workflow']) {
    const requests = [];
    const client = {
      rest: {
        repos: {
          get: async (args) => {
            assert.deepEqual(args, params);
            requests.push('repository');
            return (failure === 'repository' ? invalidGithub : github).rest.repos.get(args);
          },
        },
        actions: {
          getWorkflow: async (args) => {
            assert.deepEqual(args, workflowParams);
            requests.push('workflow');
            return invalidGithub.rest.actions.getWorkflow(args);
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
    const expected = `${prefix} (HTTP 401): Bad credentials`;
    await assert.rejects(
      preflight(client, core, { env: { HOMEBREW_TAP: tap } }),
      (error) => {
        assert.equal(error.message, expected);
        assert.equal(error.cause, undefined);
        assert.ok(!error.stack.includes(invalidToken));
        return true;
      },
    );
    assert.deepEqual(requests, failure === 'repository' ? ['repository'] : ['repository', 'workflow']);
    core.info(`PASS live ${failure} preflight: ${expected}; no dispatch`);
  }
};
