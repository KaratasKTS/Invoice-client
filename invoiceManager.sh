#!/usr/bin/env bash
set -euo pipefail

# VALID TYPES:
# 1) FETCH
# 2) FETCH_N_INSPECT
# 3) MAIL_INVOICES_TO
# 4) REMOVE_ZIP_FILES
# 5) REMOVE_ARCHIVES

URL="https://script.google.com/macros/s/AKfycbzDMr1lk5_O-KJy8L9CYjluvS_Tzgf1aKvUbENpWwfjQRct4fGYqObqQ9tQ8vO_bLY/exec"
SECRET="njfksbf483rhkrnaufgij3R@TREF#WFEafA"

MONTH="0"
YEAR="0"

confirm_destructive() {
  local exec_type="$1"
  while true; do
    read -rp "WARNING: '$exec_type' is destructive. Are you sure you want to proceed? (y/n): " yn
    case "$yn" in
      y|Y) return 0 ;;
      n|N) echo "Cancelled."; exit 0 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

# ---- Select exec type (no args needed) ----
echo "Choose an action:"
PS3="Enter choice (1-5): "
select choice in \
  "FETCH (Fetch invoices from mailbox)" \
  "FETCH_N_INSPECT (Fetch + email to user)" \
  "MAIL_INVOICES_TO (Send invoices to accountant) {DESTRUCTIVE}" \
  "REMOVE_ZIP_FILES (Cleans up all zip files in root) {DESTRUCTIVE}" \
  "REMOVE_ARCHIVES (Removes all date archives in root) {DESTRUCTIVE}"; do

  case "$REPLY" in
    1) EXEC_TYPE="FETCH"; break ;;
    2) EXEC_TYPE="FETCH_N_INSPECT"; break ;;
    3) EXEC_TYPE="MAIL_INVOICES_TO"; break ;;
    4) EXEC_TYPE="REMOVE_ZIP_FILES"; break ;;
    5) EXEC_TYPE="REMOVE_ARCHIVES"; break ;;
    *) echo "Please choose 1-5." ;;
  esac
done

# ---- Confirmation for all destructive actions ----
case "$EXEC_TYPE" in
  MAIL_INVOICES_TO|REMOVE_ZIP_FILES|REMOVE_ARCHIVES)
    confirm_destructive "$EXEC_TYPE"
    ;;
esac

# ---- Month input ----
echo "Select month 1-12"
while true; do
  read -rp "Type 0 for current month: " MONTH
  if [[ ! $MONTH =~ ^[0-9]+$ ]]; then
    echo "Please enter a number (0-12)"
    continue
  fi
  if (( MONTH < 0 || MONTH > 12 )); then
    echo "Please choose a valid month (0-12)"
    continue
  fi
  break
done

# ---- Year input ----
echo "Select year"
while true; do
  read -rp "Type 0 for current year: " YEAR
  if [[ ! $YEAR =~ ^[0-9]+$ ]]; then
    echo "Please enter a number (0 or 2024-2026)"
    continue
  fi
  if (( YEAR != 0 && (YEAR < 2024 || YEAR > 2026) )); then
    echo "Please choose a valid year (0, or 2024-2026)"
    continue
  fi
  break
done

# ---- Build params JSON array ----
params_json="["
for i in "${!PARAMS[@]}"; do
  v="${PARAMS[i]}"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  params_json+="\"$v\""
  (( i < ${#PARAMS[@]}-1 )) && params_json+=","
done
params_json+="]"

# ---- Build valid JSON body ----
BODY="$(printf '{"action":"ping","value":123,"exec_type":"%s","month":%s,"year":%s,"params":%s}' \
  "$EXEC_TYPE" "$MONTH" "$YEAR" "$params_json")"

TS="$(date +%s)"
MSG="${TS}.${BODY}"

SIG="$(printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -sS -L \
  -H 'Content-Type: application/json' \
  --data "$BODY" \
  "$URL?ts=$TS&sig=$SIG&exec_type=$EXEC_TYPE"

echo

