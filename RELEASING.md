# Releasing release-workflows

Changes to compatible inputs, secrets, outputs, asset contracts, or trust policy stay on major v1. Additive archetypes warrant a minor release. Breaking caller contracts require a new major. The immutable SemVer tag and its GitHub Release are permanent; only the explicitly designated `v1` compatibility tag moves.

1. Land the release PR with a dated `CHANGELOG.md` section for the next version and an empty `Unreleased` section above it. Run the full validation suite and independent review before merging. Wait for push CI on the exact merged main commit.
2. Dispatch `release.yml` on protected `main`, with `version` and `dry_run=true`. It calls the source archetype from that exact commit, validates the frozen source and dated notes, runs the read-only shell check, downloads source archives, and independently verifies both architectures. It creates no tag or GitHub Release. Record the run URL.
3. Dispatch the same workflow and version with `dry_run=false`. The workflow creates an annotated `vX.Y.Z` at the validated commit, or reuses that exact annotated tag on retries. It publishes the checked source archives, release notes, inventory, and `SHA256SUMS` through the independent verifier boundary. Never delete or move this version tag; never replace public release assets. A retry succeeds only if existing bytes and notes match.
4. Verify the published release body equals the dated changelog section and download all assets to check `SHA256SUMS`. Verify the tag peels to the tested merge commit. Then move `v1` to that commit with a signed annotated compatibility tag. Record the old remote tag object first and use an exact lease; this is the sole tag-movement exception:

   ```sh
   old_v1=$(git ls-remote origin refs/tags/v1 | cut -f1)
   git tag -s -f v1 <verified-merge-commit> -m 'v1 compatibility tag: vX.Y.Z'
   git push --force-with-lease=refs/tags/v1:$old_v1 origin refs/tags/v1
   ```

   Verify remote `v1^{}` equals the version tag's commit. Keep the visible checkout clean on `main` and pull with `--ff-only`.

No npm package, npm credentials, signing certificate, or deployment is involved in releasing this repository. Consumers configure their own npm trusted publisher and optional tap token; the reusable workflows do not accept npm tokens. No local artifact-publishing fallback is maintained.
