# Clawdex Homebrew handoff regression

The two JSON files are the unmodified independent verifier attestations from
[clawdex release run 34176514772](https://github.com/openclaw/clawdex/actions/runs/34176514772),
artifacts `verified-inventory-{arm64,x86_64}-release-verification-payload-34176514772-1`.
They differ only in `architecture`. Their inventory and `checksums.txt` match
the published [v0.2.2 assets](https://github.com/openclaw/clawdex/releases/tag/v0.2.2).

`clawdex.rb` is the formula written by the successful
[tap run 34176797544](https://github.com/openclaw/homebrew-tap/actions/runs/34176797544),
at commit `23b68b2a5ae7b83957f18c786b92ec15a3ec8260`.
The handoff rejected its literal `skip_clean "bin/clawdex"` metadata. The
`digest-mismatch: error` lines were download-action configuration, not failures.

The local suite executes the production validators against these frozen inputs.
The Homebrew preflight CI additionally fetches that exact formula and all
published release assets, binds their bytes to both attestations, and executes
the same validators without dispatching a tap update or evaluating formula code.
