#!/bin/bash
# CronCoin Dashboard - Start Script
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRONCOIN_DIR="$HOME/croncoin-source/build/bin"
DATA_DIR="$HOME/.croncoin"
WWW_DIR="$HOME/www/html"
NGINX_CONF="/etc/nginx/conf.d/croncoin.conf"

echo "=== CronCoin Dashboard Setup ==="

# 1. Sync dashboard files to www directory
echo "[www] Syncing dashboard files to $WWW_DIR..."
mkdir -p "$WWW_DIR"
cp -r "$SCRIPT_DIR/html/"* "$WWW_DIR/"
echo "[www] OK"

# 2. Check if nginx has the /api/ proxy configured for www.croncoin.org
if ! grep -q 'location /api/' "$NGINX_CONF" 2>/dev/null; then
    echo "[nginx] Adding /api/ proxy to croncoin.conf..."
    sudo sed -i '/location \/ {/,/}/ {
        /}/a\\n       location /api/ {\n           proxy_pass http://127.0.0.1:5000;\n           proxy_set_header Host $host;\n           proxy_set_header X-Real-IP $remote_addr;\n           proxy_read_timeout 60s;\n       }
    }' "$NGINX_CONF"
    # Only patch the first server block (www.croncoin.org)
    echo "[nginx] Config updated."
else
    echo "[nginx] /api/ proxy already configured."
fi

# 3. Test and reload nginx
echo "[nginx] Testing configuration..."
sudo nginx -t
echo "[nginx] Reloading..."
sudo nginx -s reload || sudo systemctl start nginx
echo "[nginx] OK"

# 4. Start croncoind if not running
if ! pgrep -x croncoind > /dev/null; then
    echo "[croncoind] Starting testnet daemon..."
    "$CRONCOIN_DIR/croncoind" -testnet -daemon -txindex \
        -fallbackfee=0.01 \
        -rpcbind=127.0.0.1 \
        -rpcallowip=127.0.0.1
    sleep 2
    echo "[croncoind] Started."
else
    echo "[croncoind] Already running."
fi

# 5. Create default wallet if none exists
if ! "$CRONCOIN_DIR/croncoin-cli" -testnet listwallets 2>/dev/null | grep -q "default"; then
    echo "[wallet] Creating default wallet..."
    "$CRONCOIN_DIR/croncoin-cli" -testnet createwallet "default" 2>/dev/null || true
fi

# 6. Start the Python API backend
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
echo "  Dashboard: http://www.croncoin.org/"
echo "  API:       http://www.croncoin.org/api/blockchain"
echo "  Backend:   http://127.0.0.1:5000"
echo ""
echo "Press Ctrl+C to stop the API backend."
wait $API_PID
