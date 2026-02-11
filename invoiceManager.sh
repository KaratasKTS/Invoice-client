#!/bin/bash
set -euo pipefail

#VALID TYPES INCLUDE

#FETCH
#FETCH_N_INSPECT
#MAIL_INVOICES_TO
#REMOVE_ZIP_FILES
#REMOVE_ARCHIVES

URL="https://script.google.com/macros/s/AKfycbzDMr1lk5_O-KJy8L9CYjluvS_Tzgf1aKvUbENpWwfjQRct4fGYqObqQ9tQ8vO_bLY/exec"
SECRET="njfksbf483rhkrnaufgij3R@TREF#WFEafA"

BODY='{"action":"ping","value":123}'
TS="$(date +%s)"
MSG="${TS}.${BODY}"
EXEC_TYPE="$1";

if [[ "$EXEC_TYPE" == 'MAIL_INVOICES_TO' ]]; then
	echo "This param will send invoices to your accountant are you sure you want to procced? y/n \n";

	while true; do
  read -rp "This will send invoices to your accountant. Are you sure? (y/n): " yn
  case "$yn" in
    y|Y) break ;;
    n|N) exit 0 ;;
    *) echo "Please answer y or n." ;;
  esac
done

fi
	
SIG="$(printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -L  \
  -H 'Content-Type: application/json' \
  --data "$BODY" \
  "$URL?ts=$TS&sig=$SIG&exec_type=$EXEC_TYPE"
echo
