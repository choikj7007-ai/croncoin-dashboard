#!/bin/bash
# CronCoin Mainnet Miner
# cpuminer(SHA256d) 기반 솔로 마이닝. 3개 주소 라운드 로빈 순환.
#
# Usage:
#   ./miner.sh start    - 백그라운드로 채굴 시작
#   ./miner.sh stop     - 채굴 중지
#   ./miner.sh status   - 상태 확인
#   ./miner.sh log      - 최근 로그 확인

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/mining.conf"
CLI="$HOME/croncoin-source/build/bin/croncoin-cli"
MINERD="$SCRIPT_DIR/minerd"
LOG="$SCRIPT_DIR/miner.log"
PID_FILE="$SCRIPT_DIR/miner.pid"

is_running() {
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

do_stop() {
    local stopped=false
    # Kill process from PID file
    if is_running; then
        MAIN_PID=$(cat "$PID_FILE")
        pkill -P "$MAIN_PID" 2>/dev/null
        kill "$MAIN_PID" 2>/dev/null
        wait "$MAIN_PID" 2>/dev/null
        stopped=true
    fi
    rm -f "$PID_FILE"
    # Also kill any orphan miner processes
    pkill -f "$MINERD" 2>/dev/null
    pkill -f "_mining_loop" 2>/dev/null
    sleep 1
    # Force kill if still alive
    pkill -9 -f "$MINERD" 2>/dev/null
    pkill -9 -f "_mining_loop" 2>/dev/null
    if $stopped; then
        echo "Miner stopped."
    else
        echo "Miner is not running."
    fi
}

case "${1:-}" in
    stop)
        do_stop
        exit 0
        ;;
    status)
        if is_running; then
            PID=$(cat "$PID_FILE")
            echo "Miner is running (PID: $PID)"
            # Show active cpuminer process
            CPID=$(pgrep -P "$PID" -x minerd 2>/dev/null)
            [ -n "$CPID" ] && echo "  cpuminer PID: $CPID"
            echo ""
            tail -10 "$LOG" 2>/dev/null
        else
            echo "Miner is not running."
            rm -f "$PID_FILE" 2>/dev/null
        fi
        exit 0
        ;;
    log)
        tail -50 "$LOG" 2>/dev/null || echo "No log file yet."
        exit 0
        ;;
    start)
        if is_running; then
            echo "Miner is already running (PID: $(cat "$PID_FILE"))"
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|status|log}"
        exit 1
        ;;
esac

# ---- Validate environment ----

if [ ! -x "$MINERD" ]; then
    echo "ERROR: minerd not found at $MINERD"
    exit 1
fi

if [ ! -f "$CONF" ]; then
    echo "ERROR: mining.conf not found at $CONF"
    exit 1
fi

source "$CONF"

# Network settings
if [ "$NETWORK" = "mainnet" ]; then
    RPC_PORT=9332
    CLI_OPTS="-rpcport=$RPC_PORT -rpcwallet=${WALLET:-default}"
else
    RPC_PORT=19332
    CLI_OPTS="-testnet -rpcport=$RPC_PORT -rpcwallet=${WALLET:-default}"
fi

# RPC auth from cookie
if [ "$NETWORK" = "mainnet" ]; then
    COOKIE_FILE="$HOME/.croncoin/.cookie"
else
    COOKIE_FILE="$HOME/.croncoin/testnet3/.cookie"
fi

if [ ! -f "$COOKIE_FILE" ]; then
    echo "ERROR: Cookie file not found: $COOKIE_FILE"
    echo "Is croncoind running?"
    exit 1
fi

RPC_AUTH=$(cat "$COOKIE_FILE")
RPC_USER="${RPC_AUTH%%:*}"
RPC_PASS="${RPC_AUTH#*:}"

