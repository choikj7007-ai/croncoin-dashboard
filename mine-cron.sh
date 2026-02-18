#!/bin/bash
# CronCoin auto-mining: generates 1 block every 3 minutes
CLI="/home/iamckj/croncoin-source/build/bin/croncoin-cli"
OPTS="-regtest -rpcport=19443 -rpcwallet=default"
LOG="/home/iamckj/croncoin-dashboard/mine-cron.log"

ADDR=$($CLI $OPTS getnewaddress 2>/dev/null)
if [ -z "$ADDR" ]; then
    echo "$(date): Failed to get address" >> "$LOG"
    exit 1
fi

RESULT=$($CLI $OPTS generatetoaddress 1 "$ADDR" 2>&1)
echo "$(date): Mined to $ADDR -> $RESULT" >> "$LOG"
