# OpenClaw release workflows

Fleet-standard reusable release pipelines. Every archetype follows one trust boundary:

1. freeze a protected, green default-branch head;
2. build and create an unpublished draft;
3. independently verify the exact draft without signing credentials;
4. publish only after every verifier passes.

Callers pin a release-workflows compatibility tag, never a branch:

```yaml
jobs:
  release:
    uses: openclaw/release-workflows/.github/workflows/release-go-cli.yml@v1
```

## Go CLI archetype

`release-go-cli.yml` is the first fleet archetype. It requires:

- a protected default branch and a caller dispatched at its exact head;
- every branch-protection or effective-ruleset required status context green on that head;
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

The CI gate merges required status checks from legacy branch protection and effective branch rules, including any required GitHub App binding. With the default `strict-checks: false`, unrelated optional or dynamic failures do not block a release. Required checks must still be present and green. Repositories without required contexts fall back to requiring all independent checks/statuses completed and non-failed. Set `strict-checks: true` to request that stricter all-check behavior even when required contexts exist.

The tag stage creates an annotated tag at the validated SHA. A safe retry may reuse an existing signed or annotated tag only when its peeled commit is that exact SHA; lightweight or mismatched tags fail closed. Binary authenticity does not trust the tag signature or annotation: the draft verifier independently enforces the exact commit, inventory, SHA-256 checksums, Apple certificate chain, hardened-runtime flag, timestamp, stable embedded designated requirement, Team ID, notarization requirement, and native plus universal architectures.

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

The signing job imports the `.p12` into a unique ephemeral keychain, adds that keychain to the scoped user search list, validates the policy identity, and signs by its SHA-1 hash. An `always()` cleanup restores the original search list and deletes the temporary keychain; the `.p8` exists only inside runner temporary storage. The verifier jobs receive only `contents: read`; their proof step explicitly removes GitHub, Apple, signing, and tap token names from the environment.

## Versioning policy

Reusable workflows are immutable at release tags. Callers use the moving major compatibility tag (`@v1`). We cut immutable SemVer tags for auditability and move `v1` only for backward-compatible changes. Breaking input, secret, output, asset, or trust-policy changes require `v2`.

Pre-release tags such as `v1.0.0-alpha.1` validate the pipeline before a compatibility tag moves. Caller migrations begin only after `v1` exists.

## Validation

Run:

```sh
scripts/validate-workflows.sh
```

This runs actionlint on reusable, CI, and example workflows; parses every YAML document with Psych safe loading; and enforces the required job/input topology, secretless verifier, dual-architecture verifier matrix, and immutable action references.
