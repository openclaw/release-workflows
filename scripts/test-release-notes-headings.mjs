#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMarkedSource, loadWorkflow, workflowStep } from './workflow-source.cjs';

const heading = '## v1.2.3 - 2026-09-13';
const older = '## v1.2.2 - 2026-09-01\n\n- Older.\n';
const sections = [
  `${heading}\n\n- Exact café.\n\n`,
  `${heading}\n\n\`\`\`md\n## example boundary\n${heading}\n\`\`\`\n\n- After code.\n\n`,
  `${heading}\n\n~~~~md\n${heading}\n~~~\n## Still inside code\n~~~~\n\n- After tilde fence.\n\n`,
  `${heading}\n\n<!--\n${heading}\n-->\n\n- After comment.\n\n`,
  `${heading}\r\n\r\n- Preserve CRLF café.\r\n\r\n`,
  `${heading}\n\n- Literal \`<!--\` marker.\n\n`,
  `${heading}\n\n- Escaped \\<!-- marker.\n\n`,
  `${heading}\n\n- Double-tick \`\`a \` <!-- example\`\` span.\n\n`,
  `${heading}\n\n- Multiline \`code\nliteral <!-- text\nends here\` span.\n\n`,
  `${heading}\n\n- Unmatched backtick \` before a paragraph boundary.\n\n<!--\n${heading}\n-->\n\n`,
  `${heading}\n\nUnmatched \`code\n<!-- real comment block with a \` delimiter\n## Hidden boundary\n-->\n\n- After comment.\n\n`,
  `${heading}\n\n- Short <!--> inline comment.\n\n`,
  `${heading}\n\n- Short <!---> inline comment.\n\n`,
  `${heading}\n\n- Inline <!-- comment\ncloses on a soft break --> here.\n\n`,
];
let failures = 0;
for (const archetype of ['go-cli', 'swift-cli', 'electron']) {
  const metadata = workflowStep(loadWorkflow(`release-${archetype}.yml`), 'validate', 'id', 'metadata').run;
  const program = extractMarkedSource(metadata, "<<'PY'\n", '\nPY');
  const cases = [
    ...sections.map((section, index) => ({ name: `exact section ${index + 1}`, text: `# Changelog\n\n${section}${older}`, expected: section })),
    { name: 'commented version before actual section', text: `<!--\n${heading}\n-->\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'duplicate real headings', text: `${sections[0]}${sections[0]}`, error: /found 2/ },
    { name: 'version only inside code', text: `\`\`\`md\n${heading}\n\`\`\`\n${older}`, error: /found 0/ },
    { name: 'undated heading', text: '## v1.2.3\n\n- Undated.\n', error: /found 0/ },
    { name: 'invalid backtick fence info is ordinary text', text: `\`\`\`lang\`example\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'tilde fence permits backticks in info', text: `~~~lang\`example\n${heading}\n~~~\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'invalid fence does not interrupt inline code', text: `Literal \`<!--\n\`\`\`lang\`example\n\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'HTML comment block waits for its block terminator', text: `<!-- ordinary block\n${heading}\n-->\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'short empty comment closes its block', text: `<!-->\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'overlapping short comment closes its block', text: `<!--->\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'unmatched inline comment stops at a blank line', text: `Prose containing <!--\n\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'unmatched inline comment stops at a heading', text: `Prose containing <!--\n${sections[0]}${older}`, expected: sections[0] },
    { name: 'indented literal opener cannot hide a release', text: `    <!-- literal code\n\n${sections[0]}${older}`, expected: sections[0] },
  ];
  for (const fixture of cases) {
    const root = mkdtempSync(join(tmpdir(), 'release-notes-headings-'));
    try {
      writeFileSync(join(root, 'CHANGELOG.md'), fixture.text);
      const output = join(root, 'notes.md');
      const result = spawnSync('python3', ['-c', program, '1.2.3', output], { cwd: root, encoding: 'utf8' });
      if (fixture.error) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, fixture.error);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), fixture.expected);
      }
      console.log(`PASS ${archetype}: ${fixture.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${archetype}: ${fixture.name}: ${error.message}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
assert.equal(failures, 0, 'release note extraction must preserve visible Markdown sections exactly');
