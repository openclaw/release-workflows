# Contributing

This repository is the fleet release standard. Changes must preserve the draft → independent verify → publish trust boundary for every archetype.

Keep workflow interfaces versionable and callers thin. Never expose signing credentials to verification jobs. Any change to permissions, identities, designated requirements, asset inventory, checksum handling, publication gates, or downstream handoffs needs explicit failure-mode review and actionlint plus rigorous YAML validation.

Backward-compatible changes target the current major line. Breaking caller or trust-contract changes require a new major workflow tag.

JavaScript regression tests use `scripts/workflow-source.cjs` to load workflow YAML with Psych and select production steps by job and name or ID. Keep release scripts inside the reusable workflow: repository-relative runtime scripts would resolve in the caller checkout. Marked script blocks allow focused execution without copying implementation into tests. Retry tests inject their scheduler so they check the requested delays without waiting on wall-clock time.
