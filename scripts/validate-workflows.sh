#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

workflow_files=()
while IFS= read -r workflow_file; do
  workflow_files+=("$workflow_file")
done < <(find .github/workflows examples -type f \( -name '*.yml' -o -name '*.yaml' \) | LC_ALL=C sort)
(( ${#workflow_files[@]} > 0 ))

actionlint "${workflow_files[@]}"

ruby -e '
  require "psych"
  ARGV.each do |path|
    parsed = Psych.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
    raise "#{path}: top level must be a mapping" unless parsed.is_a?(Hash)
  end
' "${workflow_files[@]}"

python3 - <<'PY'
from pathlib import Path
import re

workflow_paths = sorted(Path('.github/workflows').glob('*.y*ml')) + sorted(Path('examples').glob('*.y*ml'))
workflow = Path('.github/workflows/release-go-cli.yml').read_text()
required_jobs = ['validate', 'tag', 'build', 'sign', 'draft', 'verify', 'publish', 'handoff', 'closeout']
for job in required_jobs:
    if not re.search(rf'^  {re.escape(job)}:\s*$', workflow, re.MULTILINE):
        raise SystemExit(f'missing required job: {job}')

required_inputs = ['version', 'repository-type', 'homebrew-formula', 'extra-packages', 'strict-checks']
for name in required_inputs:
    if not re.search(rf'^      {re.escape(name)}:\s*$', workflow, re.MULTILINE):
        raise SystemExit(f'missing workflow_call input: {name}')

verify = workflow.split('\n  verify:\n', 1)[1].split('\n  publish:\n', 1)[0]
for secret in ['MACOS_SIGNING_P12', 'MACOS_SIGNING_P12_PASSWORD', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_P8', 'TAP_TOKEN']:
    if f'secrets.{secret}' in verify:
        raise SystemExit(f'verify job references secret: {secret}')

if 'macos-14' not in verify or 'macos-15-intel' not in verify:
    raise SystemExit('verify matrix must cover arm64 and Intel macOS runners')

all_workflows = '\n'.join(path.read_text() for path in workflow_paths)
unpinned = re.findall(r'^\s*uses:\s+(?:actions|goreleaser)/[^@\n]+@(v\d+|main|master)\s*(?:#.*)?$', all_workflows, re.MULTILINE)
if unpinned:
    raise SystemExit(f'unpinned action references: {unpinned}')
PY

echo "workflow validation passed (${#workflow_files[@]} files)"
