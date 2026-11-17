#!/usr/bin/env bash
set -euo pipefail

# Τα τιμολόγια από τη γραμμή εντολών. Η σελίδα (./start.sh) κάνει τα ίδια και
# επιπλέον αποθηκεύει και ανοίγει τα αρχεία στον υπολογιστή.
#
# Η διεύθυνση της υπηρεσίας, ο μυστικός κωδικός και το email του λογιστή
# διαβάζονται από το config.json, το ίδιο αρχείο που χρησιμοποιεί η σελίδα.

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

for tool in curl jq openssl; do
  command -v "$tool" > /dev/null || { echo "Λείπει το πρόγραμμα: $tool" >&2; exit 1; }
done

CONFIG_FILE="${INVOICE_CONFIG:-${SCRIPT_DIR}/config.json}"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Δεν βρέθηκε το αρχείο ρυθμίσεων: $CONFIG_FILE" >&2
  echo "Τρέξε μία φορά το ./start.sh και συμπλήρωσε τις Ρυθμίσεις." >&2
  exit 1
fi

URL="$(jq -r '.url // empty' "$CONFIG_FILE")"
SECRET="$(jq -r '.key // empty' "$CONFIG_FILE")"
ACCOUNTANT_EMAIL="$(jq -r '.accountantEmail // empty' "$CONFIG_FILE")"

[[ -n "$URL" ]] || { echo "Δεν έχει οριστεί η διεύθυνση της υπηρεσίας. Συμπλήρωσέ τη στις Ρυθμίσεις (./start.sh)." >&2; exit 1; }
[[ -n "$SECRET" ]] || { echo "Δεν έχει οριστεί ο μυστικός κωδικός. Συμπλήρωσέ τον στις Ρυθμίσεις (./start.sh)." >&2; exit 1; }

CURRENT_YEAR="$(date +%Y)"

MONTH="0"
YEAR="0"
FETCH_TYPE=""
EXEC_TYPE=""
NEWER_THAN=""
ACTION=""

# Ρωτά ναι/όχι. Με «ο» η εκτέλεση σταματά.
confirm() {
  local question="$1"
  while true; do
    read -rp "$question (ν/ο): " answer
    case "$answer" in
      ν|Ν|n|N|y|Y) return 0 ;;
      ο|Ο|o|O) echo "Ακυρώθηκε."; exit 0 ;;
      *) echo "Απάντησε ν (ναι) ή ο (όχι)." ;;
    esac
  done
}

# Υπογράφει το "ts.exec_type.body" με τον κωδικό και στέλνει το αίτημα.
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

# Δείχνει την απάντηση τακτοποιημένη, ή όπως ήρθε αν δεν είναι JSON.
print_response() {
  printf '%s' "$1" | jq . 2> /dev/null || printf '%s\n' "$1"
}

# Σταματά με το μήνυμα της υπηρεσίας όταν η απάντηση δεν είναι {"ok": true, ...}.
require_ok() {
  local res="$1"
  if [[ "$(printf '%s' "$res" | jq -r '.ok // false' 2> /dev/null)" != "true" ]]; then
    echo "Η υπηρεσία ανέφερε πρόβλημα:" >&2
    print_response "$res" >&2
    exit 1
  fi
}

print_dir_structure() {
  local json="$1"
  echo
  echo "Φάκελοι στο Google Drive:"
  printf '%s' "$json" | jq -r '
    .return_value
    | to_entries
    | sort_by(.key)
    | .[]
    | "|______> \(.key)\n" +
      ( if (.value | length) == 0
        then "         |______> (άδειος)\n"
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

# Ο χρήστης διαλέγει φάκελο· τυπώνει "έτος|φάκελος" στο stdout.
# Το μενού και τα μηνύματα πάνε στο stderr για να μην μπερδεύονται με το αποτέλεσμα.
select_archive_folder() {
  local json="$1"

  local -a options
  mapfile -t options < <(build_folder_options "$json")

  if (( ${#options[@]} == 0 )); then
    echo "Δεν υπάρχουν ακόμα φάκελοι με τιμολόγια." >&2
    exit 0
  fi

  local choice
  PS3="Διάλεξε φάκελο: "
  select choice in "${options[@]}"; do
    [[ -n "${choice:-}" ]] || { echo "Μη έγκυρη επιλογή." >&2; continue; }
    printf '%s|%s\n' "${choice%% / *}" "${choice#* / }"
    return 0
  done
}

echo "Τι θέλεις να κάνεις;"
PS3="Διάλεξε (1-5): "
select choice in \
  "Έλεγχος για νέα τιμολόγια στο email" \
  "Έλεγχος για νέα τιμολόγια και αποστολή τους σε εμένα" \
  "Αποστολή ενός μήνα με email" \
  "Καθαρισμός συμπιεσμένων αρχείων (zip) ενός μήνα {ΔΙΑΓΡΑΦΗ}" \
  "Διαγραφή ενός μήνα από το Drive {ΔΙΑΓΡΑΦΗ}"; do

  case "$REPLY" in
    1) EXEC_TYPE="FETCH"; break ;;
    2) EXEC_TYPE="FETCH_N_INSPECT"; break ;;
    3) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="MAILER"; break ;;
    4) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="REMOVE_ZIP_FILES"; break ;;
    5) EXEC_TYPE="FETCH_DIR_STRUCTURE"; ACTION="REMOVE_ARCHIVES"; break ;;
    *) echo "Διάλεξε από 1 έως 5." ;;
  esac
