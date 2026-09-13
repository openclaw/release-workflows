#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=$(ruby -rpsych -e '
  workflow = Psych.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  print workflow.fetch(true).fetch("workflow_call").fetch("inputs").fetch("swift-linux-image").fetch("default")
' "$ROOT/.github/workflows/release-swift-cli.yml")

docker run --rm -i "$image" bash -euo pipefail <<'SH'
swift --version
work=$(mktemp -d)
cd "$work"
printf '%s\n' 'print("Swift release toolchain passed")' >main.swift
swiftc -static-stdlib main.swift -o smoke
test "$(./smoke)" = 'Swift release toolchain passed'
echo 'Swift default image compiled and ran a static-stdlib Linux executable'
SH
