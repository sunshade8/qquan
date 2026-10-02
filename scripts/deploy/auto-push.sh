#!/bin/bash
# Commit and push agent edits to main after each Claude Code / Codex turn.
# Vercel's GitHub integration then deploys the pushed commit to production.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 0
LOG="$REPO/.git/auto-push.log"
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] || exit 0
git add -A
if git diff --cached --name-only | grep -Eq '(^|/)(\.env($|\.)|\.dev\.vars$)' \
   && ! git diff --cached --name-only | grep -Eq '^\.env\.example$'; then
  echo "$(date '+%F %T') refused: secret file staged" >>"$LOG"; git reset -q; exit 0
fi
if ! git diff --cached --quiet; then
  AGENT="${1:-agent}"
  FILES="$(git diff --cached --name-only | head -5 | tr '\n' ' ')"
  git commit -q -m "Auto: ${AGENT} edits — ${FILES}" >>"$LOG" 2>&1
fi
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || git branch -q -u origin/main
if [ -n "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]; then
  { git pull -q --rebase origin main && git push -q origin main && echo "$(date '+%F %T') pushed $(git rev-parse --short HEAD)"; } >>"$LOG" 2>&1 \
    || echo "$(date '+%F %T') push failed; see above" >>"$LOG"
fi
exit 0
