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

from bip39_english import WORDS as BIP39_WORDS


# ---- secp256k1 / BIP32 / BIP39 / bech32 ----

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


# ---- BIP39 mnemonic generation ----

def _generate_entropy(bits=128):
    """Generate random entropy bytes (128 bits = 12 words, 256 bits = 24 words)."""
    return os.urandom(bits // 8)


def _entropy_to_mnemonic(entropy_bytes):
    """Convert entropy bytes to BIP39 mnemonic words."""
    h = hashlib.sha256(entropy_bytes).digest()
    # Checksum: first (entropy_bits / 32) bits of SHA256
    ent_bits = len(entropy_bytes) * 8
    cs_bits = ent_bits // 32
    # Build bit string: entropy + checksum
    bits = bin(int.from_bytes(entropy_bytes, "big"))[2:].zfill(ent_bits)
    cs = bin(h[0])[2:].zfill(8)[:cs_bits]
    all_bits = bits + cs
    # Split into 11-bit groups → word indices
    words = []
    for i in range(0, len(all_bits), 11):
        idx = int(all_bits[i:i + 11], 2)
        words.append(BIP39_WORDS[idx])
    return " ".join(words)


def _mnemonic_to_seed(mnemonic, passphrase=""):
    """Derive 512-bit seed from mnemonic using PBKDF2-HMAC-SHA512."""
    password = mnemonic.encode("utf-8")
    salt = ("mnemonic" + passphrase).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha512", password, salt, 2048)


def _seed_to_master_key(seed_bytes):
    """Derive master private key and chain code from BIP39 seed."""
    I = hmac.new(b"Bitcoin seed", seed_bytes, hashlib.sha512).digest()
    return I[:32], I[32:]  # (master_key, chain_code)


def _encode_tprv(key, chain_code, depth=0, fingerprint=b"\x00\x00\x00\x00", child_num=0):
    """Encode extended private key as tprv (testnet/regtest) base58check string."""
    # tprv version: 0x04358394
    version = b"\x04\x35\x83\x94"
    payload = (
        version
        + bytes([depth])
        + fingerprint
        + child_num.to_bytes(4, "big")
        + chain_code
        + b"\x00" + key
    )
    return _b58encode_check(payload)


def _encode_tpub(pubkey_bytes, chain_code, depth=0, fingerprint=b"\x00\x00\x00\x00", child_num=0):
    """Encode extended public key as tpub (testnet/regtest) base58check string."""
    # tpub version: 0x043587CF
    version = b"\x04\x35\x87\xCF"
    payload = (
        version
        + bytes([depth])
        + fingerprint
        + child_num.to_bytes(4, "big")
        + chain_code
        + pubkey_bytes  # 33 bytes compressed pubkey
    )
    return _b58encode_check(payload)


# ---- RIPEMD-160 (pure Python fallback if hashlib doesn't have it) ----

def _ripemd160(data):
    """Compute RIPEMD-160 hash."""
    try:
        h = hashlib.new("ripemd160")
        h.update(data)
        return h.digest()
    except ValueError:
        # OpenSSL 3.0+ may not support ripemd160; use fallback
        return _ripemd160_fallback(data)


def _ripemd160_fallback(message):
    """Pure Python RIPEMD-160 implementation."""
    # Constants
    def f(j, x, y, z):
        if j < 16: return x ^ y ^ z
        if j < 32: return (x & y) | (~x & z)
        if j < 48: return (x | ~y) ^ z
        if j < 64: return (x & z) | (y & ~z)
        return x ^ (y | ~z)

    K_LEFT =  [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
    K_RIGHT = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]

    RL = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
          7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
          3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,
          1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,
          4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]
    RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,
          6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
          15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,
          8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,
          12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]
    SL = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,
          7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
          11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,
          11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,
          9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]
    SR = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,
          9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
          9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,
          15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,
          8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]

    MASK = 0xFFFFFFFF

    def rol(x, n):
        return ((x << n) | (x >> (32 - n))) & MASK

    # Padding
    msg = bytearray(message)
    l = len(msg) * 8
    msg.append(0x80)
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += l.to_bytes(8, "little")

    h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0

    for i in range(0, len(msg), 64):
        X = [int.from_bytes(msg[i + j * 4:i + j * 4 + 4], "little") for j in range(16)]
        al, bl, cl, dl, el = h0, h1, h2, h3, h4
        ar, br, cr, dr, er = h0, h1, h2, h3, h4

        for j in range(80):
            rnd = j // 16
            # Left
            T = (al + f(j, bl, cl, dl) + X[RL[j]] + K_LEFT[rnd]) & MASK
            T = (rol(T, SL[j]) + el) & MASK
            al = el; el = dl; dl = rol(cl, 10); cl = bl; bl = T
            # Right
            T = (ar + f(79 - j, br, cr, dr) + X[RR[j]] + K_RIGHT[rnd]) & MASK
            T = (rol(T, SR[j]) + er) & MASK
            ar = er; er = dr; dr = rol(cr, 10); cr = br; br = T

        T = (h1 + cl + dr) & MASK
        h1 = (h2 + dl + er) & MASK
        h2 = (h3 + el + ar) & MASK
        h3 = (h4 + al + br) & MASK
        h4 = (h0 + bl + cr) & MASK
        h0 = T

    return b"".join(v.to_bytes(4, "little") for v in [h0, h1, h2, h3, h4])


