/* CronCoin Dashboard - Utility Functions */

const COIN = 1000;
const HALVING_INTERVAL = 175000;
const BASE_REWARD = 600000; // CRN

/**
 * Format satoshi-like amount to CRN with 3 decimal places.
 */
function formatCRN(amount) {
    if (amount === undefined || amount === null) return '—';
    return parseFloat(amount).toFixed(3) + ' CRN';
}

/**
 * Format a number amount (already in CRN) to 3 decimal places.
 */
function formatAmount(amount) {
    if (amount === undefined || amount === null) return '—';
    return parseFloat(amount).toFixed(3);
}

/**
 * Decode hex string to ASCII text.
 */
function hexToAscii(hex) {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        const code = parseInt(hex.substr(i, 2), 16);
        if (code >= 32 && code <= 126) {
            str += String.fromCharCode(code);
        } else {
            str += '.';
        }
    }
    return str;
}

/**
 * Parse OP_RETURN metadata from coinbase scriptPubKey hex.
 * Looks for CRN: prefix pattern.
 */
function parseOpReturnMetadata(scriptPubKeyHex) {
    if (!scriptPubKeyHex) return null;
    const ascii = hexToAscii(scriptPubKeyHex);
    const match = ascii.match(/CRN:[^\x00]*/);
    return match ? match[0] : null;
}

/**
 * Parse structured CRN metadata string into an object.
 * Input: "CRN:T=2026-02-18 18:19:H=111"
 * Output: { T: "2026-02-18 18:19", H: 111 }
 * Also supports legacy format with R= and P= fields.
 */
function parseCoinbaseMetaFields(metaString) {
    if (!metaString) return null;
    const result = {};
    // Match R=<number> (legacy, no longer stored in new blocks)
    const rMatch = metaString.match(/R=(\d+)/);
    if (rMatch) result.R = parseInt(rMatch[1], 10);
    // Match P=<number> (legacy, no longer stored in new blocks)
    const pMatch = metaString.match(/P=(\d+)/);
    if (pMatch) result.P = parseInt(pMatch[1], 10);
    // Match T=<time string> (everything until next :X= or end)
    const tMatch = metaString.match(/T=([^:]*(?::[^A-Z=][^:]*)*)/);
    if (tMatch) result.T = tMatch[1];
    // Match H=<number>
    const hMatch = metaString.match(/H=(\d+)/);
    if (hMatch) result.H = parseInt(hMatch[1], 10);
    return (Object.keys(result).length > 0) ? result : null;
}

/**
 * Extract structured metadata from a block.
 * Dice (R) and parity (P) are computed from the block hash (last 6 bytes).
 * Time (T) and height (H) come from OP_RETURN or block fields.
 * Returns { R, P, T, H } or null.
 */
function getBlockMeta(block) {
    if (!block) return null;

    // Compute dice from block hash (authoritative source)
    const hash = block.hash;
    const dice = hash ? getDiceFromHash(hash) : null;

    // Parse OP_RETURN for T and H fields
    let fields = null;
    if (block.tx && block.tx.length > 0) {
        const coinbase = block.tx[0];
        if (coinbase.vout) {
            for (const out of coinbase.vout) {
                const spk = out.scriptPubKey;
                if (spk && spk.type === 'nulldata' && spk.hex) {
                    const raw = parseOpReturnMetadata(spk.hex);
                    fields = parseCoinbaseMetaFields(raw);
                    if (fields) break;
                }
            }
        }
    }

    const result = fields || {};
    // Always override R and P with hash-based calculation
    if (dice !== null) {
        result.R = dice;
        result.P = dice % 2;
    }
    // Fill H from block.height if not already set
    if (result.H === undefined && block.height !== undefined) {
        result.H = block.height;
    }
    return (Object.keys(result).length > 0) ? result : null;
}

/**
 * Format Unix timestamp to locale string.
 */
