#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_dir=$(mktemp -d "$ROOT/.release-smoke.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
cd "$work_dir"
export GOCACHE="$work_dir/go-cache"

cat >go.mod <<'EOF'
module example.com/release-smoke

go 1.26.0
EOF
cat >main.go <<'EOF'
package main

import (
    "crypto/sha256"
    "fmt"
    "os"
)

func main() {
    data, err := os.ReadFile(os.Args[1])
    if err != nil {
        panic(err)
    }
    fmt.Printf("%x\n", sha256.Sum256(data))
}
EOF
cat >.goreleaser.yml <<EOF
version: 2
project_name: release-smoke
builds:
  - binary: release-smoke
    env: [CGO_ENABLED=0]
    goos: [$(go env GOHOSTOS)]
    goarch: [$(go env GOHOSTARCH)]
archives:
  - formats: [tar.gz]
    files: []
changelog:
  disable: true
EOF

goreleaser release --snapshot --clean --parallelism=2 --skip=publish,sign,notarize
archive=$(find dist -maxdepth 1 -name '*.tar.gz' -type f -print)
test -n "$archive"
mkdir unpacked
tar -xzf "$archive" -C unpacked
expected=$(shasum -a 256 "$ROOT/README.md" | cut -d ' ' -f 1)
observed=$(unpacked/release-smoke "$ROOT/README.md")
test "$observed" = "$expected"
printf 'GoReleaser archive binary hashed README.md correctly: %s\n' "$observed"

cat >package.json <<'EOF'
{"name":"release-smoke","private":true,"scripts":{"build":"node -e \"require('fs').writeFileSync('pnpm-output.txt', 'pnpm build passed\\n')\""}}
EOF
pnpm install --lockfile-only --ignore-scripts
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
test "$(cat pnpm-output.txt)" = 'pnpm build passed'
printf 'pnpm %s frozen-lockfile install and build passed\n' "$(pnpm --version)"
