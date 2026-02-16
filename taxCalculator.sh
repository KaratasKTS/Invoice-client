#!/usr/bin/env bash
set -euo pipefail

#calcs greek tax make comparison
# Usage:
#   ./tax_compare.sh <income>
# Example:
#   ./tax_compare.sh 35000
#   ./tax_compare.sh 125000.50

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <income>"
  exit 1
fi

income_raw="$1"

if ! [[ "$income_raw" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Error: income must be a number (e.g., 25000 or 25000.50)"
  exit 1
fi

income="$income_raw"

money2() { awk -v x="$1" 'BEGIN{ printf "%.2f", x }'; }

calc_oe_tax() {
  awk -v inc="$income" 'BEGIN { printf "%.2f", inc * 0.22 }'
}

calc_ae_tax() {

  BRACKET_LIMITS=(10000 20000 30000 40000 50000) 
  RATES=(0.09 0.09 0.26 0.34 0.39 0.44)

  awk -v inc="$income" \
      -v limits="${BRACKET_LIMITS[*]}" \
      -v rates="${RATES[*]}" '
  BEGIN {
    nLim = split(limits, L, " ");
    nRate = split(rates, R, " ");

    tax = 0.0;
    prev = 0.0;

    for (i = 1; i <= nLim; i++) {
      if (inc <= prev) break;

      upper = L[i];
      band = (inc < upper ? inc : upper) - prev;
      if (band > 0) tax += band * R[i];

      prev = upper;
    }

    if (inc > prev) {
      tax += (inc - prev) * R[nLim + 1];
    }

    printf "%.2f", tax;
  }'
}

effective_rate() {
  local tax="$1"
  awk -v inc="$income" -v tax="$tax" 'BEGIN { if (inc==0) printf "0.00"; else printf "%.2f", (tax/inc)*100 }'
}

oe_tax="$(calc_oe_tax)"
ae_tax="$(calc_ae_tax)"

oe_eff="$(effective_rate "$oe_tax")"
ae_eff="$(effective_rate "$ae_tax")"


diff_ae_minus_oe="$(awk -v a="$ae_tax" -v o="$oe_tax" 'BEGIN{ printf "%.2f", a - o }')"
diff_oe_minus_ae="$(awk -v a="$ae_tax" -v o="$oe_tax" 'BEGIN{ printf "%.2f", o - a }')"

echo "Income: $income"
echo
echo "ο.ε tax (flat 22%)        : $oe_tax    (effective: ${oe_eff}%)"
echo "Α.Ε tax (progressive)     : $ae_tax    (effective: ${ae_eff}%)"
echo


if awk -v d="$diff_ae_minus_oe" 'BEGIN{ exit !(d>0) }'; then
  echo "Difference: With Α.Ε you pay MORE than ο.ε by: $diff_ae_minus_oe"
elif awk -v d="$diff_ae_minus_oe" 'BEGIN{ exit !(d<0) }'; then
 
  diff_abs="$(awk -v d="$diff_ae_minus_oe" 'BEGIN{ printf "%.2f", (d<0?-d:d) }')"
  echo "Difference: With Α.Ε you pay LESS than ο.ε by: $diff_abs"
else
  echo "Difference: Both company types pay the SAME tax."
fi

