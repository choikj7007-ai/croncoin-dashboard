#!/bin/bash
# CronCoin Dashboard - Start Script
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRONCOIN_DIR="$HOME/croncoin-source/build/bin"
DATA_DIR="$HOME/.croncoin"

echo "=== CronCoin Dashboard Setup ==="

# 1. Check if nginx has the /api/ proxy configured
if ! grep -q 'location /api/' /etc/nginx/sites-available/default 2>/dev/null; then
    echo "[nginx] Adding /api/ proxy configuration..."
    sudo sed -i '/location \/ {/i\\tlocation /api/ {\n\t\tproxy_pass http:\/\/127.0.0.1:5000;\n\t\tproxy_set_header Host $host;\n\t\tproxy_set_header X-Real-IP $remote_addr;\n\t\tproxy_read_timeout 60s;\n\t}\n' /etc/nginx/sites-available/default
    echo "[nginx] Config updated."
else
    echo "[nginx] /api/ proxy already configured."
fi

# 2. Test and reload nginx
echo "[nginx] Testing configuration..."
sudo nginx -t
echo "[nginx] Reloading..."
sudo nginx -s reload || sudo systemctl start nginx
echo "[nginx] OK"

# 3. Start croncoind if not running
if ! pgrep -x croncoind > /dev/null; then
    echo "[croncoind] Starting regtest daemon..."
    "$CRONCOIN_DIR/croncoind" -regtest -daemon -txindex \
        -fallbackfee=0.01 \
        -rpcbind=127.0.0.1 \
        -rpcallowip=127.0.0.1
    sleep 2
    echo "[croncoind] Started."
else
    echo "[croncoind] Already running."
fi

# 4. Create default wallet if none exists
if ! "$CRONCOIN_DIR/croncoin-cli" -regtest listwallets 2>/dev/null | grep -q "default"; then
    echo "[wallet] Creating default wallet..."
    "$CRONCOIN_DIR/croncoin-cli" -regtest createwallet "default" 2>/dev/null || true
fi

# 5. Start the Python API backend
echo "[api] Starting dashboard backend on port 5000..."
if pgrep -f "server.py" > /dev/null; then
    echo "[api] Stopping existing instance..."
    pkill -f "server.py" || true
    sleep 1
fi

python3 "$SCRIPT_DIR/server.py" &
API_PID=$!
echo "[api] Backend PID: $API_PID"

echo ""
echo "=== CronCoin Dashboard Ready ==="
echo "  Dashboard: http://localhost/"
echo "  API:       http://localhost/api/blockchain"
echo "  Backend:   http://127.0.0.1:5000"
echo ""
echo "Press Ctrl+C to stop the API backend."
wait $API_PID
