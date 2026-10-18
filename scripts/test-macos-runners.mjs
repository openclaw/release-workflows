#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { loadWorkflow } from './workflow-source.cjs';
import { spawnSync } from 'node:child_process';

// Resolve the runner expressions with public inputs, including existing v1 callers.
function runner(value, inputs) {
  if (!value.startsWith('${{')) return value;
  const expression = value.slice(3, -2).replace(/inputs\.([\w-]+)/g, (_, name) => `inputs[${JSON.stringify(name)}]`);
  return new Function('inputs', 'startsWith', `return (${expression})`)(inputs, (a, b) => a.startsWith(b));
}
for (const file of readdirSync('.github/workflows').filter(f => /\.ya?ml$/.test(f))) {
  const workflow = loadWorkflow(file);
  for (const job of Object.values(workflow.jobs)) {
    const value = job['runs-on'];
    if (typeof value === 'string') assert.doesNotMatch(value, /['"]?macos-(?:13|14|15|26|latest)(?:['"]|$)/);
    for (const row of job.strategy?.matrix?.include ?? []) {
      if (row.runner && !row.runner.startsWith('${{')) assert.doesNotMatch(row.runner, /^macos-/);
    }
  }
}
for (const [file, jobName, input, legacy] of [
  ['release-swift-cli.yml', 'build-macos', 'macos-runner', ['macos-14', 'macos-15', 'macos-26']],
  ['release-sparkle-app.yml', 'build', 'build-runner', ['macos-15', 'macos-15-intel', 'macos-26']],
  ['release-source.yml', 'build', 'test-runs-on', ['macos-latest', 'macos-15', 'macos-15-intel', 'macos-26']],
]) {
  const job = loadWorkflow(file).jobs[jobName];
  for (const label of ['xcode-27', ...legacy]) assert.equal(runner(job['runs-on'], { [input]: label }), 'xcode-27');
  assert.equal(runner(job['runs-on'], { [input]: 'xcode-27-xlarge' }), 'xcode-27-xlarge');
}
for (const file of ['release-go-cli.yml', 'release-swift-cli.yml', 'release-electron.yml', 'release-sparkle-app.yml']) {
  const job = loadWorkflow(file).jobs.verify;
  const scripts = job.steps.map(s => s.run ?? '').join('\n');
  assert.match(scripts, /if ! arch -x86_64 \/usr\/bin\/true; then\n\s+sudo softwareupdate --install-rosetta --agree-to-license\n\s+fi\n\s+arch -x86_64 \/usr\/bin\/true/);
  assert.ok(job.strategy.matrix.include.some(row => row.arch === 'x86_64' && row.runner === 'xcode-27'));
}
const sparkle = loadWorkflow('release-sparkle-app.yml').jobs;
assert.deepEqual(sparkle.verify.strategy.matrix.include.map(row => row.verifier), ['arm64', 'x86_64', 'runtime-audit']);
assert.match(JSON.stringify(sparkle.verify), /matrix.verifier/);
const swift = loadWorkflow('release-swift-cli.yml');
const build = swift.jobs['build-macos'].steps.find(s => s.name === 'Build universal CLI, helper dylib, and resource bundles').run;
const deployment = build.split('OUTPUT_DIR="$output" python3 - <<\'PY\'\n')[1].split('\nPY')[0];
for (const [load, accepted] of [
  ['Load command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 14.0\n', true],
  ['Load command 0\n cmd LC_VERSION_MIN_MACOSX\n version 13.0\n', true],
  ['Load command 0\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 15.0\n', false],
  ['Load command 0\n cmd LC_BUILD_VERSION\n platform 6\n minos 14.0\n', false],
  ['Load command 0\n cmd LC_BUILD_VERSION\n platform 1\n', false],
]) {
  const mock = `import subprocess\nsubprocess.check_output = lambda args, **kwargs: 'arm64 x86_64' if args[0] == 'lipo' else ${JSON.stringify(load)}\n`;
  const result = spawnSync('python3', ['-c', mock + deployment], { encoding: 'utf8', env: {
    ...process.env, MACOSX_DEPLOYMENT_TARGET: '14', OUTPUT_DIR: '.', BINARY_NAME: 'fixture', INCLUDE_HELPER: 'false',
  } });
  assert.equal(result.status === 0, accepted, result.stderr);
}
console.log('macOS 27 runner selection, v1 aliases, Rosetta preflight, and distinct verifier IDs passed');
