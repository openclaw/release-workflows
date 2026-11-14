#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadWorkflow, workflowStep } from "./workflow-source.cjs";

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

const parsed = loadWorkflow("crabbox-release-check.yml");
const step = (name) => workflowStep(parsed, "release-check", "name", name);
const identity = step("Verify target identity");
const admission = workflowStep(parsed, "release-check", "id", "admission");
assert.deepEqual(Object.keys(parsed.on ?? parsed.true), ["pull_request"]);
assert.equal(identity.if, undefined);
assert.equal(step("Verify Apple Silicon runner").if, undefined);
assert.equal(admission.if, undefined);
assert.deepEqual(admission.env, {
  PR_NUMBER: "${{ github.event.pull_request.number }}",
  PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
  PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
  PR_BASE_REPOSITORY: "${{ github.event.pull_request.base.repo.full_name }}",
  PR_BASE_REF: "${{ github.event.pull_request.base.ref }}",
});
for (const name of ["Set up Go", "Snapshot release build", "Verify snapshot helper embeds VM daemon"]) {
  assert.equal(step(name).if, "steps.admission.outputs.snapshot-required != '0'");
}
assert.equal(parsed.jobs["release-check"]["continue-on-error"], undefined);
assert.ok(parsed.jobs["release-check"].steps.every((entry) => entry["continue-on-error"] === undefined));

