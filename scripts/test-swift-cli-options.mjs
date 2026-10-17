#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const workflow = loadWorkflow('release-swift-cli.yml');
const inputs = workflow.true.workflow_call.inputs;
assert.equal(inputs.dry_run.default, false, 'existing callers retain live-release behavior');
for (const name of ['include-helper', 'include-linux', 'require-resource-bundles']) {
  assert.equal(inputs[name].default, true, `${name} preserves the imsg contract`);
}

const script = workflowStep(workflow, 'validate', 'id', 'source').with.script;
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'process', script);
async function resolve({ dry = true, tag = true, signed = false, event = 'workflow_dispatch', sha = 'b'.repeat(40) } = {}) {
  const calls = [], outputs = {}, failures = [];
  const github = { rest: {
    repos: {
      get: async () => ({ data: { default_branch: 'main' } }),
      getBranch: async () => ({ data: { protected: true, commit: { sha: 'b'.repeat(40) } } }),
      compareCommitsWithBasehead: async () => ({ data: { status: 'ahead' } }),
      getReleaseByTag: async () => { throw Object.assign(new Error('missing'), { status: 404 }); },
    },
    git: {
      getRef: async () => {
        calls.push('tag');
        if (!tag) throw Object.assign(new Error('missing'), { status: 404 });
        return { data: { object: { type: 'tag', sha: 'c'.repeat(40) } } };
      },
      getTag: async () => ({ data: { object: { type: 'commit', sha: 'a'.repeat(40) } } }),
    },
  } };
  const context = { repo: { owner: 'openclaw', repo: 'fixture' }, eventName: event,
    ref: event === 'push' ? 'refs/tags/v1.2.3' : 'refs/heads/main', sha };
  const core = { info() {}, setOutput: (key, value) => { outputs[key] = value; }, setFailed: msg => failures.push(msg) };
  await execute(github, context, core, { env: { TAG: 'v1.2.3', DRY_RUN: String(dry), REQUIRE_SIGNED_TAG: String(signed) } });
  return { calls, outputs, failures };
}
const dry = await resolve();
assert.deepEqual(dry.calls, [], 'dry runs never resolve a historical tag');
assert.equal(dry.outputs['target-sha'], 'b'.repeat(40));
assert.deepEqual(dry.failures, []);
const live = await resolve({ dry: false });
assert.equal(live.outputs['target-sha'], 'a'.repeat(40));
const push = await resolve({ dry: false, event: 'push', sha: 'a'.repeat(40) });
assert.equal(push.outputs['target-sha'], 'a'.repeat(40));
await assert.rejects(resolve({ dry: false, event: 'push', sha: 'e'.repeat(40) }), /tag event/);
assert.equal((await resolve({ sha: 'e'.repeat(40) })).outputs['target-sha'], undefined);
await assert.rejects(resolve({ dry: false, tag: false, signed: true }), /signed release tag required/);
assert.equal((await resolve({ signed: true })).outputs['target-sha'], 'b'.repeat(40));

for (const name of ['tag', 'draft', 'publish', 'handoff', 'closeout']) {
  assert.match(workflow.jobs[name].if, /!inputs.dry_run/, `${name} must never write during rehearsal`);
}
assert.match(workflow.jobs.sign.if, /needs.build-linux.result == 'skipped'/);
assert.match(workflow.jobs.verify.if, /needs.draft.result == 'skipped'/);
for (const name of ['draft', 'publish']) {
  assert.match(workflow.jobs[name].if, /always\(\)/, `${name} must allow a skipped Linux ancestor`);
  assert.match(workflow.jobs[name].if, /!cancelled\(\)/, `${name} must not publish after cancellation`);
  assert.match(workflow.jobs[name].if, /needs\.[a-z]+\.result == 'success'/);
}
assert.equal(workflow.jobs['build-linux'].if, '${{ inputs.include-linux }}');
assert.match(workflowStep(workflow, 'verify', 'name', 'Verify exact Swift inventory, signatures, architectures, and notarization').run,
  /uname -m/, 'both verifiers check their actual native architecture');
console.log('Swift optional payload and dry-run contracts passed');

