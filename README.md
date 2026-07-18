# OpenClaw release workflows

Fleet-standard reusable release pipelines. Every archetype follows one trust boundary:

1. freeze a protected-branch commit, reusing an immutable annotated tag on retries;
2. build, freeze an immutable same-run artifact payload, and create an unpublished draft from those bytes;
3. independently verify that artifact on arm64 and x86_64 without signing or release-write credentials, emitting the exact verified `SHA256SUMS` plus a verdict;
4. let the publisher re-download every draft asset and require exact name and digest equality with both verifier attestations before un-drafting.

Callers pin a release-workflows compatibility tag, never a branch:

```yaml
jobs:
  release:
    uses: openclaw/release-workflows/.github/workflows/release-go-cli.yml@v1
```

## Go CLI archetype

`release-go-cli.yml` is the first fleet archetype. It requires:

- a protected default branch and a caller dispatched at its exact head;
- every branch-protection or effective-ruleset required status context green on the frozen target commit;
- `CHANGELOG.md` with a dated `##` section containing the requested version;
- `go.mod` and `.goreleaser.yml` or `.goreleaser.yaml`;
- a GoReleaser build matrix containing both `darwin/amd64` and `darwin/arm64` for every macOS binary name;
- consistent versions in any present `.release-version`, `VERSION`, `version.txt`, root `package.json`, and extra-package `package.json` files.

See [`examples/release-go-cli-caller.yml`](examples/release-go-cli-caller.yml) for the complete thin caller.

Inputs:

| Input | Contract |
| --- | --- |
| `version` | SemVer, with or without `v`. The workflow canonicalizes it to a `v` tag. |
| `repository-type` | `openclaw` or `personal`. Selects the signer, stable identifier namespace, and tap owner. |
| `homebrew-formula` | Optional formula name. Empty skips handoff. |
| `extra-packages` | JSON array of safe repo-relative files/directories. Basenames must be unique. |
| `strict-checks` | Boolean. Default `false` checks only branch-required contexts. `true` requires every independent check/status green. When no required contexts exist, both modes use the all-check fallback and require at least one completed, non-failed CI signal. |

Repository policies:

| Type | Required identity | Team ID | Identifier prefix | Tap |
| --- | --- | --- | --- | --- |
| `openclaw` | `Developer ID Application: OpenClaw Foundation` | `FWJYW4S8P8` | `org.openclaw.<repo>.<binary>` | `openclaw/homebrew-tap` |
| `personal` | `Developer ID Application: Peter Steinberger` | `Y5PE65HELJ` | `com.steipete.<repo>.<binary>` | `steipete/homebrew-tap` |

The CI gate merges required status checks from legacy branch protection and effective branch rules, including any required GitHub App binding. With the default `strict-checks: false`, unrelated optional or dynamic failures do not block a release. Required checks must still be present and green on the frozen target commit. Repositories without required contexts fall back to requiring all independent checks/statuses completed and non-failed. Set `strict-checks: true` to request that stricter all-check behavior even when required contexts exist.

The first attempt, when no version tag exists, freezes the current protected default-branch head and creates an annotated tag there. On every retry, an existing exact annotated version tag takes precedence: its peeled commit becomes `target-sha`, even when the caller runs from a newer default-branch head. That frozen commit must still be reachable from the protected default branch; the workflow checks out that commit and evaluates its changelog, version metadata, and required CI signals. The tag is never moved or replaced. Lightweight tags, tags that do not peel directly to a commit, and tags outside protected-branch ancestry fail closed. The caller itself must still be dispatched at the current protected default-branch head.

Binary authenticity does not trust the tag signature or annotation. Each architecture verifier has only `actions: read`; it downloads the draft job's immutable Actions artifact by its producer-exported name, never calls the draft Releases API, and independently enforces the exact commit, inventory, SHA-256 checksums, Apple certificate chain, hardened-runtime flag, timestamp, stable embedded designated requirement, Team ID, notarization requirement, and native plus universal architectures. Each verifier uploads an attestation containing its `verified` verdict, source artifact name, and exact `SHA256SUMS` bytes. Producer-bound names and 30-day artifact retention preserve this chain across GitHub's partial-job reruns, where consumer `run_attempt` values can differ.

