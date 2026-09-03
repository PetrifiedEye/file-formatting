#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')

if [[ -z "$file_path" || ! -f "$file_path" ]]; then
  exit 0
fi

case "$file_path" in
  */node_modules/*|*/dist/*|*/coverage/*|*/build/*)
    exit 0
    ;;
esac

case "$file_path" in
  *.ts|*.tsx)
    ;;
  *)
    exit 0
    ;;
esac

cd "$CLAUDE_PROJECT_DIR"

prettier="node_modules/.bin/prettier"
eslint="node_modules/.bin/eslint"

if [[ ! -x "$prettier" || ! -x "$eslint" ]]; then
  exit 0
fi

should_format=false
should_lint=false

case "$file_path" in
  */src/*|*/test/*)
    should_format=true
    should_lint=true
    ;;
  */apps/*|*/libs/*)
    should_lint=true
    ;;
esac

if [[ "$should_format" == true ]]; then
  "$prettier" --write "$file_path" || true
fi

if [[ "$should_lint" == true ]]; then
  "$eslint" --fix "$file_path" || true
fi

exit 0
