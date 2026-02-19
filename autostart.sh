#!/bin/bash
# CronCoin Auto-Start Script (called by crontab @reboot)
# Starts croncoind, loads wallet, and starts dashboard API server.
# Network config is read from mining.conf (NETWORK=testnet|mainnet)

SCRIPT_DIR="/home/iamckj/croncoin-dashboard"
LOG="$SCRIPT_DIR/autostart.log"
CLI="/home/iamckj/croncoin-source/build/bin/croncoin-cli"
DAEMON="/home/iamckj/croncoin-source/build/bin/croncoind"
SERVER="$SCRIPT_DIR/server.py"
CONF="$SCRIPT_DIR/mining.conf"

exec >> "$LOG" 2>&1
echo "===== $(date) ====="

# Load network config
if [ -f "$CONF" ]; then
    source "$CONF"
fi

if [ "$NETWORK" = "mainnet" ]; then
    NET_OPTS=""
    RPC_PORT=9332
    COOKIE="$HOME/.croncoin/.cookie"
    echo "[config] Network: MAINNET"
else
    NET_OPTS="-testnet"
    RPC_PORT=19332
    COOKIE="$HOME/.croncoin/testnet3/.cookie"
    echo "[config] Network: TESTNET"
fi

CLI_OPTS="$NET_OPTS -rpcport=$RPC_PORT"

# 1. Start croncoind
if ! pgrep -x croncoind > /dev/null; then
    echo "[croncoind] Starting..."
    "$DAEMON" $NET_OPTS -daemon -txindex \
        -fallbackfee=0.01 \
        -rpcbind=127.0.0.1 \
        -rpcallowip=127.0.0.1
else
    echo "[croncoind] Already running."
fi

# 2. Wait for RPC to be ready
echo "[croncoind] Waiting for RPC..."
for i in $(seq 1 30); do
    if "$CLI" $CLI_OPTS getblockchaininfo > /dev/null 2>&1; then
        echo "[croncoind] RPC ready."
        break
    fi
    sleep 2
done

# 3. Load wallet
if ! "$CLI" $CLI_OPTS listwallets 2>/dev/null | grep -q "${WALLET:-default}"; then
    echo "[wallet] Loading ${WALLET:-default} wallet..."
    "$CLI" $CLI_OPTS loadwallet "${WALLET:-default}" 2>/dev/null || true
else
    echo "[wallet] Already loaded."
fi

# 4. Start dashboard API server
if pgrep -f "server.py" > /dev/null; then
    echo "[api] Already running."
else
    echo "[api] Starting dashboard API on port 5000..."
    cd "$SCRIPT_DIR"
    NETWORK="$NETWORK" RPC_PORT="$RPC_PORT" RPC_COOKIE="$COOKIE" \
        WALLET_NAME="${WALLET:-default}" \
        python3 "$SERVER" >> "$LOG" 2>&1 &
    echo "[api] PID: $!"
fi

echo "[done] Autostart complete."
