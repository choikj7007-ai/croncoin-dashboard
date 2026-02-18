#!/usr/bin/env python3
"""CronCoin Dashboard API Backend - stdlib only HTTP server."""

import json
import http.server
import urllib.request
import urllib.error
import base64
import os
import sys
import re
import hashlib
import hmac


# ---- BIP32 / secp256k1 helpers for private key derivation ----

_SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_SECP256K1_Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_SECP256K1_Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _ec_point_add(p1, p2):
    if p1 is None: return p2
    if p2 is None: return p1
    P = _SECP256K1_P
    x1, y1 = p1; x2, y2 = p2
    if x1 == x2 and y1 != y2: return None
    if x1 == x2:
        lam = (3 * x1 * x1) * pow(2 * y1, P - 2, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, P - 2, P) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def _ec_point_mul(k, point):
    result = None; addend = point
    while k:
        if k & 1: result = _ec_point_add(result, addend)
        addend = _ec_point_add(addend, addend)
        k >>= 1
    return result


def _privkey_to_compressed_pubkey(key_bytes):
    k = int.from_bytes(key_bytes, "big")
    x, y = _ec_point_mul(k, (_SECP256K1_Gx, _SECP256K1_Gy))
    prefix = b"\x02" if y % 2 == 0 else b"\x03"
    return prefix + x.to_bytes(32, "big")


def _b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + _B58_ALPHABET.index(c)
    byte_len = (n.bit_length() + 7) // 8
    result = n.to_bytes(byte_len, "big") if byte_len > 0 else b""
    # count only LEADING '1' characters (each = a 0x00 byte)
    pad = 0
    for c in s:
        if c == "1": pad += 1
        else: break
    return bytes(pad) + result


def _b58decode_check(s):
    data = _b58decode(s)
    payload, cksum = data[:-4], data[-4:]
    expected = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    if cksum != expected:
        raise ValueError("Invalid base58 checksum")
    return payload


def _b58encode(data):
    n = int.from_bytes(data, "big")
    result = []
    while n > 0:
        n, r = divmod(n, 58)
        result.append(_B58_ALPHABET[r])
    # leading zero bytes → leading '1's
    pad = 0
    for b in data:
        if b == 0: pad += 1
        else: break
    return ("1" * pad) + "".join(reversed(result))


def _b58encode_check(payload):
    cksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    return _b58encode(payload + cksum)


def _parse_xprv(xprv_b58):
    """Parse tprv/xprv base58 string → (private_key_32bytes, chain_code_32bytes)"""
    payload = _b58decode_check(xprv_b58)
    # Extended key: 4(ver) + 1(depth) + 4(fingerprint) + 4(child#) + 32(chaincode) + 33(key)
    chain_code = payload[13:45]
    key = payload[46:78]   # skip 0x00 prefix at payload[45]
    return key, chain_code


def _bip32_derive_child(key, chain_code, index):
    if index >= 0x80000000:  # hardened
        data = b"\x00" + key + index.to_bytes(4, "big")
    else:  # normal – needs compressed pubkey
        data = _privkey_to_compressed_pubkey(key) + index.to_bytes(4, "big")
    I = hmac.new(chain_code, data, hashlib.sha512).digest()
    IL, IR = I[:32], I[32:]
    child_key = (int.from_bytes(IL, "big") + int.from_bytes(key, "big")) % _SECP256K1_N
    return child_key.to_bytes(32, "big"), IR


def _parse_hdkeypath(path_str):
    """Parse 'm/84h/1h/0h/0/39' → list of BIP32 child indices."""
    parts = path_str.strip().split("/")
    if parts[0] == "m":
        parts = parts[1:]
    indices = []
    for p in parts:
        if p.endswith("h") or p.endswith("'"):
            indices.append(int(p[:-1]) + 0x80000000)
        else:
            indices.append(int(p))
    return indices


def _privkey_to_wif(key_bytes, testnet=True):
    prefix = b"\xef" if testnet else b"\x80"
    return _b58encode_check(prefix + key_bytes + b"\x01")  # compressed