// Exercise the actual inventory and verifier shells with synthetic signed payloads.
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { spawnSync } = await import('node:child_process');
const freeze = workflowStep(workflow, 'sign', 'name', 'Freeze exact asset inventory and checksums').run;
const verify = workflowStep(workflow, 'verify', 'name', 'Verify exact Swift inventory, signatures, architectures, and notarization').run
  .replaceAll('${{ needs.sign.outputs.artifact-name }}', 'synthetic-payload');
function shell(source, cwd, env, ok = true) {
  const result = spawnSync('bash', ['-c', source], { cwd, env, encoding: 'utf8' });
  if (ok) assert.equal(result.status, 0, result.stdout + result.stderr);
  else assert.notEqual(result.status, 0, 'invalid payload was accepted');
}
for (const helper of [false, true]) for (const linux of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'swift-options-'));
  try {
    for (const dir of ['tools', 'release-assets', 'raw-linux', 'frozen-notes', 'fixture']) mkdirSync(join(root, dir));
    const tool = (name, text) => writeFileSync(join(root, 'tools', name), '#!/bin/bash\nset -eu\n' + text, { mode: 0o755 });
    tool('stat', 'wc -c < "${@: -1}"\n');
    tool('uname', 'echo arm64\n');
    tool('sw_vers', 'echo 26.0\n');
    tool('lipo', 'test -f "${@: -1}"\necho "arm64e arm64 x86_64"\n');
    tool('codesign', 'test -f "${@: -1}"\n');
    tool('file', 'echo "ELF 64-bit LSB executable, x86-64"\n');
    const env = { ...process.env, PATH: join(root, 'tools') + ':' + process.env.PATH,
      GITHUB_REPOSITORY: 'openclaw/fixture', GITHUB_RUN_ID: '123',
      TAG: 'v1.2.3', TARGET_SHA: 'b'.repeat(40), DRY_RUN: 'true',
      INCLUDE_HELPER: String(helper), INCLUDE_LINUX: String(linux), REQUIRE_RESOURCE_BUNDLES: String(helper),
      MINIMUM_MACOS_VERSION: '14', EXPECTED_ARCH: 'arm64', REPOSITORY_TYPE: 'openclaw',
      BINARY_NAME: 'fixture', BINARY_IDENTIFIER: 'org.fixture.cli',
      HELPER_NAME: helper ? 'helper.dylib' : '', HELPER_IDENTIFIER: helper ? 'org.fixture.helper' : '',
      CHECKSUM_FILENAME: 'SHA256SUMS', MACOS_ARCHIVE_NAME: 'fixture.zip', LINUX_ARCHIVE_NAME: 'fixture.tar.gz' };
    writeFileSync(join(root, 'fixture/fixture'), '#!/bin/bash\nif [[ $1 == --version ]]; then echo 1.2.3; fi\n', { mode: 0o755 });
    if (helper) {
      writeFileSync(join(root, 'fixture/helper.dylib'), 'synthetic helper');
      mkdirSync(join(root, 'fixture/data.bundle'));
    }
    shell('cd fixture && zip -qr ../release-assets/fixture.zip .', root, env);
    shell('tar -czf raw-linux/fixture.tar.gz -C fixture fixture', root, env);
    writeFileSync(join(root, 'release-assets/SIGNING-MANIFEST.json'), '{}\n');
    writeFileSync(join(root, 'frozen-notes/RELEASE-NOTES.md'), '## 1.2.3 - 2026-10-16\n\n- Fixture.\n');
    shell(freeze, root, env);
    const inventory = JSON.parse(readFileSync(join(root, 'release-assets/ASSET-INVENTORY.json')));
    assert.equal(inventory.payloads.length, linux ? 2 : 1);
    assert.equal(inventory.dryRun, true);
    shell(verify, root, env);
    shell(verify, root, { ...env, EXPECTED_ARCH: 'x86_64' }, false);
    console.log(`PASS actual verifier shell: helper=${helper}, linux=${linux}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const inputScript = workflowStep(workflow, 'validate', 'id', 'inputs').run;
const inputRoot = mkdtempSync(join(tmpdir(), 'swift-inputs-'));
try {
  const env = { ...process.env, GITHUB_OUTPUT: join(inputRoot, 'outputs'), VERSION: '1.2.3' };
  const stepEnv = workflowStep(workflow, 'validate', 'id', 'inputs').env;
  for (const [name, expression] of Object.entries(stepEnv)) {
    const input = expression.match(/inputs\.([^ }]+)/)?.[1];
    if (input && name !== 'VERSION') env[name] = String(inputs[input].default ?? 'openclaw');
  }
  shell(inputScript, inputRoot, env);
  const optional = { ...env, INCLUDE_HELPER: 'false', INCLUDE_LINUX: 'false', HELPER_NAME: '',
    HELPER_IDENTIFIER: '', LINUX_ARCHIVE_NAME: '', LINUX_BUILD_SCRIPT: '', PREPARE_SCRIPT: '',
    GENERATE_VERSION_SCRIPT: '', ENTITLEMENTS_FILE: '', VERSION_FILE: '',
    METADATA_CHECK_SCRIPT: 'scripts/metadata.sh' };
  shell(inputScript, inputRoot, optional);
  shell(inputScript, inputRoot, { ...optional, INCLUDE_HELPER: 'true' }, false);
  shell(inputScript, inputRoot, { ...optional, METADATA_CHECK_SCRIPT: '' }, false);
  shell(inputScript, inputRoot, { ...optional, MACOS_BUILD_SCRIPT: '../unsafe.sh' }, false);
} finally { rmSync(inputRoot, { recursive: true, force: true }); }

const signerScript = workflowStep(workflow, 'sign', 'name', 'Sign and notarize exact macOS payload').run;
const signerPreflight = signerScript.slice(0, signerScript.indexOf('cli_requirement='));
for (const reserved of ['release.entitlements', 'helper.dylib']) {
  const root = mkdtempSync(join(tmpdir(), 'swift-reserved-'));
  try {
    mkdirSync(join(root, 'fixture'));
    mkdirSync(join(root, 'raw-macos'));
    writeFileSync(join(root, 'fixture/fixture'), 'synthetic executable', { mode: 0o755 });
    writeFileSync(join(root, 'fixture', reserved), 'unexpected artifact');
    const env = { ...process.env, BINARY_NAME: 'fixture', HELPER_NAME: 'helper.dylib',
      INCLUDE_HELPER: 'false', ENTITLEMENTS_ENABLED: 'false' };
    shell('tar -czf raw-macos/raw-swift-macos.tar.gz -C fixture .', root, env);
    shell(signerPreflight, root, env, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const metadata = workflowStep(workflow, 'validate', 'id', 'metadata').run;
const metadataRoot = mkdtempSync(join(tmpdir(), 'swift-root-validator-'));
try {
  for (const name of ['Package.swift', 'Package.resolved', 'build.sh']) writeFileSync(join(metadataRoot, name), 'fixture');
  writeFileSync(join(metadataRoot, 'CHANGELOG.md'), '## 1.2.3 - 2026-10-16\n\n- Fixture.\n');
  writeFileSync(join(metadataRoot, 'check-version.sh'), '#!/bin/sh\n[ "$1" = v1.2.3 ] && touch validator-ran\n', { mode: 0o755 });
  const env = { ...process.env, RUNNER_TEMP: metadataRoot, GITHUB_OUTPUT: join(metadataRoot, 'outputs'),
    RELEASE_VERSION: '1.2.3', METADATA_CHECK_SCRIPT: 'check-version.sh', MACOS_BUILD_SCRIPT: 'build.sh',
    VERSION_FILE: '', LINUX_BUILD_SCRIPT: '', INCLUDE_LINUX: 'false', PREPARE_SCRIPT: '',
    GENERATE_VERSION_SCRIPT: '', ENTITLEMENTS_FILE: '', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  shell('git init -q && git add . && git -c user.name=Fixture -c user.email=fixture@example.com -c commit.gpgsign=false commit -qm fixture', metadataRoot, env);
  shell(metadata, metadataRoot, env);
  assert.equal(readFileSync(join(metadataRoot, 'validator-ran')).length, 0);
} finally { rmSync(metadataRoot, { recursive: true, force: true }); }
