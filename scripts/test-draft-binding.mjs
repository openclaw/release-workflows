#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  step = workflow.fetch('jobs').fetch('publish').fetch('steps').find do |candidate|
    candidate['id'] == 'publish'
  end
  abort 'draft binding publisher step not found' unless step
  print step.fetch('with').fetch('script')
`;
const publisherScript = execFileSync(
  'ruby',
  ['-rpsych', '-e', rubyExtractor, workflowPath],
  { encoding: 'utf8' },
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executePublisher = new AsyncFunction('github', 'context', 'core', 'process', 'require', publisherScript);
const require = createRequire(import.meta.url);

const repository = 'openclaw/fixture';
const tag = 'v1.2.3';
const targetSha = 'a'.repeat(40);
const runId = '29634760700';
const runAttempt = '1';
const verificationPayloadArtifact = `release-verification-payload-${runId}-${runAttempt}`;
const releaseNotes = '## v1.2.3 - 2026-07-18\n\n- Ship the verified fixture.\n\n';

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

function replaceChecksum(sha256sums, name, data) {
  let replaced = false;
  const lines = sha256sums.trimEnd().split('\n').map((line) => {
    if (!line.endsWith(`  ${name}`)) return line;
    replaced = true;
    return `${digest(data)}  ${name}`;
  });
  assert.equal(replaced, true, `missing checksum fixture for ${name}`);
  return `${lines.join('\n')}\n`;
}

function baseFixture() {
  const assetInventory = '{"schemaVersion":1,"repository":"openclaw/fixture"}\n';
  const payloads = new Map([
    ['ASSET-INVENTORY.json', Buffer.from(assetInventory)],
    ['RELEASE-NOTES.md', Buffer.from(releaseNotes)],
    ['SIGNING-MANIFEST.json', Buffer.from('{"binaries":[]}\n')],
    ['fixture.tar.gz', Buffer.from('signed-notarized-binary-payload')],
  ]);
  const sha256sums = [...payloads]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, data]) => `${digest(data)}  ${name}\n`)
    .join('');
  const draftAssets = new Map(payloads);
  draftAssets.set('SHA256SUMS', Buffer.from(sha256sums));
  const attestations = Object.fromEntries(['arm64', 'x86_64'].map((architecture) => [architecture, {
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
    releaseNotes,
    sha256sums,
  }]));
  return { attestations, draftAssets };
}

async function runScenario(mutate = () => {}, publisherRunAttempt = runAttempt) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'release-draft-binding-'));
  const originalCwd = process.cwd();
  const fixture = baseFixture();
  mutate(fixture);
  for (const architecture of ['arm64', 'x86_64']) {
    const directory = join(fixtureRoot, 'verified-inventory-attestations', architecture);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'verified-inventory-attestation.json'), JSON.stringify(fixture.attestations[architecture]));
  }

  const assets = [...fixture.draftAssets].map(([name], index) => ({ id: index + 1, name }));
  const dataById = new Map(assets.map((asset) => [asset.id, fixture.draftAssets.get(asset.name)]));
  let updateCalls = 0;
  const updateRequests = [];
  const outputs = new Map();
  const failures = [];
  const github = {
    paginate: async () => assets,
    request: async (_route, request) => ({ data: dataById.get(request.asset_id) }),
    rest: {
      git: {
        getRef: async () => ({ data: { object: { type: 'tag', sha: 'b'.repeat(40) } } }),
        getTag: async () => ({ data: { object: { type: 'commit', sha: targetSha } } }),
      },
      repos: {
        getRelease: async () => ({ data: { draft: true, tag_name: tag } }),
        listReleaseAssets: async () => {},
        updateRelease: async (request) => {
          updateCalls += 1;
          updateRequests.push(request);
          return {
            data: {
              body: request.body,
              draft: false,
              published_at: '2026-07-18T00:00:00Z',
              html_url: 'https://example.test/release',
            },
          };
        },
      },
    },
  };
  const context = { repo: { owner: 'openclaw', repo: 'fixture' } };
  const core = {
    setFailed: (message) => failures.push(message),
    setOutput: (name, value) => outputs.set(name, value),
  };
  let thrown;
  try {
    process.chdir(fixtureRoot);
    await executePublisher(github, context, core, {
      env: {
        GITHUB_RUN_ATTEMPT: publisherRunAttempt,
        GITHUB_RUN_ID: runId,
        RELEASE_ID: '42',
        TAG: tag,
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
  return { failures, outputs, thrown, updateCalls, updateRequests };
}

const tests = [
  ['exact draft bytes publish', async () => {
    const result = await runScenario();
    assert.equal(result.thrown, undefined);
    assert.deepEqual(result.failures, []);
    assert.equal(result.updateCalls, 1);
    assert.equal(result.updateRequests[0].body, releaseNotes);
    assert.equal(result.outputs.get('release-url'), 'https://example.test/release');
  }],
  ['partial publisher rerun reuses producer-bound attestations', async () => {
    const result = await runScenario(() => {}, '2');
    assert.equal(result.thrown, undefined);
    assert.equal(result.updateCalls, 1);
  }],
  ['extra draft asset fails closed', async () => {
    const result = await runScenario(({ draftAssets }) => draftAssets.set('extra.txt', Buffer.from('extra')));
    assert.match(result.thrown?.message, /inventory mismatch/);
    assert.equal(result.updateCalls, 0);
  }],
  ['missing draft asset fails closed', async () => {
    const result = await runScenario(({ draftAssets }) => draftAssets.delete('fixture.tar.gz'));
    assert.match(result.thrown?.message, /inventory mismatch/);
    assert.equal(result.updateCalls, 0);
  }],
  ['renamed draft asset fails closed', async () => {
    const result = await runScenario(({ draftAssets }) => {
      const data = draftAssets.get('fixture.tar.gz');
      draftAssets.delete('fixture.tar.gz');
      draftAssets.set('renamed.tar.gz', data);
    });
    assert.match(result.thrown?.message, /inventory mismatch/);
    assert.equal(result.updateCalls, 0);
  }],
  ['changed draft asset bytes fail closed', async () => {
    const result = await runScenario(({ draftAssets }) => draftAssets.set('fixture.tar.gz', Buffer.from('changed')));
    assert.match(result.thrown?.message, /digest mismatch/);
    assert.equal(result.updateCalls, 0);
  }],
  ['missing release notes fail closed', async () => {
    const result = await runScenario(({ draftAssets }) => draftAssets.delete('RELEASE-NOTES.md'));
    assert.match(result.thrown?.message, /inventory mismatch/);
    assert.equal(result.updateCalls, 0);
  }],
  ['architecture release-note disagreement fails closed', async () => {
    const result = await runScenario(({ attestations }) => {
      attestations.x86_64.releaseNotes = `${releaseNotes}- unverified addition\n`;
    });
    assert.match(result.thrown?.message, /release notes differ between arm64 and x86_64/);
    assert.equal(result.updateCalls, 0);
  }],
  ['architecture asset-inventory disagreement fails closed', async () => {
    const result = await runScenario(({ attestations }) => {
      attestations.x86_64.assetInventory = '{"schemaVersion":1,"repository":"other/fixture"}\n';
    });
    assert.match(result.thrown?.message, /asset inventory differs between arm64 and x86_64/);
    assert.equal(result.updateCalls, 0);
  }],
  ['draft notes must equal attested body even with consistent checksums', async () => {
    const result = await runScenario(({ attestations, draftAssets }) => {
      const changedNotes = Buffer.from(`${releaseNotes}- draft-only addition\n`);
      draftAssets.set('RELEASE-NOTES.md', changedNotes);
      const changedChecksums = replaceChecksum(attestations.arm64.sha256sums, 'RELEASE-NOTES.md', changedNotes);
      draftAssets.set('SHA256SUMS', Buffer.from(changedChecksums));
      attestations.arm64.sha256sums = changedChecksums;
      attestations.x86_64.sha256sums = changedChecksums;
    });
    assert.match(result.thrown?.message, /RELEASE-NOTES\.md bytes differ from verified attestation/);
    assert.equal(result.updateCalls, 0);
  }],
  ['attestation checksum disagreement fails closed', async () => {
    const result = await runScenario(({ attestations }) => {
      attestations.x86_64.sha256sums = attestations.x86_64.sha256sums.replace(/[0-9a-f]/, 'f');
    });
    assert.match(result.thrown?.message, /differs between arm64 and x86_64/);
    assert.equal(result.updateCalls, 0);
  }],
  ['draft inventory must equal attested bytes even with consistent checksums', async () => {
    const result = await runScenario(({ attestations, draftAssets }) => {
      const changedInventory = Buffer.from('{"schemaVersion":1,"repository":"other/fixture"}\n');
      draftAssets.set('ASSET-INVENTORY.json', changedInventory);
      const changedChecksums = replaceChecksum(attestations.arm64.sha256sums, 'ASSET-INVENTORY.json', changedInventory);
      draftAssets.set('SHA256SUMS', Buffer.from(changedChecksums));
      attestations.arm64.sha256sums = changedChecksums;
      attestations.x86_64.sha256sums = changedChecksums;
    });
    assert.match(result.thrown?.message, /ASSET-INVENTORY\.json bytes differ from verified attestation/);
    assert.equal(result.updateCalls, 0);
  }],
  ['non-verified verdict fails closed', async () => {
    const result = await runScenario(({ attestations }) => { attestations.arm64.verdict = 'failed'; });
    assert.match(result.thrown?.message, /verdict mismatch/);
    assert.equal(result.updateCalls, 0);
  }],
  ['changed draft SHA256SUMS bytes fail closed', async () => {
    const result = await runScenario(({ draftAssets }) => {
      const changed = Buffer.concat([draftAssets.get('SHA256SUMS'), Buffer.from('\n')]);
      draftAssets.set('SHA256SUMS', changed);
    });
    assert.match(result.thrown?.message, /SHA256SUMS bytes differ/);
    assert.equal(result.updateCalls, 0);
  }],
];

for (const [name, test] of tests) {
  await test();
  console.log(`PASS ${name}`);
}
console.log(`draft binding tests passed (${tests.length} scenarios)`);
