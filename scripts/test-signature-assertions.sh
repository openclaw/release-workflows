#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORKFLOW="$ROOT/.github/workflows/release-go-cli.yml"

extract_helpers() {
  ruby -rpsych -e '
    workflow = Psych.safe_load(
      File.read(ARGV.fetch(0)),
      permitted_classes: [],
      permitted_symbols: [],
      aliases: false
    )
    job = workflow.fetch("jobs").fetch(ARGV.fetch(1))
    step = job.fetch("steps").find do |candidate|
      candidate["run"]&.include?("# signature-assertion-helpers-begin")
    end
    abort "signature assertion helpers not found in #{ARGV.fetch(1)}" unless step
    blocks = step.fetch("run").scan(
      /# signature-assertion-helpers-begin\n(.*?)# signature-assertion-helpers-end/m
    )
    abort "expected one signature helper block in #{ARGV.fetch(1)}" unless blocks.length == 1
    print blocks.fetch(0).fetch(0)
  ' "$WORKFLOW" "$1"
}

sign_helpers=$(extract_helpers sign)
verify_helpers=$(extract_helpers verify)
[[ "$sign_helpers" == "$verify_helpers" ]] || {
  echo "sign and verify signature assertion helpers differ" >&2
  exit 1
}
eval "$sign_helpers"

identifier=org.openclaw.eightctl.eightctl
team_id=FWJYW4S8P8
authority="Developer ID Application: OpenClaw Foundation ($team_id)"
display=$(printf '%s\n' \
  'Executable=/tmp/eightctl' \
  "Identifier=$identifier" \
  "Authority=$authority" \
  'Authority=Developer ID Certification Authority' \
  'Authority=Apple Root CA' \
  "TeamIdentifier=$team_id" \
  'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded' \
  'Timestamp=Jul 17, 2026 at 10:00:00 PM')

assert_signature_equal "identifier" "$identifier" "$(codesign_display_value Identifier "$display")" fixture
assert_signature_line_present "authority-name" "$authority" "$(codesign_display_values Authority "$display")" fixture
assert_signature_equal "team-id" "$team_id" "$(codesign_display_value TeamIdentifier "$display")" fixture
assert_signature_runtime "hardened-runtime" "$(awk '/^CodeDirectory / { print; exit }' <<<"$display")" fixture
assert_signature_timestamp "trusted-timestamp" "$(codesign_display_value Timestamp "$display")" fixture
echo "PASS labeled public signature metadata assertions"

expected_requirement="designated => identifier \"$identifier\" and anchor apple generic and certificate leaf[subject.OU] = \"$team_id\""
display_requirement="designated => identifier $identifier and anchor apple generic and certificate leaf[subject.OU] = $team_id"
normalized_expected=$(normalize_designated_requirement "$expected_requirement")
for observed in \
  "$display_requirement" \
  "Executable=/tmp/eightctl"$'\n'"$display_requirement" \
  "$display_requirement"$'\n'"Executable=/tmp/eightctl" \
  "$display_requirement Executable=/tmp/eightctl"; do
  assert_signature_equal \
    "designated-requirement" \
    "$normalized_expected" \
    "$(normalize_designated_requirement "$observed")" \
    fixture
done
echo "PASS designated requirement quote and Executable header normalization"

if diagnostics=$(assert_signature_equal "team-id" "$team_id" WRONGTEAM fixture 2>&1); then
  echo "deliberate signature mismatch unexpectedly passed" >&2
  exit 1
fi
[[ "$diagnostics" == *'signature assertion failed [team-id] for fixture'* ]]
[[ "$diagnostics" == *"expected (public metadata): $team_id"* ]]
[[ "$diagnostics" == *'observed (public metadata): WRONGTEAM'* ]]
echo "PASS labeled mismatch diagnostics include sanitized observed and expected metadata"

bad_requirement=$(normalize_designated_requirement "${display_requirement/$team_id/WRONGTEAM}")
if diagnostics=$(assert_signature_equal \
  "designated-requirement" "$normalized_expected" "$bad_requirement" fixture 2>&1); then
  echo "deliberate designated requirement mismatch unexpectedly passed" >&2
  exit 1
fi
[[ "$diagnostics" == *'signature assertion failed [designated-requirement] for fixture'* ]]
[[ "$diagnostics" == *'certificate leaf[subject.OU] = WRONGTEAM'* ]]
echo "PASS designated requirement mismatch remains visible"