done

case "$ACTION" in
  REMOVE_ZIP_FILES) confirm "ΠΡΟΣΟΧΗ: θα διαγραφούν συμπιεσμένα αρχεία από το Drive. Συνέχεια;" ;;
  REMOVE_ARCHIVES) confirm "ΠΡΟΣΟΧΗ: θα διαγραφεί ολόκληρος μήνας από το Drive. Συνέχεια;" ;;
esac

if [[ "$EXEC_TYPE" == "FETCH" || "$EXEC_TYPE" == "FETCH_N_INSPECT" ]]; then
  echo "Για ποια περίοδο;"
  PS3="Διάλεξε (1-2): "
  select choice in \
    "Τις τελευταίες ημέρες (1-90)" \
    "Συγκεκριμένο μήνα"; do

    case "$REPLY" in
      1) FETCH_TYPE="NEWER_THAN"; break ;;
      2) FETCH_TYPE="MONTH_YEAR"; break ;;
      *) echo "Διάλεξε 1 ή 2." ;;
    esac
  done
fi

if [[ "$FETCH_TYPE" == "MONTH_YEAR" ]]; then
  while true; do
    read -rp "Μήνας 1-12 (0 για τον τρέχοντα): " MONTH
    [[ $MONTH =~ ^[0-9]{1,2}$ ]] || { echo "Γράψε αριθμό από 0 έως 12."; continue; }
    MONTH=$((10#$MONTH))
    (( MONTH <= 12 )) || { echo "Γράψε αριθμό από 0 έως 12."; continue; }
    break
  done

  while true; do
    read -rp "Έτος 2000-$CURRENT_YEAR (0 για το τρέχον): " YEAR
    [[ $YEAR =~ ^[0-9]{1,4}$ ]] || { echo "Γράψε 0 ή έτος από 2000 έως $CURRENT_YEAR."; continue; }
    YEAR=$((10#$YEAR))
    (( YEAR == 0 || (YEAR >= 2000 && YEAR <= CURRENT_YEAR) )) || { echo "Γράψε 0 ή έτος από 2000 έως $CURRENT_YEAR."; continue; }
    break
  done
fi

if [[ "$FETCH_TYPE" == "NEWER_THAN" ]]; then
  while true; do
    read -rp "Πόσες ημέρες πίσω (1-90): " NEWER_THAN
    [[ $NEWER_THAN =~ ^[0-9]{1,2}$ ]] || { echo "Γράψε αριθμό από 1 έως 90."; continue; }
    NEWER_THAN=$((10#$NEWER_THAN))
    (( NEWER_THAN >= 1 && NEWER_THAN <= 90 )) || { echo "Γράψε αριθμό από 1 έως 90."; continue; }
    break
  done
fi

# Πρώτο αίτημα

BODY="$(jq -cn \
  --arg month "$MONTH" --arg year "$YEAR" --arg newer_than "$NEWER_THAN" \
  --arg fetch_type "$FETCH_TYPE" --arg action "$ACTION" \
  '{month: $month, year: $year, newer_than: $newer_than, fetch_type: $fetch_type, action: $action}')"

res="$(api_call "$EXEC_TYPE" "$BODY")"

require_ok "$res"

if [[ "$EXEC_TYPE" != "FETCH_DIR_STRUCTURE" ]]; then
  print_response "$res"
  printf '%s' "$res" | jq -r '.return_value | "Νέα τιμολόγια στο Drive: \(.saved | length). Υπήρχαν ήδη: \(.existing | length)."'
  exit 0
fi

print_dir_structure "$res"

selection="$(select_archive_folder "$res")"
[[ -n "$selection" ]] || exit 0

sel_year="${selection%%|*}"
sel_folder="${selection#*|}"

if [[ "$ACTION" == "MAILER" ]]; then

  MAIL_TO=""
  echo "Σε ποιον να σταλεί;"
  PS3="Διάλεξε (1-3): "
  select mail_choice in \
    "Σε εμένα" \
    "Στον λογιστή μου${ACCOUNTANT_EMAIL:+ ($ACCOUNTANT_EMAIL)}" \
    "Σε άλλη διεύθυνση"; do

    case "$REPLY" in
      1) MAIL_TO="USER"; break ;;
      2) MAIL_TO="ACCOUNTANT"; break ;;
      3) MAIL_TO="OTHER"; break ;;
      *) echo "Διάλεξε από 1 έως 3." ;;
    esac
  done

  if [[ "$MAIL_TO" == "ACCOUNTANT" ]]; then
    if [[ -z "$ACCOUNTANT_EMAIL" ]]; then
      echo "Δεν έχεις ορίσει email λογιστή. Πρόσθεσέ το στις Ρυθμίσεις (./start.sh)." >&2
      exit 1
    fi
    confirm "ΠΡΟΣΟΧΗ: τα τιμολόγια θα σταλούν στον λογιστή ($ACCOUNTANT_EMAIL). Συνέχεια;"
    MAIL_TO="$ACCOUNTANT_EMAIL"
  fi

  if [[ "$MAIL_TO" == "OTHER" ]]; then
    while true; do
      read -rp "Διεύθυνση email: " mail
      if [[ "$mail" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        MAIL_TO="$mail"
        break
      else
        echo "Μη έγκυρο email. Πρέπει να μοιάζει με onoma@example.com"
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
echo "Έγινε."
