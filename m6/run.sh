#!/bin/bash
# ============================================================
#  BIDZON STRESS TEST — RUN SCRIPT
#  Run this on each machine with the correct MACHINE_NUM
#  Usage: ./run.sh 1   (for machine 1)
#         ./run.sh 2   (for machine 2) ... etc
# ============================================================

MACHINE_NUM=${1:-1}
SCRIPT="machine${MACHINE_NUM}.js"
OUTPUT_DIR="results/machine${MACHINE_NUM}"
SUMMARY="${OUTPUT_DIR}/summary.json"
LOG="${OUTPUT_DIR}/run.log"

# Validate
if [ ! -f "$SCRIPT" ]; then
  echo "❌ Script not found: $SCRIPT"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  BIDZON STRESS TEST — Machine ${MACHINE_NUM}"
echo "  Script : $SCRIPT"
echo "  Output : $OUTPUT_DIR"
echo "  Started: $(date)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Run k6
k6 run \
  --out json="${OUTPUT_DIR}/raw.json" \
  --summary-export="${SUMMARY}" \
  --log-output="file=${LOG}" \
  "$SCRIPT"

EXIT_CODE=$?

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test finished — Exit code: $EXIT_CODE"
echo "  Summary : $SUMMARY"
echo "  Log     : $LOG"
echo "  Ended   : $(date)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Open report with data if on a machine with a browser
# open reports/report.html?data=${SUMMARY}

exit $EXIT_CODE
