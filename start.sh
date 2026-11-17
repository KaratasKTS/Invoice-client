#!/usr/bin/env bash
# Ξεκινά το πρόγραμμα των τιμολογίων. Δουλεύει σε Linux, macOS και Windows (Git Bash).
# Σε Windows χωρίς Git Bash χρησιμοποίησε το start.bat.
#
#   ./start.sh             ξεκινά και ανοίγει τη σελίδα στον browser
#   ./start.sh --no-open   ξεκινά χωρίς να ανοίξει τον browser
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
  echo "Χρειάζεται το Node.js (έκδοση 18 ή νεότερη) και δεν βρέθηκε." >&2
  echo "Εγκατάστησέ το από το https://nodejs.org και τρέξε ξανά αυτό το αρχείο." >&2
  exit 1
fi

if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "Χρειάζεται Node.js 18 ή νεότερο, αλλά βρέθηκε το $("$NODE" --version)." >&2
  echo "Εγκατάστησε νεότερη έκδοση από το https://nodejs.org και τρέξε ξανά αυτό το αρχείο." >&2
  exit 1
fi

exec "$NODE" server/server.js "$@"
