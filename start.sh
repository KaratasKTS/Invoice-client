#!/usr/bin/env bash
# Starts the invoice web client. Works on Linux, macOS and Windows (Git Bash).
# On Windows without Git Bash, use start.bat instead.
#
#   ./start.sh             start and open the browser
#   ./start.sh --no-open   start without opening the browser
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
cd "$SCRIPT_DIR"

NODE=""
for candidate in node node.exe nodejs; do
  if command -v "$candidate" > /dev/null 2>&1; then
    NODE="$candidate"
    break
  fi
done

if [[ -z "$NODE" ]]; then
  echo "Node.js 18 or newer is required but was not found." >&2
  echo "Install it from https://nodejs.org and run this script again." >&2
  exit 1
fi

if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "Node.js 18 or newer is required, but this is $("$NODE" --version)." >&2
  echo "Install a newer version from https://nodejs.org and run this script again." >&2
  exit 1
fi

if [[ ! -f "${INVOICE_KEY_FILE:-key}" ]]; then
  echo "WARNING: no key file found. Put your API secret in a file named \"key\" in:" >&2
  echo "  $SCRIPT_DIR" >&2
fi

exec "$NODE" server/server.js "$@"
