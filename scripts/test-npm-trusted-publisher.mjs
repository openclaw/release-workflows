#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow('release-npm-package.yml');
const step = workflowStep(workflow, 'publish-npm', 'name', 'Preflight npm trusted publishers');
const steps = workflow.jobs['publish-npm'].steps;
assert.ok(steps.indexOf(step) < steps.findIndex(s => s.name === 'Publish exact tarballs with trusted publishing'));
assert.ok(steps.indexOf(step) < steps.findIndex(s => s.name === 'Recheck frozen tag before registry publication'),
  'slow OIDC preflight must not extend the final frozen-tag check to publication interval');
assert.equal(workflow.jobs['publish-npm'].if, '!inputs.dry_run');
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  'require', 'fetch', 'core', 'process', step.with.script,
);
const packages = [{ name: '@fixture/core', version: '1.2.3' }, { name: '@fixture/cli', version: '1.2.3' }];
const oidcToken = 'synthetic-oidc-token';
const registryToken = 'synthetic-registry-token';

async function scenario({ failure, existing = [], missingOIDC = false, missingToken = false } = {}) {
  const calls = [], logs = [];
  const core = {
    async getIDToken(audience) {
      assert.equal(audience, 'npm:registry.npmjs.org');
      if (missingOIDC) throw new Error(oidcToken);
      return oidcToken;
    },
    info: message => logs.push(message),
  };
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, 'error');
    if (options.method !== 'POST') {
      return existing.some(name => String(url).includes(encodeURIComponent(name)))
        ? { ok: true, status: 200 } : { ok: false, status: 404 };
    }
    assert.equal(options.headers.Authorization, `Bearer ${oidcToken}`);
    assert.match(String(url), /\/-\/npm\/v1\/oidc\/token\/exchange\/package\/@fixture%2f(?:core|cli)$/);
    if (failure && String(url).endsWith('cli')) {
      if (failure.network) throw new Error(oidcToken);
      return { ok: false, status: failure.status, json: async () => ({ code: failure.code, error: failure.error, message: registryToken }) };
    }
    return { ok: true, status: 201, json: async () => missingToken ? {} : ({ token: registryToken }) };
  };
  let error;
  try {
    await run(name => {
      assert.equal(name, 'node:fs');
      return { readFileSync: () => JSON.stringify(packages) };
    }, fetch, core, { env: { PAYLOAD: '/synthetic/payload' } });
  } catch (caught) { error = caught; }
  const output = [...logs, error?.message ?? ''].join('\n');
  assert.ok(!output.includes(oidcToken));
  assert.ok(!output.includes(registryToken));
  return { calls, error, output };
}

const success = await scenario();
assert.equal(success.error, undefined);
assert.equal(success.calls.filter(c => c.options.method === 'POST').length, 2);
for (const failure of [{ status: 404 }, { status: 400, code: 'ENEEDAUTH' }, { status: 400, error: 'ENEEDAUTH' }, { status: 401 }, { status: 403 }]) {
  const result = await scenario({ failure });
  assert.match(result.error?.message ?? '', /@fixture\/cli/);
  assert.match(result.output, /2 days/);
  assert.match(result.output, /recreate.*trusted.publisher/i);
  assert.match(result.output, /caller.*filename/i);
  assert.equal(result.calls.filter(c => c.options.method === 'POST').length, 2, 'one exchange per package, no retries');
}
const unavailable = await scenario({ failure: { status: 503 } });
assert.match(unavailable.error?.message ?? '', /@fixture\/cli.*HTTP 503/);
assert.doesNotMatch(unavailable.output, /expired/);
assert.match((await scenario({ failure: { network: true } })).error?.message ?? '', /@fixture\/cli.*request failed/);
assert.match((await scenario({ missingOIDC: true })).error?.message ?? '', /id-token: write/);
assert.match((await scenario({ missingToken: true })).error?.message ?? '', /@fixture\/core.*no token/);
const resumed = await scenario({ existing: packages.map(p => p.name) });
assert.equal(resumed.error, undefined);
assert.equal(resumed.calls.filter(c => c.options.method === 'POST').length, 0, 'already published versions need no publish credentials');
assert.equal((await scenario({ existing: ['@fixture/core'] })).calls.filter(c => c.options.method === 'POST').length, 1);
console.log('npm trusted publisher preflight: expiry, ENEEDAUTH, sanitization, no retries, all siblings and resume passed');
