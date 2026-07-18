# Contributing

This repository is the fleet release standard. Changes must preserve the draft → independent verify → publish trust boundary for every archetype.

Keep workflow interfaces versionable and callers thin. Never expose signing credentials to verification jobs. Any change to permissions, identities, designated requirements, asset inventory, checksum handling, publication gates, or downstream handoffs needs explicit failure-mode review and actionlint plus rigorous YAML validation.

Backward-compatible changes target the current major line. Breaking caller or trust-contract changes require a new major workflow tag.
