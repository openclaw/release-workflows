const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.join(__dirname, 'fixtures/homebrew-clawdex-v0.2.2');
const attestations = Object.fromEntries(['arm64', 'x86_64'].map((architecture) => [
  architecture, JSON.parse(fs.readFileSync(path.join(fixtureRoot, `${architecture}.json`), 'utf8')),
]));
const formula = fs.readFileSync(path.join(fixtureRoot, 'clawdex.rb'), 'utf8');

// Execute the production evidence and formula validators, excluding tap dispatch/polling.
function verifyEvidence(source = formula, evidence = attestations) {
  const handoff = execFileSync('ruby', ['-rpsych', '-e', `
    workflow = Psych.safe_load(File.read(ARGV.fetch(0)), aliases: false)
    step = workflow.fetch('jobs').fetch('handoff').fetch('steps').find do |candidate|
      candidate['name'] == 'Dispatch configured tap and verify formula hashes'
    end
    print step.fetch('with').fetch('script')
  `, path.join(__dirname, '../.github/workflows/release-go-cli.yml')], { encoding: 'utf8' });
  const evidenceStart = handoff.indexOf("const fs = require('fs');");
  const evidenceEnd = handoff.indexOf("const [owner, repo] = process.env.HOMEBREW_TAP.split('/');");
  const formulaStart = handoff.indexOf('const verifyFormula = (source) => {');
  const formulaEnd = handoff.indexOf('\ndo {', formulaStart);
  assert.ok(evidenceStart >= 0 && evidenceEnd > evidenceStart && formulaStart > evidenceEnd && formulaEnd > formulaStart);
  const verify = new Function('context', 'process', 'require', 'source',
    `${handoff.slice(evidenceStart, evidenceEnd)}\n${handoff.slice(formulaStart, formulaEnd)}\nreturn verifyFormula(source);`);
  return verify({ repo: { owner: 'openclaw', repo: 'clawdex' }, runId: '34176514772' }, {
    env: {
      CHECKSUM_FILENAME: 'checksums.txt',
      TAG: 'v0.2.2',
      TARGET_SHA: 'be6d42dd9925d9ad4d158862cc6713d4a5da187a',
      VERIFICATION_PAYLOAD_ARTIFACT: 'release-verification-payload-34176514772-1',
      SOURCE_DEFAULT_BRANCH: 'main',
      PATH: process.env.PATH,
    },
  }, (name) => name === 'fs' ? {
    readFileSync: (filename) => {
      const architecture = filename.split('/')[1];
      assert.ok(['arm64', 'x86_64'].includes(architecture));
      return JSON.stringify(evidence[architecture]);
    },
  } : require(name), source);
}

async function smoke({ github, core }) {
  const { data } = await github.rest.repos.getContent({
    owner: 'openclaw', repo: 'homebrew-tap', path: 'Formula/clawdex.rb',
    ref: '23b68b2a5ae7b83957f18c786b92ec15a3ec8260',
  });
  assert.equal(data.encoding, 'base64');
  const publishedFormula = Buffer.from(data.content, 'base64').toString('utf8');
  assert.equal(publishedFormula, formula);
  const download = async (name) => {
    const response = await fetch(`https://github.com/openclaw/clawdex/releases/download/v0.2.2/${name}`);
    assert.equal(response.status, 200, `download ${name}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const checksums = await download('checksums.txt');
  assert.equal(checksums.toString('utf8'), attestations.arm64.sha256sums);
  assert.equal(checksums.toString('utf8'), attestations.x86_64.sha256sums);
  for (const line of checksums.toString('utf8').trimEnd().split('\n')) {
    const [sha256, name] = line.split('  ');
    const bytes = await download(name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, name);
    if (name === 'ASSET-INVENTORY.json') {
      assert.equal(bytes.toString('utf8'), attestations.arm64.assetInventory);
      assert.equal(bytes.toString('utf8'), attestations.x86_64.assetInventory);
    }
    core.info(`PASS live clawdex v0.2.2 published bytes: ${name}`);
  }
  assert.equal(verifyEvidence(publishedFormula).ok, true);
  core.info('PASS live clawdex v0.2.2 formula against both original attestations; no dispatch');
}

module.exports = { smoke, verifyEvidence };
