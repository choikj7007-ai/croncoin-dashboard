#!/bin/bash
# CronCoin auto-mining: generates 1 block every 3 minutes
# Requires a valid mining address configured in mining.conf

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/mining.conf"
CLI="/home/iamckj/croncoin-source/build/bin/croncoin-cli"
LOG="$SCRIPT_DIR/mine-cron.log"

# 1. Load config
if [ ! -f "$CONF" ]; then
    echo "$(date): ERROR - mining.conf not found. Create it first." >> "$LOG"
    exit 1
fi

source "$CONF"

# 2. Set CLI options based on network
if [ "$NETWORK" = "mainnet" ]; then
    OPTS="-rpcport=9332 -rpcwallet=${WALLET:-default}"
else
    OPTS="-testnet -rpcport=19332 -rpcwallet=${WALLET:-default}"
fi

# 3. Check mining address is configured
if [ -z "$MINING_ADDRESS" ]; then
    echo "$(date): ERROR - MINING_ADDRESS is empty. Set it in mining.conf" >> "$LOG"
    exit 1
fi

# 4. Validate address with the node
VALID=$($CLI $OPTS validateaddress "$MINING_ADDRESS" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('valid' if d.get('isvalid') else 'invalid')" 2>/dev/null)

if [ "$VALID" != "valid" ]; then
    echo "$(date): ERROR - Invalid mining address: $MINING_ADDRESS" >> "$LOG"
    exit 1
fi

# 5. Mine
RESULT=$($CLI $OPTS generatetoaddress 1 "$MINING_ADDRESS" 2>&1)
echo "$(date): Mined to $MINING_ADDRESS -> $RESULT" >> "$LOG"
