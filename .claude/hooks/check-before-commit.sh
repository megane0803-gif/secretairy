#!/usr/bin/env bash
# PreToolUse（道具は Bash）のフック。「git commit」の時だけ動く。
# npm test か npm run typecheck が落ちたら、終了コード 2 でコミットを止める（理由は Claude に返る）。
# ほかの Bash の命令では何もしない（終了コード 0）。

input="$(cat)"
cmd="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).tool_input?.command??""))}catch{}})')"

# 「git commit」が入っていない命令はそのまま通す
if ! printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([^[:alnum:]_-]|$)'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

if ! out="$(npm test 2>&1)"; then
  {
    echo "npm test が落ちたので、コミットを止めました。テストを直してからコミットしてください。"
    printf '%s\n' "$out" | grep -E '^not ok|# (pass|fail)' | head -20
  } >&2
  exit 2
fi

if ! out="$(npm run typecheck 2>&1)"; then
  {
    echo "npm run typecheck が落ちたので、コミットを止めました。型を直してからコミットしてください。"
    printf '%s\n' "$out" | grep -E 'error TS' | head -20
  } >&2
  exit 2
fi

exit 0