// Git plumbing constructs only disposable fixtures; execute the Psych-loaded production blocks.
const root = fs.mkdtempSync(path.join(tmpdir(), "required-snapshot-"));
const checkout = path.join(root, "checkout");
fs.mkdirSync(checkout);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});
const git = (args, input) => execFileSync("git", args, { cwd: checkout, env, input, encoding: "utf8" }).trim();
const tree = (base, files) => {
  git(base ? ["read-tree", base] : ["read-tree", "--empty"]);
  for (const [name, value] of Object.entries(files)) {
    if (value === null) {
      git(["update-index", "--force-remove", "--", name]);
    } else {
      const { mode = "100644", content = value, oid } = typeof value === "object" ? value : {};
      const blob = oid ?? git(["hash-object", "-w", "--stdin"], content);
      git(["update-index", "--add", "--cacheinfo", mode, blob, name]);
    }
  }
  return git(["write-tree"]);
};
const commit = (sourceTree, parents = []) => git(["commit-tree", sourceTree, ...parents.flatMap((parent) => ["-p", parent])], "fixture\n");
let cases = 0;
try {
  git(["init", "-q"]);
  const base = commit(tree(null, {
    "README.md": "readme\n", "CHANGELOG.md": "changelog\n", "docs/guide.md": "guide\n",
    "docs/delete.md": "delete\n", "main.go": "package main\n",
  }));
  const make = (files, parent = base) => {
    const head = commit(tree(parent, files), [parent]);
    return { base: parent, head, merge: commit(git(["rev-parse", `${head}^{tree}`]), [parent, head]) };
  };
  const docs = make({ "docs/guide.md": "updated\n" });
  const check = (name, revision, expected, overrides = {}, fatal = false) => {
    git(["checkout", "--detach", "-q", "-f", revision.merge]);
    const output = path.join(root, "output");
    fs.writeFileSync(output, "");
    const runEnv = {
      ...env, GITHUB_REPOSITORY: "openclaw/crabbox", GITHUB_BASE_REF: "main",
      GITHUB_SHA: revision.merge, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/42/merge",
      GITHUB_OUTPUT: output, PR_NUMBER: "42", PR_BASE_SHA: revision.base, PR_HEAD_SHA: revision.head,
      PR_BASE_REPOSITORY: "openclaw/crabbox", PR_BASE_REF: "main", ...overrides,
    };
    const execute = (source) => spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", source], {
      cwd: checkout, env: runEnv, encoding: "utf8",
    });
    const verified = execute(identity.run);
    if (fatal) {
      assert.notEqual(verified.status, 0, `${name}: identity must fail`);
      assert.equal(fs.readFileSync(output, "utf8"), "");
    } else {
      assert.equal(verified.status, 0, `${name}: ${verified.stderr}`);
      const result = execute(admission.run);
      assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
      assert.equal(fs.readFileSync(output, "utf8"), `snapshot-required=${expected}\n`, name);
    }
    cases += 1;
  };

  check("documentation edit", docs, "0");
  check("root documentation", make({ "README.md": "new\n", "CHANGELOG.md": "new\n" }), "0");
  check("empty documentation blob", make({ "docs/empty.md": "" }), "0");
  check("documentation deletion", make({ "docs/delete.md": null }), "0");
  check("documentation rename", make({ "docs/guide.md": null, "docs/new.md": "guide\n" }), "0");
  check("executable regular documentation", make({ "docs/guide.md": { mode: "100755", content: "guide\n" } }), "0");
  check("unusual documentation names", make({
    "docs/with space.md": "space", "docs/with\ttab.md": "tab", "docs/with\nnewline.md": "newline",
    "docs/back\\slash.md": "slash", "docs/-option.md": "dash", "docs/文档.md": "unicode",
  }), "0");
  check("mixed changes", make({ "docs/guide.md": "updated", "main.go": "changed" }), "1");
  check("code deletion", make({ "main.go": null }), "1");
  check("code moved into docs", make({ "main.go": null, "docs/main.go": "package main\n" }), "1");
  check("docs moved into code", make({ "docs/guide.md": null, "guide.go": "guide\n" }), "1");
  for (const name of ["internal/runner/runnerfs/example_test.go", "example_test.go", ".goreleaser.yaml", "go.mod", "scripts/build-vmd.sh", "vmd/Package.swift", "README.md.extra", "other/README.md", "Docs/guide.md", "docs-prefix.md", "docs"]) {
    const changes = name === "docs" ? { "docs/guide.md": null, "docs/delete.md": null, docs: "file" } : { [name]: "changed" };
    check(`build input or nonallowlisted path: ${name}`, make(changes), "1");
  }
  check("empty diff", make({}), "1");
  check("symlink addition", make({ "docs/link": { mode: "120000", content: "../main.go" } }), "1");
  check("regular to symlink", make({ "docs/guide.md": { mode: "120000", content: "../main.go" } }), "1");
  const linkedBase = commit(tree(base, { "docs/link": { mode: "120000", content: "../main.go" } }), [base]);
  check("symlink to regular", make({ "docs/link": "regular" }, linkedBase), "1");
  check("symlink deletion", make({ "docs/link": null }, linkedBase), "1");
  const gitlink = { mode: "160000", oid: base };
  check("gitlink addition", make({ "docs/module": gitlink }), "1");
  check("regular to gitlink", make({ "docs/guide.md": gitlink }), "1");
  const moduleBase = commit(tree(base, { "docs/module": gitlink }), [base]);
  check("gitlink deletion", make({ "docs/module": null }, moduleBase), "1");
  check("gitlink to regular", make({ "docs/module": "regular" }, moduleBase), "1");

  // A PR need not contain the latest base: compare base -> merged tree, never base -> PR head.
  const advancedBase = commit(tree(base, { "main.go": "new base code" }), [base]);
  const mergedTree = tree(advancedBase, { "docs/guide.md": "updated\n" });
  const staleBranch = { base: advancedBase, head: docs.head, merge: commit(mergedTree, [advancedBase, docs.head]) };
  check("PR branch behind current base", staleBranch, "0");
  check("stale event base", staleBranch, "1", { PR_BASE_SHA: base });
  check("swapped merge parents", { ...docs, merge: commit(mergedTree, [docs.head, base]) }, "1");
  check("extra merge parent", { ...docs, merge: commit(mergedTree, [base, docs.head, advancedBase]) }, "1");
  check("single parent", { ...docs, merge: commit(mergedTree, [base]) }, "1");
  check("merge tree contains code absent from PR head", { ...docs, merge: commit(mergedTree, [base, docs.head]) }, "1");
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: "refs/pull/43/merge", PR_NUMBER: "0",
    PR_BASE_REPOSITORY: "other/crabbox", PR_BASE_REF: "other", PR_BASE_SHA: "a".repeat(40),
    PR_HEAD_SHA: "b".repeat(40),
  })) check(`unverified event binding: ${key}`, docs, "1", { [key]: value });
  for (const key of Object.keys(admission.env)) check(`missing ${key}`, docs, "1", { [key]: "" });
  check("short SHA", docs, "1", { PR_BASE_SHA: docs.base.slice(0, 12) });
  check("nonhex SHA", docs, "1", { PR_HEAD_SHA: "z".repeat(40) });
  check("tree object is not an event commit SHA", docs, "1", { PR_HEAD_SHA: git(["rev-parse", `${base}^{tree}`]) });
  check("wrong repository remains fatal", docs, null, { GITHUB_REPOSITORY: "other/crabbox" }, true);
  check("wrong base remains fatal", docs, null, { GITHUB_BASE_REF: "other" }, true);
  check("wrong checkout remains fatal", docs, null, { GITHUB_SHA: docs.head }, true);

  const tools = path.join(root, "tools");
  fs.mkdirSync(tools);
  // Resolve Git's own binary so a workstation PATH wrapper cannot recurse into this stub.
  const nativeGit = path.join(git(["--exec-path"]), "git");
  fs.writeFileSync(path.join(tools, "git"), `#!/bin/bash\nif [ "$1" = diff ]; then\n  if [ "$FAIL_DIFF" = partial ]; then "$NATIVE_GIT" "$@"; fi\n  exit 2\nfi\nexec "$NATIVE_GIT" "$@"\n`, { mode: 0o755 });
  for (const failure of ["empty", "partial"]) check(`${failure} Git diff failure`, docs, "1", {
    PATH: `${tools}:${env.PATH}`, NATIVE_GIT: nativeGit, FAIL_DIFF: failure,
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`required workflow contracts passed (${cases} executed admission cases)`);
