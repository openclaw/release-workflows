#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-go-cli.yml', import.meta.url));
const rubyExtractor = String.raw`
  workflow = Psych.safe_load(
    File.read(ARGV.fetch(0)),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  step = workflow.fetch('jobs').fetch('validate').fetch('steps').find do |candidate|
    candidate['id'] == 'metadata'
  end
  abort 'release metadata step not found' unless step
  print step.fetch('run')
`;
const metadataScript = execFileSync(
  'ruby',
  ['-rpsych', '-e', rubyExtractor, workflowPath],
  { encoding: 'utf8' },
);

function runMetadata(changelog, version = '1.2.3') {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'release-notes-extraction-'));
  const runnerTemp = join(fixtureRoot, 'runner-temp');
  const githubOutput = join(fixtureRoot, 'github-output');
  mkdirSync(runnerTemp);
  writeFileSync(join(fixtureRoot, 'CHANGELOG.md'), changelog);
  writeFileSync(join(fixtureRoot, 'go.mod'), 'module example.test/fixture\n\ngo 1.24\n');
  writeFileSync(join(fixtureRoot, '.goreleaser.yml'), 'version: 2\n');
  // Keep Bash 3.2 nounset behavior deterministic by making package_files non-empty.
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'fixture', version }));

  let thrown;
  try {
    execFileSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', metadataScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXTRA_PACKAGES: '[]',
        GITHUB_OUTPUT: githubOutput,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: '42',
        RELEASE_VERSION: version,
        RUNNER_TEMP: runnerTemp,
      },
      stdio: 'pipe',
    });
  } catch (error) {
    thrown = error;
  }

  const notesPath = join(runnerTemp, 'RELEASE-NOTES.md');
  const result = {
    notes: thrown ? undefined : readFileSync(notesPath, 'utf8'),
    output: thrown ? undefined : readFileSync(githubOutput, 'utf8'),
    stderr: thrown?.stderr?.toString() ?? '',
    thrown,
  };
  rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
}

const cases = [
  {
    name: 'version-first heading preserves exact section',
    changelog: '# Changelog\n\n## Unreleased\n\n- Future.\n\n## v1.2.3 - 2026-07-18\n\n- Exact café.\n\n## v1.2.2 - 2026-07-01\n\n- Older.\n',
    expected: '## v1.2.3 - 2026-07-18\n\n- Exact café.\n\n',
  },
  {
    name: 'date-first heading preserves exact section',
    changelog: '# Changelog\n\n## 2026-07-18 - [v1.2.3]\n\n- Date first.\n\n## 2026-07-01 - v1.2.2\n\n- Older.\n',
    expected: '## 2026-07-18 - [v1.2.3]\n\n- Date first.\n\n',
  },
  {
    name: 'fenced and commented headings remain section content',
    changelog: '# Changelog\n\n## v1.2.3 - 2026-07-18\n\n- Before examples.\n\n```md\n## example boundary\n## v1.2.3 - 2026-07-19\n```\n\n<!--\n## v1.2.3 - 2026-07-20\n-->\n\n- After examples.\n\n## v1.2.2 - 2026-07-01\n\n- Older.\n',
    expected: '## v1.2.3 - 2026-07-18\n\n- Before examples.\n\n```md\n## example boundary\n## v1.2.3 - 2026-07-19\n```\n\n<!--\n## v1.2.3 - 2026-07-20\n-->\n\n- After examples.\n\n',
  },
];

for (const fixture of cases) {
  const result = runMetadata(fixture.changelog);
  assert.equal(result.thrown, undefined);
  assert.equal(result.notes, fixture.expected);
  assert.equal(result.output, 'release-notes-artifact-name=release-notes-42-1\n');
  console.log(`PASS ${fixture.name}`);
}

const duplicate = runMetadata(
  '# Changelog\n\n## v1.2.3 - 2026-07-18\n\n- First.\n\n## 2026-07-19 - v1.2.3\n\n- Duplicate.\n',
);
assert.notEqual(duplicate.thrown, undefined);
assert.match(duplicate.stderr, /exactly one dated level-two section for 1\.2\.3; found 2/);
console.log('PASS duplicate dated version sections fail closed');

console.log(`release notes extraction tests passed (${cases.length + 1} scenarios)`);
