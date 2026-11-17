#!/usr/bin/env bash
set -euo pipefail

# Command-line client for the invoice backend. The web client (./start.sh)
# offers the same actions plus local file saving and viewing.

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

for tool in curl jq openssl; do
  command -v "$tool" > /dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

# The web app URL lives in config.json. INVOICE_URL overrides it.
URL="${INVOICE_URL:-$(jq -r '.url // empty' "${SCRIPT_DIR}/config.json")}"
[[ -n "$URL" ]] || { echo "No backend URL: set \"url\" in config.json" >&2; exit 1; }

KEY_FILE="${INVOICE_KEY_FILE:-${SCRIPT_DIR}/key}"
[[ -f "$KEY_FILE" ]] || { echo "Key file not found: $KEY_FILE" >&2; exit 1; }
SECRET="$(tr -d '\r\n' < "$KEY_FILE")"

CURRENT_YEAR="$(date +%Y)"

MONTH="0"
YEAR="0"
FETCH_TYPE=""
EXEC_TYPE=""
NEWER_THAN=""
ACTION=""

confirm_destructive() {
  local action="$1"
  while true; do
    read -rp "WARNING: '$action' is destructive. Are you sure you want to proceed? (y/n): " yn
    case "$yn" in
      y|Y) return 0 ;;
      n|N) echo "Cancelled."; exit 0 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

confirm_send_accountant() {
  while true; do
    read -rp "WARNING: This will send the selected invoices to your accountant, do you wish to proceed? (y/n) " yn
    case "$yn" in
      y|Y) return 0 ;;
      n|N) echo "Cancelled."; exit 0 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

# Signs "ts.exec_type.body" with the key and posts the body to the backend.
api_call() {
  local exec_type="$1"
  local body="$2"

  local ts msg sig
  ts="$(date +%s)"
  msg="${ts}.${exec_type}.${body}"
  sig="$(printf '%s' "$msg" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"

  curl -sS -L \
    -H 'Content-Type: application/json' \
    --data-raw "$body" \
    "$URL?ts=$ts&sig=$sig&exec_type=$exec_type"
}

# Pretty-prints a response, or prints it raw when it is not JSON.
print_response() {
  printf '%s' "$1" | jq . 2> /dev/null || printf '%s\n' "$1"
}

# Stops with the backend's error when a response is not {"ok": true, ...}.
require_ok() {
  local res="$1"
  if [[ "$(printf '%s' "$res" | jq -r '.ok // false' 2> /dev/null)" != "true" ]]; then
    echo "The backend reported an error:" >&2
    print_response "$res" >&2
    exit 1
  fi
}

print_dir_structure() {
  local json="$1"
  echo
  echo "Directory structure:"
  echo "Archives"
  printf '%s' "$json" | jq -r '
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
}

build_folder_options() {
  local json="$1"
  printf '%s' "$json" | jq -r '
    .return_value
    | to_entries
    | sort_by(.key)
    | map(select((.value | type) == "array" and (.value | length) > 0))
    | .[]
    | .key as $y
    | .value[]
    | "\($y) / \(.)"
  '
}

# Lets the user pick a folder and prints "year|folder" on stdout.
# The menu and every message go to stderr so they are not captured.
select_archive_folder() {
  local json="$1"

  local -a options
  mapfile -t options < <(build_folder_options "$json")

  if (( ${#options[@]} == 0 )); then
    echo "There are no archive folders yet." >&2
    exit 0
  fi

  local choice
  PS3="Choose a folder: "
  select choice in "${options[@]}"; do
    [[ -n "${choice:-}" ]] || { echo "Invalid choice." >&2; continue; }
    printf '%s|%s\n' "${choice%% / *}" "${choice#* / }"
    return 0
  done
}

echo "Choose an action:"
PS3="Enter choice (1-5): "
select choice in \
  "FETCH (Fetch invoices from mailbox)" \
  "FETCH_N_INSPECT (Fetch + email to user)" \
  "MAILER (List/prepare archives)" \
  "REMOVE_ZIP_FILES (Removes the zip files of an archive) {DESTRUCTIVE}" \
  "REMOVE_ARCHIVES (Removes an archive folder) {DESTRUCTIVE}"; do

  case "$REPLY" in
    1) EXEC_TYPE="FETCH"; break ;;
    2) EXEC_TYPE="FETCH_N_INSPECT"; break ;;
    3) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="MAILER"; break ;;
    4) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="REMOVE_ZIP_FILES"; break ;;
    5) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="REMOVE_ARCHIVES"; break ;;
    *) echo "Please choose 1-5." ;;
  esac
done

case "$ACTION" in
  REMOVE_ZIP_FILES|REMOVE_ARCHIVES)
    confirm_destructive "$ACTION"
    ;;
