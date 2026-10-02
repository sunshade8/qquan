#!/bin/bash
# Codex `notify` hook: forward to the original notifier, then auto-push qquan.
ORIG="/Users/woojinpark/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
[ -x "$ORIG" ] && "$ORIG" "$@" &
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
case "${@: -1}" in *"\"cwd\":\"$REPO"*|*"\"cwd\": \"$REPO"*) "$REPO/scripts/deploy/auto-push.sh" codex ;; esac
wait