def _hash160(data):
    """HASH160 = RIPEMD160(SHA256(data))."""
    return _ripemd160(hashlib.sha256(data).digest())


# ---- Bech32 encoding (BIP173) ----

_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk


def _bech32_hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _bech32_create_checksum(hrp, data):
    values = _bech32_hrp_expand(hrp) + data
    polymod = _bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]


def _bech32_encode(hrp, data):
    combined = data + _bech32_create_checksum(hrp, data)
    return hrp + "1" + "".join(_BECH32_CHARSET[d] for d in combined)


def _convertbits(data, frombits, tobits, pad=True):
    """General power-of-2 base conversion."""
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret


def _pubkey_to_bech32_address(pubkey_bytes, hrp="crnrt"):
    """Convert compressed pubkey to bech32 P2WPKH address."""
    witness_program = _hash160(pubkey_bytes)
    # witness version 0 + convertbits(20 bytes, 8→5)
    data5 = _convertbits(witness_program, 8, 5)
    return _bech32_encode(hrp, [0] + data5)


def _derive_child_with_fingerprint(parent_key, parent_chain_code, index):
    """Derive child key and compute parent fingerprint."""
    parent_pub = _privkey_to_compressed_pubkey(parent_key)
    fingerprint = _hash160(parent_pub)[:4]
    child_key, child_chain = _bip32_derive_child(parent_key, parent_chain_code, index)
    return child_key, child_chain, fingerprint


def _full_hd_generate(entropy_bits=128, passphrase="", derivation_path="m/84h/1h/0h/0/0"):
    """Generate the full HD wallet chain with xprv/xpub at every derivation level."""
    # Step 1: Entropy
    entropy = _generate_entropy(entropy_bits)

    # Step 2: Mnemonic
    mnemonic = _entropy_to_mnemonic(entropy)

    # Step 3: Seed (from mnemonic via PBKDF2)
    seed = _mnemonic_to_seed(mnemonic, passphrase)

    # Step 4: Master key (xprv + xpub)
    master_key, master_chain = _seed_to_master_key(seed)
    master_pub = _privkey_to_compressed_pubkey(master_key)
    master_tprv = _encode_tprv(master_key, master_chain)
    master_tpub = _encode_tpub(master_pub, master_chain)

    # Step 5: HD derivation – record each level
    indices = _parse_hdkeypath(derivation_path)
    path_parts = derivation_path.strip().split("/")  # ['m', '84h', '1h', '0h', '0', '0']

    derivation_chain = []
    # Level 0: master
    derivation_chain.append({
        "path": "m",
        "xprv": master_tprv,
        "xpub": master_tpub,
    })

    key, chain = master_key, master_chain
    fingerprint = b"\x00\x00\x00\x00"
    for i, idx in enumerate(indices):
        parent_pub = _privkey_to_compressed_pubkey(key)
        fingerprint = _hash160(parent_pub)[:4]
        key, chain = _bip32_derive_child(key, chain, idx)
        depth = i + 1
        pub = _privkey_to_compressed_pubkey(key)
        level_path = "/".join(path_parts[:depth + 1])
        derivation_chain.append({
            "path": level_path,
            "xprv": _encode_tprv(key, chain, depth, fingerprint, idx),
            "xpub": _encode_tpub(pub, chain, depth, fingerprint, idx),
        })

    # Step 6: Private key (WIF)
    privkey_wif = _privkey_to_wif(key, testnet=True)

    # Step 7: Public key (compressed)
    pubkey = _privkey_to_compressed_pubkey(key)

    # Step 8: Address (bech32 P2WPKH)
    address = _pubkey_to_bech32_address(pubkey, hrp="crnrt")

    return {
        "entropy_hex": entropy.hex(),
        "entropy_bits": entropy_bits,
        "mnemonic": mnemonic,
        "seed_hex": seed.hex(),
        "master_xprv": master_tprv,
        "master_xpub": master_tpub,
        "derivation_path": derivation_path,
        "derivation_chain": derivation_chain,
        "private_key_wif": privkey_wif,
        "public_key_hex": pubkey.hex(),
        "address": address,
    }

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


@route("POST", r"/api/wallet/generate")
def generate_hd_wallet(handler, match):
    """Generate full HD wallet chain: entropy → mnemonic → seed → master → derive → keys → address."""
    body = _read_body(handler)
    passphrase = body.get("passphrase", "") if body else ""
    path = body.get("path", "m/84h/1h/0h/0/0") if body else "m/84h/1h/0h/0/0"
    bits = body.get("entropy_bits", 128) if body else 128
    if bits not in (128, 160, 192, 224, 256):
        return error_response(handler, "entropy_bits must be 128/160/192/224/256", 400)
    try:
        result = _full_hd_generate(entropy_bits=bits, passphrase=passphrase, derivation_path=path)
        json_response(handler, result)
    except Exception as e:
        error_response(handler, str(e))


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