### macOS verification matrix

| Control | Bare Mach-O CLI | Future `.app` bundle |
| --- | --- | --- |
| SHA-256 inventory and exact draft binding | Required | Required |
| `codesign --verify --strict` plus stable identifier-based designated requirement | Required | Required |
| Developer ID chain, Team ID, trusted timestamp, and hardened runtime | Required | Required |
| Online notarization ticket via `codesign --verify --strict --check-notarization -R=notarized` | Required | Required |
| Native-runner and universal architecture checks | Required | Artifact-specific |
| `spctl --assess --type execute` | Not applicable; SecAssessment rejects valid raw CLIs because they are not app bundles | Required behind the `.app` type condition |

Bare CLI archives cannot carry a stapled ticket: `stapler` supports disk images, installer packages, and certain signed executable bundles, not raw Mach-O files. The online `codesign --check-notarization` requirement is therefore the CLI ticket-presence proof. `spctl` remains reserved for app-bundle artifacts and never gates a raw CLI.

The publisher is the only post-draft job with `contents: write`. After both verifiers pass, it requires byte-identical checksum attestations, lists and API-downloads every unpublished draft asset, rejects duplicate, extra, missing, or renamed assets, compares the draft's `SHA256SUMS` bytes exactly, and hashes every remaining asset. It un-drafts only when the draft names and digests equal the write-free verification conclusion. Thus draft-read access remains coupled to publication authority without extending that authority to either verifier.

The Homebrew handoff dispatches `update-formula.yml` in the matching tap with `formula`, `source_repository`, `version`, numeric `release_id`, and a unique `correlation_id`. The tap workflow must include `correlation_id` in its `run-name`; the release waits for that exact run to succeed. The final stage opens a PR adding the next `## Unreleased` section.

## Secret provisioning

Provision secrets per caller repository. Do not centralize one credential across unrelated repositories or pass credentials through ordinary inputs.

| Secret | Value |
| --- | --- |
| `MACOS_SIGNING_P12` | Base64 of a password-protected `.p12` containing the policy-matching Developer ID Application certificate and private key. |
| `MACOS_SIGNING_P12_PASSWORD` | `.p12` export password. |
| `ASC_KEY_ID` | App Store Connect API key ID. |
| `ASC_ISSUER_ID` | App Store Connect issuer ID. |
| `ASC_PRIVATE_KEY_P8` | Full raw contents of the matching `AuthKey_*.p8`. |
| `TAP_TOKEN` | Optional fine-grained token able to dispatch and read Actions runs in the matching tap. Required only with `homebrew-formula`. |

The signing job imports the `.p12` into a unique ephemeral keychain, adds that keychain to the scoped user search list, validates the policy identity, and signs by its SHA-1 hash. An `always()` cleanup restores the original search list and deletes the temporary keychain; the `.p8` exists only inside runner temporary storage. Post-sign assertions are individually labeled and report only sanitized public signature metadata on failure. Designated-requirement comparison normalizes codesign's optional alphanumeric quotes and `Executable=` display header before comparing both sides. The verifier jobs receive only `actions: read`; their proof step explicitly removes GitHub, Actions runtime, Apple, signing, and tap token names from the environment.

## Versioning policy

Reusable workflows are immutable at release tags. Callers use the moving major compatibility tag (`@v1`). We cut immutable SemVer tags for auditability and move `v1` only for backward-compatible changes. Breaking input, secret, output, asset, or trust-policy changes require `v2`.

Pre-release tags such as `v1.0.0-alpha.1` validate the pipeline before a compatibility tag moves. Caller migrations begin only after `v1` exists.

## Validation

Run:

```sh
scripts/validate-workflows.sh
```

This runs actionlint on reusable, CI, and example workflows; parses every YAML document with Psych safe loading; executes adversarial frozen-tag and draft-binding scenarios; and enforces the required job/input topology, actions-read-only dual-architecture verifier, publisher hash binding, and immutable action references.
