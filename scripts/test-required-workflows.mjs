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
assert.match(workflow, /^    runs-on: xcode-27$/m);
assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
assert.match(workflow, /fetch-depth: 0/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /test "\$GITHUB_REPOSITORY" = openclaw\/crabbox/);
assert.match(workflow, /test "\$GITHUB_BASE_REF" = main/);
assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
assert.match(workflow, /actions\/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e/);
assert.match(workflow, /goreleaser\/goreleaser-action@a4f02ab5355a589de60d917a659ce617ed19b3de/);
assert.match(workflow, /release --snapshot --clean --skip=publish --parallelism 1/);
assert.match(workflow, /crabbox-apple-vm-helper/);
assert.match(workflow, /"embedded":true/);
assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write|statuses: write|checks: write/);
assert.match(
  codeowners,
  /^\/\.github\/CODEOWNERS @vincentkoc @steipete$/m,
);
assert.match(
  codeowners,
  /^\/\.github\/workflows\/ @vincentkoc @steipete$/m,
);
assert.match(
  codeowners,
  /^\/scripts\/test-required-workflows\.mjs @vincentkoc @steipete$/m,
);
assert.match(
  codeowners,
  /^\/scripts\/validate-workflows\.sh @vincentkoc @steipete$/m,
);
assert.match(
  codeowners,
  /^\/scripts\/validate-workflow-contracts\.py @vincentkoc @steipete$/m,
);

console.log("required workflow contracts passed");