def derive_privkey_wif(xprv_b58, hdkeypath):
    """Derive WIF private key from master tprv and full HD key path."""
    key, chain_code = _parse_xprv(xprv_b58)
    for index in _parse_hdkeypath(hdkeypath):
        key, chain_code = _bip32_derive_child(key, chain_code, index)
    return _privkey_to_wif(key, testnet=True)


def _get_master_tprv():
    """Get master tprv from wallet's listdescriptors (cached)."""
    if hasattr(_get_master_tprv, "_cache"):
        return _get_master_tprv._cache
    result, err = rpc_call("listdescriptors", [True])
    if err or not isinstance(result, dict):
        return None
    for d in result.get("descriptors", []):
        desc = d.get("desc", "")
        # Match wpkh(tprv.../0/*) – receive address descriptor
        m = re.match(r"^wpkh\((tprv[A-Za-z0-9]+)/", desc)
        if m and "/0/*)" in desc:
            _get_master_tprv._cache = m.group(1)
            return m.group(1)
    return None

RPC_HOST = os.environ.get("RPC_HOST", "127.0.0.1")
RPC_PORT = int(os.environ.get("RPC_PORT", "19443"))
RPC_USER = os.environ.get("RPC_USER", "")
RPC_PASSWORD = os.environ.get("RPC_PASSWORD", "")
COOKIE_FILE = os.environ.get(
    "RPC_COOKIE",
    os.path.expanduser("~/.croncoin/regtest/.cookie"),
)
LISTEN_PORT = int(os.environ.get("DASHBOARD_PORT", "5000"))
WALLET_NAME = os.environ.get("WALLET_NAME", "default")
STATIC_DIR = os.environ.get("STATIC_DIR", os.path.expanduser("~/html"))

MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
}

_rpc_id = 0


