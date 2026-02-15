#!/usr/bin/env bash
set -euo pipefail

URL="https://script.google.com/macros/s/AKfycbzDMr1lk5_O-KJy8L9CYjluvS_Tzgf1aKvUbENpWwfjQRct4fGYqObqQ9tQ8vO_bLY/exec"
SECRET="$(cat ./key)"
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

# ---- Select exec type ----
echo "Choose an action:"
PS3="Enter choice (1-6): "
select choice in \
  "FETCH (Fetch invoices from mailbox)" \
  "FETCH_N_INSPECT (Fetch + email to user)" \
  "MAIL_INVOICES_TO (Send invoices to accountant) {DESTRUCTIVE}" \
  "MAILER (List/prepare archives)" \
  "REMOVE_ZIP_FILES (Cleans up all zip files in root) {DESTRUCTIVE}" \
  "REMOVE_ARCHIVES (Removes all date archives in root) {DESTRUCTIVE}"; do

  case "$REPLY" in
    1) EXEC_TYPE="FETCH"; break ;;
    2) EXEC_TYPE="FETCH_N_INSPECT"; break ;;
    3) EXEC_TYPE="MAIL_INVOICES_TO"; break ;;
    4) EXEC_TYPE="FETCH_DIR_STRUCTURE"; break ;;
    5) EXEC_TYPE="REMOVE_ZIP_FILES"; break ;;
    6) EXEC_TYPE="REMOVE_ARCHIVES"; break ;;
    *) echo "Please choose 1-6." ;;
  esac
done

case "$EXEC_TYPE" in
  MAIL_INVOICES_TO|REMOVE_ZIP_FILES|REMOVE_ARCHIVES)
    confirm_destructive "$EXEC_TYPE"
    ;;
esac

# ---- Month input ----
echo "Select month 1-12"
while true; do
  read -rp "Type 0 for current month: " MONTH
  [[ $MONTH =~ ^[0-9]+$ ]] || { echo "Please enter a number (0-12)"; continue; }
  (( MONTH >= 0 && MONTH <= 12 )) || { echo "Please choose a valid month (0-12)"; continue; }
  break
done

# ---- Year input ----
echo "Select year (> 2024)"
while true; do
  read -rp "Type 0 for current year: " YEAR
  [[ $YEAR =~ ^[0-9]+$ ]] || { echo "Please enter a number (0 or 2024-2026)"; continue; }
  (( YEAR == 0 || (YEAR >= 2024 && YEAR <= 2026) )) || { echo "Please choose a valid year (0, or 2024-2026)"; continue; }
  break
done

# ---- Body your doPost expects ----
BODY="$(printf '{"month":%s,"year":%s}' "$MONTH" "$YEAR")"

TS="$(date +%s)"
MSG="${TS}.${BODY}"
SIG="$(printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

res="$(curl -sS -L \
  -H 'Content-Type: application/json' \
  --data "$BODY" \
  "$URL?ts=$TS&sig=$SIG&exec_type=$EXEC_TYPE")"

# ---- Validate JSON ----
if ! echo "$res" | jq -e . >/dev/null 2>&1; then
  echo "ERROR: Response is not valid JSON:"
  echo "$res"
  exit 1
fi

# ---- Validate server ok ----
if ! echo "$res" | jq -e '.ok == true' >/dev/null; then
  echo "ERROR: Server returned ok=false (or missing ok):"
  echo "$res" | jq .
  exit 1
fi

# ---- If return_value is an object: print tree + select ----
if echo "$res" | jq -e '.return_value | type == "object"' >/dev/null; then
  echo
  echo "Directory structure:"
  echo "Archives"
  echo "$res" | jq -r '
    .return_value
    | to_entries
    | sort_by(.key)
    | .[]
    | "|______> \(.key)\n" +
      ( if (.value | length) == 0
        then "         |______> (empty)\n"
        else (.value[] | "         |______> \(.)\n")
        end )
  '
  echo

  # Build menu options YEAR / FOLDER (EXCLUDE empties from select)
  mapfile -t options < <(
    echo "$res" | jq -r '
      .return_value
      | to_entries
      | sort_by(.key)
      | map(select((.value | type) == "array" and (.value | length) > 0))
      | .[]
      | .key as $y
      | .value[]
      | "\($y) / \(.)"
    '
  )
  if (( ${#options[@]} == 0 )); then
    echo "No years found in return_value."
    echo "$res" | jq '.return_value'
    exit 0
  fi

  PS3="Choose a folder (or empty year): "
  select choice in "${options[@]}"; do
    [[ -n "${choice:-}" ]] || { echo "Invalid choice."; continue; }

    sel_year="${choice%% / *}"
    sel_folder="${choice#* / }"

    echo "Selected:"
    echo "  year   = $sel_year"
    echo "  folder = $sel_folder"
    
     # ---- Body your doPost expects ----
     # //this is getting invalid signature for some reason
     
BODY2="$(printf '{"month":%s,"year":%s}' "$sel_year" "$sel_year")"


TSG2="$(date +%s)"
MSG2="${TSG2}.${BODY2}"
SIG2="$(printf '%s' "$MSG2" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

res="$(curl -sS -L \
  -H 'Content-Type: application/json' \
  --data-raw "$BODY2" \
  "$URL?ts=$TSG2&sig=$SIG2&exec_type=MAILER_EXECUTE")"


echo "$res";

    if [[ "$sel_folder" == "(empty)" ]]; then
      echo "Note: You selected an empty year folder. (No month subfolders yet.)"
      # If you want: prompt to create/select a month name here.
    fi

    break
  done

else

  echo "$res" | jq 
fi

