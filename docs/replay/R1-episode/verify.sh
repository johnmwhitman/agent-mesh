#!/usr/bin/env bash
# Verify the R1 ratification episode replay artifact
# Exit 0 if byte-identical and internally consistent (even if ledger status contradicts receipts)

set -euo pipefail

cd "$(dirname "$0")"

echo "=== R1 Episode Replay Verification ==="
echo

# Step 1: Verify chain hash
echo "Step 1: Verifying chain hash..."
sha256sum -c manifest.sha256
if [ $? -ne 0 ]; then
    echo "FAIL: chain hash mismatch"
    exit 1
fi
echo "PASS: chain hash verified"
echo

# Step 2: Count receipts by action
echo "Step 2: Counting receipts by action..."
if ! command -v jq &> /dev/null; then
    echo "SKIP: jq not available, using python3"
    ACK_COUNT=$(python3 -c "import json; data=json.load(open('receipts.json')); print(sum(1 for r in data if json.loads(r['data'])['action']=='r-ack'))")
    DECLINE_COUNT=$(python3 -c "import json; data=json.load(open('receipts.json')); print(sum(1 for r in data if json.loads(r['data'])['action'].startswith('r-decline')))")
else
    ACK_COUNT=$(jq '[.[] | select(.data | fromjson | .action == "r-ack")] | length' receipts.json)
    DECLINE_COUNT=$(jq '[.[] | select(.data | fromjson | .action | startswith("r-decline"))] | length' receipts.json)
fi

echo "  r-ack (APPROVE): $ACK_COUNT"
echo "  r-decline (REJECT): $DECLINE_COUNT"
echo

# Step 3: Verify ratification status
echo "Step 3: Checking ratification status..."
if ! command -v jq &> /dev/null; then
    STATUS=$(python3 -c "import json; data=json.load(open('ratification.json')); print(json.loads(data[0]['data'])['status'])")
else
    STATUS=$(jq -r '.[0].data | fromjson | .status' ratification.json)
fi
echo "  Ledger status: $STATUS"
echo

# Step 4: Verify agent count
echo "Step 4: Verifying agent count..."
if ! command -v jq &> /dev/null; then
    AGENT_COUNT=$(python3 -c "import json; data=json.load(open('agents.json')); print(len(data))")
else
    AGENT_COUNT=$(jq 'length' agents.json)
fi
echo "  Agents in fleet: $AGENT_COUNT"
echo

# Step 5: Consistency check
echo "Step 5: Consistency check..."
if [ "$ACK_COUNT" -ge 3 ] && [ "$DECLINE_COUNT" -ge 3 ]; then
    echo "PASS: receipt trail shows quorum reached ($ACK_COUNT approvals) then rejections ($DECLINE_COUNT declines)"
    echo "NOTE: ledger status '$STATUS' is inconsistent with receipt trail (this is the point)"
else
    echo "FAIL: receipt trail does not match expected pattern"
    exit 1
fi
echo

echo "=== VERIFICATION COMPLETE ==="
echo "Artifact is byte-identical and internally consistent."
echo "The ledger status contradicts the receipt trail — this is the failure mode the artifact exposes."
exit 0
