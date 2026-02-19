#!/bin/bash
# CronCoin Auto-Start Script (called by crontab @reboot)
# Starts croncoind, loads wallet, and starts dashboard API server.

LOG="/home/iamckj/croncoin-dashboard/autostart.log"
CLI="/home/iamckj/croncoin-source/build/bin/croncoin-cli"
DAEMON="/home/iamckj/croncoin-source/build/bin/croncoind"
SERVER="/home/iamckj/croncoin-dashboard/server.py"

exec >> "$LOG" 2>&1
echo "===== $(date) ====="

# 1. Start croncoind
if ! pgrep -x croncoind > /dev/null; then
    echo "[croncoind] Starting..."
    "$DAEMON" -testnet -daemon -txindex \
        -fallbackfee=0.01 \
        -rpcbind=127.0.0.1 \
        -rpcallowip=127.0.0.1
else
    echo "[croncoind] Already running."
fi

# 2. Wait for RPC to be ready
echo "[croncoind] Waiting for RPC..."
for i in $(seq 1 30); do
    if "$CLI" -testnet getblockchaininfo > /dev/null 2>&1; then
        echo "[croncoind] RPC ready."
        break
    fi
    sleep 2
done

# 3. Load wallet
if ! "$CLI" -testnet listwallets 2>/dev/null | grep -q "default"; then
    echo "[wallet] Loading default wallet..."
    "$CLI" -testnet loadwallet "default" 2>/dev/null || true
else
    echo "[wallet] Already loaded."
fi

# 4. Start dashboard API server
if pgrep -f "server.py" > /dev/null; then
    echo "[api] Already running."
else
    echo "[api] Starting dashboard API on port 5000..."
    cd /home/iamckj/croncoin-dashboard
    python3 "$SERVER" >> "$LOG" 2>&1 &
    echo "[api] PID: $!"
fi

echo "[done] Autostart complete."