def _get_auth():
    """Get RPC auth credentials (cookie or user/pass)."""
    if RPC_USER and RPC_PASSWORD:
        return f"{RPC_USER}:{RPC_PASSWORD}"
    try:
        with open(COOKIE_FILE, "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        return "__cookie__:password"


def rpc_call(method, params=None):
    """Make a JSON-RPC call to croncoind."""
    global _rpc_id
    _rpc_id += 1

    auth = _get_auth()
    wallet_path = f"/wallet/{WALLET_NAME}" if WALLET_NAME else ""
    url = f"http://{RPC_HOST}:{RPC_PORT}{wallet_path}"

    payload = json.dumps({
        "jsonrpc": "1.0",
        "id": _rpc_id,
        "method": method,
        "params": params or [],
    }).encode()

    auth_b64 = base64.b64encode(auth.encode()).decode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Basic {auth_b64}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            if data.get("error"):
                return None, data["error"]
            return data.get("result"), None
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            err = json.loads(body)
            return None, err.get("error", {"message": body, "code": e.code})
        except json.JSONDecodeError:
            return None, {"message": body, "code": e.code}
    except urllib.error.URLError as e:
        return None, {"message": str(e.reason), "code": -1}
    except Exception as e:
        return None, {"message": str(e), "code": -1}


def json_response(handler, data, status=200):
    """Send a JSON HTTP response."""
    body = json.dumps(data, default=str).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def error_response(handler, message, status=500):
    json_response(handler, {"error": message}, status)


# Route patterns: (method, regex) -> handler
ROUTES = []


def route(method, pattern):
    """Decorator to register a route."""
    def decorator(func):
        ROUTES.append((method, re.compile(f"^{pattern}$"), func))
        return func
    return decorator


# --- GET endpoints ---

@route("GET", r"/api/blockchain")
def get_blockchain(handler, match):
    result, err = rpc_call("getblockchaininfo")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/block/([0-9a-fA-F]{64})")
def get_block(handler, match):
    blockhash = match.group(1)
    result, err = rpc_call("getblock", [blockhash, 2])
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/blockheight/(\d+)")
def get_block_by_height(handler, match):
    height = int(match.group(1))
    blockhash, err = rpc_call("getblockhash", [height])
    if err:
        return error_response(handler, err["message"])
    result, err = rpc_call("getblock", [blockhash, 2])
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/tx/([0-9a-fA-F]{64})")
def get_tx(handler, match):
    txid = match.group(1)
    result, err = rpc_call("getrawtransaction", [txid, True])
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/mempool")
def get_mempool(handler, match):
    result, err = rpc_call("getmempoolinfo")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/network")
def get_network(handler, match):
    result, err = rpc_call("getnetworkinfo")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/peers")
def get_peers(handler, match):
    result, err = rpc_call("getpeerinfo")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/mining")
def get_mining(handler, match):
    result, err = rpc_call("getmininginfo")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/wallet/balance")
def get_balance(handler, match):
    result, err = rpc_call("getbalances")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/wallet/seed")
def get_wallet_seed(handler, match):
    result, err = rpc_call("listdescriptors", [True])
    if err:
        return error_response(handler, err.get("message", "Failed to get descriptors"))
    descriptors = []
    master_tprv = None
    for d in result.get("descriptors", []):
        desc = d.get("desc", "")
        descriptors.append(desc)
        if not master_tprv:
            m = re.match(r"^(?:sh\()?wpkh\((tprv[A-Za-z0-9]+)/", desc)
            if m:
                master_tprv = m.group(1)
    info, err2 = rpc_call("getwalletinfo")
    resp = {
        "master_key": master_tprv or "",
        "descriptors": descriptors,
        "wallet_name": info.get("walletname", "") if not err2 else "",
        "keypoolsize": info.get("keypoolsize", 0) if not err2 else 0,
    }
    json_response(handler, resp)


@route("GET", r"/api/wallet/newaddress")
def get_new_address(handler, match):
    address, err = rpc_call("getnewaddress")
    if err:
        return error_response(handler, err["message"])
    resp = {"address": address}
    info, err2 = rpc_call("getaddressinfo", [address])
    if not err2 and isinstance(info, dict):
        resp["pubkey"] = info.get("pubkey", "")
        hdkeypath = info.get("hdkeypath", "")
        if hdkeypath:
            tprv = _get_master_tprv()
            if tprv:
                try:
                    resp["privkey"] = derive_privkey_wif(tprv, hdkeypath)
                except Exception:
                    pass
    json_response(handler, resp)


@route("GET", r"/api/wallet/transactions")
def get_wallet_transactions(handler, match):
    result, err = rpc_call("listtransactions", ["*", 20])
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


@route("GET", r"/api/wallet/info")
def get_wallet_info(handler, match):
    result, err = rpc_call("getwalletinfo")
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


# --- Rich List (UTXO scan with cache) ---

_richlist_cache = {"height": -1, "data": None}


def _build_richlist():
    """Scan all blocks to build address balances from UTXOs."""
    info, err = rpc_call("getblockchaininfo")
    if err:
        return None, err

    height = info["blocks"]

    # Return cache if height unchanged
    if _richlist_cache["height"] == height and _richlist_cache["data"] is not None:
        return _richlist_cache["data"], None

    utxos = {}   # (txid, n) -> (address, value)
    balances = {}  # address -> balance

    for h in range(height + 1):
        bhash, err = rpc_call("getblockhash", [h])
        if err:
            continue
        block, err = rpc_call("getblock", [bhash, 2])
        if err:
            continue
        for tx in block.get("tx", []):
            # Remove spent UTXOs
            for vin in tx.get("vin", []):
                if "coinbase" in vin:
                    continue
                key = (vin["txid"], vin["vout"])
                spent = utxos.pop(key, None)
                if spent:
                    addr, val = spent
                    balances[addr] = balances.get(addr, 0) - val

            # Add new UTXOs
            for vout in tx.get("vout", []):
                spk = vout.get("scriptPubKey", {})
                addr = spk.get("address")
                if not addr:
                    continue
                val = vout["value"]
                key = (tx["txid"], vout["n"])
                utxos[key] = (addr, val)
                balances[addr] = balances.get(addr, 0) + val

    # Build sorted list
    rich = [
        {"address": addr, "balance": bal}
        for addr, bal in balances.items()
        if bal > 0
    ]
    rich.sort(key=lambda x: x["balance"], reverse=True)

    total_supply = sum(item["balance"] for item in rich)
    result = {
        "height": height,
        "total_supply": total_supply,
        "total_addresses": len(rich),
        "addresses": rich[:100],
    }

    _richlist_cache["height"] = height
    _richlist_cache["data"] = result
    return result, None


@route("GET", r"/api/richlist")
def get_richlist(handler, match):
    result, err = _build_richlist()
    if err:
        return error_response(handler, err["message"])
    json_response(handler, result)


# --- POST endpoints ---

@route("POST", r"/api/mine")
def mine_blocks(handler, match):
    body = _read_body(handler)
    if body is None:
        return error_response(handler, "Invalid JSON body", 400)
    nblocks = body.get("nblocks", 1)
    address = body.get("address", "")
    if not address:
        addr, err = rpc_call("getnewaddress")
        if err:
            return error_response(handler, err["message"])
        address = addr
    result, err = rpc_call("generatetoaddress", [int(nblocks), address])
    if err:
        return error_response(handler, err["message"])
    json_response(handler, {"blocks": result, "address": address})


@route("POST", r"/api/wallet/send")
def send_coins(handler, match):
    body = _read_body(handler)
    if body is None:
        return error_response(handler, "Invalid JSON body", 400)
    address = body.get("address", "")
    amount = body.get("amount", 0)
    if not address or not amount:
        return error_response(handler, "address and amount required", 400)
    result, err = rpc_call("sendtoaddress", [address, float(amount)])
    if err:
        return error_response(handler, err["message"])
    json_response(handler, {"txid": result})


def _read_body(handler):
    length = int(handler.headers.get("Content-Length", 0))
    if length == 0:
        return {}
    try:
        return json.loads(handler.rfile.read(length).decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


class DashboardHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _route(self, method):
        path = self.path.split("?")[0]
        for route_method, pattern, handler_func in ROUTES:
            if route_method != method:
                continue
            m = pattern.match(path)
            if m:
                try:
                    handler_func(self, m)
                except Exception as e:
                    error_response(self, str(e))
                return
        # Fallback: serve static files (for standalone mode without nginx)
        if method == "GET" and not path.startswith("/api/"):
            self._serve_static(path)
        else:
            error_response(self, "Not found", 404)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # Prevent directory traversal
        safe_path = os.path.normpath(path).lstrip("/")
        if ".." in safe_path:
            error_response(self, "Forbidden", 403)
            return
        full_path = os.path.join(STATIC_DIR, safe_path)
        if not os.path.isfile(full_path):
            error_response(self, "Not found", 404)
            return
        ext = os.path.splitext(full_path)[1]
        content_type = MIME_TYPES.get(ext, "application/octet-stream")
        try:
            with open(full_path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except IOError:
            error_response(self, "Read error", 500)

    def log_message(self, format, *args):
        sys.stderr.write(f"[API] {self.address_string()} - {format % args}\n")


def main():
    print(f"CronCoin Dashboard API starting on port {LISTEN_PORT}")
    print(f"RPC target: {RPC_HOST}:{RPC_PORT}")

    # Test RPC connection
    result, err = rpc_call("getblockchaininfo")
    if err:
        print(f"WARNING: RPC connection failed: {err['message']}")
        print("Server will start anyway - make sure croncoind is running.")
    else:
        print(f"Connected to {result.get('chain', '?')} chain at height {result.get('blocks', '?')}")

    server = http.server.HTTPServer(("0.0.0.0", LISTEN_PORT), DashboardHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
