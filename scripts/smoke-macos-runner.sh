#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -m)" == arm64 ]]
xcodebuild -version
[[ "$(xcodebuild -version | head -n 1)" == 'Xcode 27'* ]]
if [[ "$EXPECTED_ARCH" == x86_64 ]]; then
  if ! arch -x86_64 /usr/bin/true; then
    sudo softwareupdate --install-rosetta --agree-to-license
  fi
  arch -x86_64 /usr/bin/true
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '#include <stdio.h>\nint main(void) { puts("runner execution verified"); }\n' >"$work/probe.c"
xcrun clang -Wall -Wextra -Werror -arch "$EXPECTED_ARCH" -mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET" "$work/probe.c" -o "$work/probe"
arch "-$EXPECTED_ARCH" "$work/probe" | grep -Fx 'runner execution verified'
xcrun vtool -show-build "$work/probe" | grep -Eq 'minos 14(\.0){0,2}$'