# Collect and validate addresses
ADDRESSES=()
for ADDR in "$MINING_ADDRESS_1" "$MINING_ADDRESS_2" "$MINING_ADDRESS_3"; do
    [ -z "$ADDR" ] && continue

    VALID=$($CLI $CLI_OPTS validateaddress "$ADDR" 2>/dev/null \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print('valid' if d.get('isvalid') else 'invalid')" 2>/dev/null)

    if [ "$VALID" = "valid" ]; then
        ADDRESSES+=("$ADDR")
    else
        echo "WARNING: Skipping invalid address: $ADDR"
    fi
done

if [ ${#ADDRESSES[@]} -eq 0 ]; then
    echo "ERROR: No valid mining addresses in mining.conf"
    exit 1
fi

ROTATE_SECONDS=$(( ${ROTATE_MINUTES:-60} * 60 ))
THREAD_OPT=""
if [ "${THREADS:-0}" -gt 0 ] 2>/dev/null; then
    THREAD_OPT="-t $THREADS"
fi

echo "Starting CronCoin Miner:"
echo "  Network:  $NETWORK (RPC port $RPC_PORT)"
echo "  Threads:  ${THREADS:-auto}"
echo "  Rotation: every ${ROTATE_MINUTES:-60} min"
echo "  Addresses (${#ADDRESSES[@]}):"
for i in "${!ADDRESSES[@]}"; do
    echo "    $((i+1)). ${ADDRESSES[$i]}"
done

# ---- Daemonize: mining loop ----

_mining_loop() {
    echo "$(date): === CronCoin Miner started (PID: $$) ===" >> "$LOG"
    echo "$(date): Network=$NETWORK, Addresses=${#ADDRESSES[@]}, Rotate=${ROTATE_SECONDS}s" >> "$LOG"
    echo $$ > "$PID_FILE"

    trap 'pkill -P $$ 2>/dev/null; rm -f "$PID_FILE"; echo "$(date): Miner stopped" >> "$LOG"' EXIT INT TERM

    INDEX=0
    while true; do
        ADDR="${ADDRESSES[$INDEX]}"
        DISPLAY_INDEX=$((INDEX + 1))
        echo "$(date): [${DISPLAY_INDEX}/${#ADDRESSES[@]}] Mining to $ADDR" >> "$LOG"

        # Start cpuminer as child process
        "$MINERD" \
            --algo=sha256d \
            --url="http://127.0.0.1:${RPC_PORT}" \
            --user="$RPC_USER" \
            --pass="$RPC_PASS" \
            --coinbase-addr="$ADDR" \
            --no-longpoll \
            $THREAD_OPT \
            >> "$LOG" 2>&1 &

        CPUMINER_PID=$!
        echo "$(date): cpuminer started (PID: $CPUMINER_PID)" >> "$LOG"

        # Wait for rotation interval, or until cpuminer exits
        ELAPSED=0
        while [ $ELAPSED -lt $ROTATE_SECONDS ]; do
            if ! kill -0 "$CPUMINER_PID" 2>/dev/null; then
                echo "$(date): cpuminer exited unexpectedly, restarting in 10s..." >> "$LOG"
                sleep 10
                break
            fi
            sleep 10
            ELAPSED=$((ELAPSED + 10))
        done

        # Stop cpuminer for rotation
        if kill -0 "$CPUMINER_PID" 2>/dev/null; then
            kill "$CPUMINER_PID" 2>/dev/null
            wait "$CPUMINER_PID" 2>/dev/null
        fi

        # Rotate to next address
        INDEX=$(( (INDEX + 1) % ${#ADDRESSES[@]} ))
    done
}

# Export variables for the subshell
export LOG PID_FILE MINERD RPC_PORT RPC_USER RPC_PASS ROTATE_SECONDS THREAD_OPT

nohup bash -c "
    $(declare -f _mining_loop)
    ADDRESSES=(${ADDRESSES[*]@Q})
    MINERD='$MINERD'
    LOG='$LOG'
    PID_FILE='$PID_FILE'
    RPC_PORT='$RPC_PORT'
    RPC_USER='$RPC_USER'
    RPC_PASS='$RPC_PASS'
    ROTATE_SECONDS=$ROTATE_SECONDS
    THREAD_OPT='$THREAD_OPT'
    _mining_loop
" >> "$LOG" 2>&1 &

sleep 1
echo ""
echo "Miner started in background."
echo "  Use '$0 status' to check"
echo "  Use '$0 log' to view logs"
echo "  Use '$0 stop' to stop"
