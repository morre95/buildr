#!/bin/bash
# Hook: Run lightweight project checks after TypeScript edits
# Registered in .cursor/hooks.json under afterFileEdit
#
# Cursor passes event data as JSON on stdin. The JSON contains a "path" field
# with the absolute path of the file that was edited.

input=$(cat)
FILE_PATH=$(node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(data).path ?? ""); } catch { process.stdout.write(""); } });' <<< "$input")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  */packages/*.ts|*/packages/*.tsx)
    pnpm --dir "$(git rev-parse --show-toplevel)" lint >/dev/null 2>&1
    ;;
  *)
    ;;
esac