function formatTime(timestamp) {
    if (!timestamp) return '—';
    return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Format time ago string.
 */
function timeAgo(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Truncate a hash for display.
 */
function truncHash(hash, len) {
    len = len || 16;
    if (!hash || hash.length <= len * 2) return hash || '';
    return hash.substring(0, len) + '...' + hash.substring(hash.length - len);
}

/**
 * Format bytes to human-readable size.
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/**
 * Calculate current block reward for regtest.
 */
function getBlockReward(height) {
    const halvings = Math.floor(height / HALVING_INTERVAL);
    if (halvings >= 64) return 0;
    return BASE_REWARD / Math.pow(2, halvings);
}

/**
 * Calculate total supply issued up to given height (regtest).
 */
function getTotalSupply(height) {
    let total = 0;
    let h = 0;
    let reward = BASE_REWARD;
    while (h < height && reward > 0) {
        const nextHalving = (Math.floor(h / HALVING_INTERVAL) + 1) * HALVING_INTERVAL;
        const blocksAtReward = Math.min(nextHalving, height) - h;
        total += blocksAtReward * reward;
        h += blocksAtReward;
        reward /= 2;
    }
    return total;
}

/**
 * Format large number with comma separators.
 */
function formatNumber(n) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

/**
 * Wrap decimal point and fractional digits in a dim span.
 */
function dimDecimal(str) {
    const idx = str.indexOf('.');
    if (idx === -1) return escapeHtml(str);
    return escapeHtml(str.substring(0, idx)) + '<span class="dec">' + escapeHtml(str.substring(idx)) + '</span>';
}

/**
 * Convert number to Korean readable string (억, 만 units).
 * e.g. 1240208322.232 → "12억 4020만 8322.232"
 * Returns empty string if value is 0.
 */
function toKoreanNumber(n) {
    n = Number(n);
    if (n === 0) return '';
    const neg = n < 0;
    if (neg) n = -n;
    const intPart = Math.floor(n);
    const decStr = n % 1 === 0 ? '' : ('.' + n.toFixed(8).split('.')[1].replace(/0+$/, ''));
    const parts = [];
    const eok = Math.floor(intPart / 100000000);
    const man = Math.floor((intPart % 100000000) / 10000);
    const rest = intPart % 10000;
    if (eok > 0) parts.push(eok.toLocaleString('en-US') + '억');
    if (man > 0) parts.push(man.toLocaleString('en-US') + '만');
    if (rest > 0 || parts.length === 0) parts.push(String(rest));
    return (neg ? '-' : '') + parts.join(' ') + decStr;
}

/**
 * Derive a dice value (1-6) from a block hash.
 * Uses the last 6 bytes (12 hex chars) for near-perfect uniform distribution.
 * This is the authoritative dice calculation — no longer stored in OP_RETURN.
 */
function getDiceFromHash(hash) {
    if (!hash || hash.length < 12) return 1;
    // Last 6 bytes of the hash (last 12 hex characters)
    const last6hex = hash.slice(-12);
    let val = 0n;
    for (let i = 0; i < 12; i += 2) {
        val = (val << 8n) | BigInt(parseInt(last6hex.substr(i, 2), 16));
    }
    return Number(val % 6n) + 1;
}

/**
 * Render dice face dots HTML.
 */
function renderDiceDots(value) {
    let dots = '';
    for (let i = 0; i < value; i++) {
        dots += '<div class="dot"></div>';
    }
    return dots;
}

/**
 * Make API GET request.
 */
async function apiGet(path) {
    const resp = await fetch('/api/' + path);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data;
}

/**
 * Make API POST request.
 */
async function apiPost(path, body) {
    const resp = await fetch('/api/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data;
}

/**
 * Create a clickable hash element.
 */
function hashLink(hash, onclick) {
    const el = document.createElement('span');
    el.className = 'hash-link';
    el.textContent = hash;
    el.title = hash;
    if (onclick) el.addEventListener('click', onclick);
    return el;
}

/**
 * Show a brief notification toast.
 */
function showToast(message, isError) {
    const overlay = document.getElementById('toast-overlay');
    const msgEl = document.getElementById('toast-message');
    const btn = document.getElementById('toast-confirm');
    if (!overlay || !msgEl) return;
    msgEl.textContent = message;
    msgEl.className = 'toast-message ' + (isError ? 'toast-error' : 'toast-success');
    overlay.classList.add('show');
    function dismiss() {
        overlay.classList.remove('show');
        btn.removeEventListener('click', dismiss);
    }
    btn.addEventListener('click', dismiss);
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Play real crowd applause sound.
 * Uses a pre-loaded audio file for natural sound.
 */
let _applauseAudio = null;
function playApplause() {
    if (!_applauseAudio) {
        _applauseAudio = new Audio('sounds/baksu.wav');
    }
    _applauseAudio.currentTime = 0;
    _applauseAudio.volume = 1.0;
    _applauseAudio.play().catch(() => {});
}