esac

if [[ "$EXEC_TYPE" == "FETCH" || "$EXEC_TYPE" == "FETCH_N_INSPECT" ]]; then
  echo "Do you want to filter invoices via newer_than value [1-90] or get by [month, year]?"
  PS3="Enter choice (1|2): "
  select choice in \
    "Newer_than" \
    "Month & Year"; do

    case "$REPLY" in
      1) FETCH_TYPE="NEWER_THAN"; break ;;
      2) FETCH_TYPE="MONTH_YEAR"; break ;;
      *) echo "Please choose 1-2." ;;
    esac
  done
fi

if [[ "$FETCH_TYPE" == "MONTH_YEAR" ]]; then
  echo "Select month 1-12"
  while true; do
    read -rp "Type 0 for current month: " MONTH
    [[ $MONTH =~ ^[0-9]{1,2}$ ]] || { echo "Please enter a number (0-12)"; continue; }
    MONTH=$((10#$MONTH))
    (( MONTH <= 12 )) || { echo "Please choose a valid month (0-12)"; continue; }
    break
  done

  echo "Select year (2000-$CURRENT_YEAR)"
  while true; do
    read -rp "Type 0 for current year: " YEAR
    [[ $YEAR =~ ^[0-9]{1,4}$ ]] || { echo "Please enter a number (0 or 2000-$CURRENT_YEAR)"; continue; }
    YEAR=$((10#$YEAR))
    (( YEAR == 0 || (YEAR >= 2000 && YEAR <= CURRENT_YEAR) )) || { echo "Please choose a valid year (0, or 2000-$CURRENT_YEAR)"; continue; }
    break
  done
fi

if [[ "$FETCH_TYPE" == "NEWER_THAN" ]]; then
  echo "Select newer than value [1-90]"
  while true; do
    read -r NEWER_THAN
    [[ $NEWER_THAN =~ ^[0-9]{1,2}$ ]] || { echo "Please enter a number [1-90]"; continue; }
    NEWER_THAN=$((10#$NEWER_THAN))
    (( NEWER_THAN >= 1 && NEWER_THAN <= 90 )) || { echo "Please choose a valid NEWER_THAN [1-90]"; continue; }
    break
  done
fi

# Primary call

BODY="$(jq -cn \
  --arg month "$MONTH" --arg year "$YEAR" --arg newer_than "$NEWER_THAN" \
  --arg fetch_type "$FETCH_TYPE" --arg action "$ACTION" \
  '{month: $month, year: $year, newer_than: $newer_than, fetch_type: $fetch_type, action: $action}')"

res="$(api_call "$EXEC_TYPE" "$BODY")"

require_ok "$res"

if [[ "$EXEC_TYPE" != "FETCH_DIR_STRUCTURE" ]]; then
  print_response "$res"
  printf '%s' "$res" | jq -r '.return_value | "Saved \(.saved | length) new file(s), \(.existing | length) already in Drive."'
  exit 0
fi

print_dir_structure "$res"

selection="$(select_archive_folder "$res")"
[[ -n "$selection" ]] || exit 0

sel_year="${selection%%|*}"
sel_folder="${selection#*|}"

if [[ "$ACTION" == "MAILER" ]]; then

  MAIL_TO=""
  echo "Choose receiver E-mail:"
  PS3="Enter choice (1-3): "
  select mail_choice in \
    "Mail to User (me)" \
    "Mail to Accountant" \
    "Mail to other"; do

    case "$REPLY" in
      1) MAIL_TO="USER"; break ;;
      2) MAIL_TO="ACCOUNTANT"; break ;;
      3) MAIL_TO="OTHER"; break ;;
      *) echo "please choose 1-3" ;;
    esac
  done

  if [[ "$MAIL_TO" == "ACCOUNTANT" ]]; then
    confirm_send_accountant
  fi

  if [[ "$MAIL_TO" == "OTHER" ]]; then
    while true; do
      read -rp "Type receiver email: " mail
      if [[ "$mail" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        echo "OK: $mail"
        MAIL_TO="$mail"
        break
      else
        echo "Invalid email. Must look like name@example.com"
      fi
    done
  fi

  BODY="$(jq -cn --arg parent "$sel_year" --arg child "$sel_folder" --arg mail_to "$MAIL_TO" \
    '{parent_folder: $parent, child_folder: $child, mail_to: $mail_to}')"

  res="$(api_call "MAILER_EXECUTE" "$BODY")"

else

  BODY="$(jq -cn --arg parent "$sel_year" --arg child "$sel_folder" \
    '{parent_folder: $parent, child_folder: $child}')"

  res="$(api_call "$ACTION" "$BODY")"

fi

print_response "$res"
require_ok "$res"
