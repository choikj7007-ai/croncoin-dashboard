/* CronCoin Dashboard - Utility Functions */

const COIN = 1000;
const HALVING_INTERVAL_REGTEST = 150;
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
 * Input: "CRN:R=4:P=0:T=2026-02-18 18:19:H=111"
 * Output: { R: 4, P: 0, T: "2026-02-18 18:19", H: 111 }
 */
function parseCoinbaseMetaFields(metaString) {
    if (!metaString) return null;
    const result = {};
    // Match R=<number>
    const rMatch = metaString.match(/R=(\d+)/);
    if (rMatch) result.R = parseInt(rMatch[1], 10);
    // Match P=<number> (0=even, 1=odd)
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
 * Extract structured metadata from a block's coinbase OP_RETURN.
 * Returns { R, P, T, H } or null.
 */
function getBlockMeta(block) {
    if (!block || !block.tx || block.tx.length === 0) return null;
    const coinbase = block.tx[0];
    if (!coinbase.vout) return null;
    for (const out of coinbase.vout) {
        const spk = out.scriptPubKey;
        if (spk && spk.type === 'nulldata' && spk.hex) {
            const raw = parseOpReturnMetadata(spk.hex);
            const fields = parseCoinbaseMetaFields(raw);
            if (fields) return fields;
        }
    }
    return null;
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
    const halvings = Math.floor(height / HALVING_INTERVAL_REGTEST);
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
        const nextHalving = (Math.floor(h / HALVING_INTERVAL_REGTEST) + 1) * HALVING_INTERVAL_REGTEST;
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
 * Derive a dice value (1-6) from a block hash.
 * Uses the last byte of the hash.
 */
function getDiceFromHash(hash) {
    if (!hash || hash.length < 2) return 1;
    const lastByte = parseInt(hash.slice(-2), 16);
    return (lastByte % 6) + 1;
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
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + (isError ? 'toast-error' : 'toast-success') + ' show';
    setTimeout(() => toast.className = 'toast', 3000);
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
