#!/usr/bin/env bash
set -euo pipefail


SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

URL="https://script.google.com/macros/s/AKfycbzDMr1lk5_O-KJy8L9CYjluvS_Tzgf1aKvUbENpWwfjQRct4fGYqObqQ9tQ8vO_bLY/exec"

SECRET="$(cat "${SCRIPT_DIR}/key")"

SECRET="$(cat ./key)"

MONTH="0"
YEAR="0"
FETCH_TYPE=""
EXEC_TYPE=""
NEWER_THAN=""
ACTION=""

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

confirm_send_accountant() {
  while true; do
    read -rp "WARNING: This will send the selected invoices to you accountant, do you wish to proseed? (y/n) " yn
    case "$yn" in
      y|Y) return 0 ;;
      n|N) echo "Cancelled."; exit 0 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}



#functions
api_call() {
  local exec_type="$1"
  local body="$2"

  local ts msg sig
  ts="$(date +%s)"
  msg="${ts}.${body}"
  sig="$(printf '%s' "$msg" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

  curl -sS -L \
    -H 'Content-Type: application/json' \
    --data-raw "$body" \
    "$URL?ts=$ts&sig=$sig&exec_type=$exec_type"
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


build_mailer_options() {
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

require_nonempty_options_or_exit() {
  local json="$1"
  local arr_name="$2"


  if (( ${#arr_name[@]} == 0 )); then
    echo "No years found in return_value."
    printf '%s' "$json" | jq '.return_value'
    exit 0
  fi
}



select_archive_folder() {
  local json="$1"

  local -a options
  mapfile -t options < <(build_mailer_options "$json")

  if (( ${#options[@]} == 0 )); then
    echo "No years found in return_value."
    printf '%s' "$json" | jq '.return_value'
    exit 0
  fi

  local choice sel_year sel_folder
  PS3="Choose a folder (or empty year): "
  select choice in "${options[@]}"; do
    [[ -n "${choice:-}" ]] || { echo "Invalid choice."; continue; }

    sel_year="${choice%% / *}"
    sel_folder="${choice#* / }"


    printf '%s|%s\n' "$sel_year" "$sel_folder"
    return 0
  done
}


echo "Choose an action:"
PS3="Enter choice (1-5): "
select choice in \
  "FETCH (Fetch invoices from mailbox)" \
  "FETCH_N_INSPECT (Fetch + email to user)" \
  "MAILER (List/prepare archives)" \
  "REMOVE_ZIP_FILES (Cleans up all zip files in root) {DESTRUCTIVE}" \
  "REMOVE_ARCHIVES (Removes all date archives in root) {DESTRUCTIVE}"; do

  case "$REPLY" in
    1) EXEC_TYPE="FETCH"; break ;;
    2) EXEC_TYPE="FETCH_N_INSPECT"; break ;;
    3) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="MAILER"; break ;;
    4) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="REMOVE_ZIP_FILES"; break ;;
    5) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="REMOVE_ARCHIVES"; break ;;
    *) echo "Please choose 1-5." ;;
  esac
done

case "$EXEC_TYPE" in
  REMOVE_ZIP_FILES|REMOVE_ARCHIVES)
    confirm_destructive "$EXEC_TYPE"
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

if [[ "$EXEC_TYPE" != 'FETCH_DIR_STRUCTURE' && "$FETCH_TYPE" != 'NEWER_THAN' ]]; then
  # Month input
  echo "Select month 1-12"
  while true; do
    read -rp "Type 0 for current month: " MONTH
    [[ $MONTH =~ ^[0-9]+$ ]] || { echo "Please enter a number (0-12)"; continue; }
    (( MONTH >= 0 && MONTH <= 12 )) || { echo "Please choose a valid month (0-12)"; continue; }
    break
  done

  # Year input
  echo "Select year (> 2024)"
  while true; do
    read -rp "Type 0 for current year: " YEAR
    [[ $YEAR =~ ^[0-9]+$ ]] || { echo "Please enter a number (0 or 2024-2026)"; continue; }
    (( YEAR == 0 || (YEAR >= 2024 && YEAR <= 2026) )) || { echo "Please choose a valid year (0, or 2024-2026)"; continue; }
    break
  done
fi

if [[ "$FETCH_TYPE" == "NEWER_THAN" ]]; then
  echo "Select newer than value [1-90]"
  while true; do
    read -r NEWER_THAN
    (( NEWER_THAN >= 1 && NEWER_THAN <= 90 )) || { echo "Please choose a valid NEWER_THAN [1-90]"; continue; }
    break
  done
fi

# Primary call

BODY="$(printf '{"month": "%s","year": "%s", "newer_than" : "%s" ,"fetch_type" : "%s", "action": "%s" }' \
  "$MONTH" "$YEAR" "$NEWER_THAN" "$FETCH_TYPE" "$ACTION")"

res="$(api_call "$EXEC_TYPE" "$BODY")"

echo "$res"

getAction="$(printf '%s' "$res" | jq -r '.params.action // empty')"

if [[ "$getAction" == "MAILER" ]]; then

  print_dir_structure "$res"

  selection="$(select_archive_folder "$res")"

  sel_year="${selection%%|*}"
  sel_folder="${selection#*|}"

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

  case "$MAIL_TO" in
    ACCOUNTANT)
      confirm_send_accountant
      ;;
  esac

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

  BODY="$(printf '{"parent_folder": "%s" ,"child_folder": "%s" , "mail_to": "%s" }' \
   "$sel_year"  "$sel_folder" "$MAIL_TO" )"

  res="$(api_call "MAILER_EXECUTE" "$BODY")"
  printf '%s' "$res" | jq

  if [[ "$sel_folder" == "(empty)" ]]; then
    echo "Note: You selected an empty year folder. (No month subfolders yet.)"
  fi


 elif [[  "$getAction" == 'REMOVE_ARCHIVES' ]]; then

  print_dir_structure "$res"

  selection="$(select_archive_folder "$res")"

  sel_year="${selection%%|*}"
  sel_folder="${selection#*|}"

  BODY="$(printf '{"parent_folder": "%s" ,"child_folder": "%s" }' \
    "$sel_year" "$sel_folder" )"

  res="$(api_call "$getAction" "$BODY")"

  echo "$res" | jq



 elif [[ "$getAction" == 'REMOVE_ZIP_FILES' ]]; then

  print_dir_structure "$res"

  selection="$(select_archive_folder "$res")"

  sel_year="${selection%%|*}"
  sel_folder="${selection#*|}"

  BODY="$(printf '{"parent_folder": "%s" ,"child_folder": "%s" }' \
    "$sel_year" "$sel_folder" )"

  res="$(api_call "$getAction" "$BODY")"

  echo "$res" | jq



 else
  echo "$res" | jq

fi

