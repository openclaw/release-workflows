#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/crabbox-release-check.yml", "utf8");
const codeowners = fs.readFileSync(".github/CODEOWNERS", "utf8");

assert.match(workflow, /^name: Crabbox Release Check$/m);
assert.match(workflow, /^  pull_request:$/m);
assert.match(workflow, /^permissions:\n  contents: read$/m);
assert.match(workflow, /^    name: Release Check$/m);
assert.match(workflow, /^    if: github\.repository == 'openclaw\/crabbox'$/m);
assert.match(workflow, /^    runs-on: macos-15$/m);
assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
assert.match(workflow, /fetch-depth: 0/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /test "\$GITHUB_REPOSITORY" = openclaw\/crabbox/);
assert.match(workflow, /test "\$GITHUB_BASE_REF" = main/);
assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
assert.match(workflow, /actions\/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16/);
assert.match(workflow, /goreleaser\/goreleaser-action@f06c13b6b1a9625abc9e6e439d9c05a8f2190e94/);
assert.match(workflow, /release --snapshot --clean --skip=publish --parallelism 1/);
assert.match(workflow, /crabbox-apple-vm-helper/);
assert.match(workflow, /"embedded":true/);
assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write|statuses: write|checks: write/);
assert.match(codeowners, /^\/\.github\/workflows\/ @openclaw\/openclaw-secops$/m);
assert.match(codeowners, /^\/scripts\/test-required-workflows\.mjs @openclaw\/openclaw-secops$/m);
assert.match(codeowners, /^\/scripts\/validate-workflows\.sh @openclaw\/openclaw-secops$/m);

console.log("required workflow contracts passed");
