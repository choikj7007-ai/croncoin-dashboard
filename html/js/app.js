/* CronCoin Dashboard - Main Application Logic */

(function () {
    'use strict';

    // --- Language Switcher ---
    document.getElementById('lang-btn').addEventListener('click', () => {
        const newLang = getLang() === 'en' ? 'ko' : 'en';
        setLang(newLang);
        // Re-render active tab data with new language
        const activeTab = document.querySelector('.tab.active');
        if (activeTab) onTabActivated(activeTab.dataset.tab);
        updateStatusBar();
    });

    // --- Tab Navigation ---
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    function switchTab(target) {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));
        const tabBtn = document.querySelector('[data-tab="' + target + '"]');
        if (tabBtn) tabBtn.classList.add('active');
        const tabPanel = document.getElementById('tab-' + target);
        if (tabPanel) tabPanel.classList.add('active');
        location.hash = target;
        onTabActivated(target);
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    function onTabActivated(tabName) {
        if (tabName !== 'dice') stopDicePolling();
        switch (tabName) {
            case 'blocks': loadRecentBlocks(); break;
            case 'transactions': loadRecentTxList(); break;
            case 'wallet': loadWalletGuide(); break;
            case 'mining': loadMiningInfo(); break;
            case 'richlist': loadRichList(); break;
            case 'network': loadNetworkTab(); break;
            case 'dice': loadDice(); break;
            case 'guide': loadGuide(); break;
        }
    }

    // --- Helper: render info grid ---
    function renderInfoGrid(containerId, items) {
        const el = document.getElementById(containerId);
        el.innerHTML = items.map(item =>
            `<div class="info-item">
                <span class="info-label">${escapeHtml(item.label)}</span>
                <span class="info-value ${item.cls || ''}">${item.value}</span>
            </div>`
        ).join('');
    }

    // ========================================================
    // 1. BLOCK EXPLORER
    // ========================================================

    document.getElementById('block-search-btn').addEventListener('click', searchBlock);
    document.getElementById('block-search').addEventListener('keydown', e => {
        if (e.key === 'Enter') searchBlock();
    });

    async function searchBlock() {
        const q = document.getElementById('block-search').value.trim();
        if (!q) return;
        try {
            let data;
            if (/^\d+$/.test(q)) {
                data = await apiGet('blockheight/' + q);
            } else {
                data = await apiGet('block/' + q);
            }
            showBlockDetail(data);
        } catch (err) {
            showToast(t('block.notFound') + ': ' + err.message, true);
        }
    }

    function showBlockDetail(block) {
        const el = document.getElementById('block-detail');
        el.style.display = 'block';

        renderInfoGrid('block-detail-info', [
            { label: t('block.height'), value: block.height, cls: 'large' },
            { label: t('block.hash'), value: block.hash, cls: 'mono' },
            { label: t('block.prevHash'), value: block.previousblockhash || t('block.genesis'), cls: 'mono' },
            { label: t('block.time'), value: formatTime(block.time) },
            { label: t('block.difficulty'), value: block.difficulty },
            { label: t('block.size'), value: formatBytes(block.size) },
            { label: t('block.weight'), value: block.weight },
            { label: t('block.transactions'), value: block.nTx || (block.tx ? block.tx.length : 0) },
            { label: t('block.version'), value: '0x' + block.version.toString(16) },
            { label: t('block.merkleRoot'), value: block.merkleroot, cls: 'mono' },
            { label: t('block.nonce'), value: block.nonce },
            { label: t('block.bits'), value: block.bits },
        ]);

        // Check for OP_RETURN metadata in coinbase
        const metaEl = document.getElementById('block-metadata');
        metaEl.innerHTML = '';
        if (block.tx && block.tx.length > 0) {
            const coinbase = block.tx[0];
            if (coinbase.vout) {
                for (const out of coinbase.vout) {
                    const spk = out.scriptPubKey;
                    if (spk && spk.type === 'nulldata' && spk.hex) {
                        const meta = parseOpReturnMetadata(spk.hex);
                        if (meta) {
                            metaEl.innerHTML = `<div class="metadata-box">${escapeHtml(t('block.coinbaseMeta'))}: ${escapeHtml(meta)}</div>`;
                        }
                    }
                }
            }
        }

        // Transaction list
        const tbody = document.getElementById('block-tx-list');
        tbody.innerHTML = '';
        if (block.tx) {
            block.tx.forEach(tx => {
                const tr = document.createElement('tr');
                const txid = typeof tx === 'string' ? tx : tx.txid;
                const size = typeof tx === 'object' ? tx.size : '—';
                const vin = typeof tx === 'object' ? tx.vin.length : '—';
                const vout = typeof tx === 'object' ? tx.vout.length : '—';
                tr.innerHTML = `
                    <td class="mono"><span class="hash-link" data-txid="${escapeHtml(txid)}">${escapeHtml(txid)}</span></td>
                    <td>${size}</td>
                    <td>${vin}</td>
                    <td>${vout}</td>`;
                tr.querySelector('.hash-link').addEventListener('click', () => viewTransaction(txid));
                tbody.appendChild(tr);
            });
        }

        el.scrollIntoView({ behavior: 'smooth' });
    }

    async function loadRecentBlocks() {
        try {
            const info = await apiGet('blockchain');
            const container = document.getElementById('recent-blocks');
            container.innerHTML = '';

            const count = Math.min(10, info.blocks + 1);
            const startHeight = info.blocks;

            for (let i = 0; i < count; i++) {
                const height = startHeight - i;
                if (height < 0) break;
                try {
                    const block = await apiGet('blockheight/' + height);
                    const txCount = block.nTx || (block.tx ? block.tx.length : 0);
                    const meta = getBlockMeta(block);
                    const metaTag = meta ? `<span class="block-meta-tag">${escapeHtml('CRN:R=' + meta.R + ':P=' + meta.P + ':H=' + meta.H)}</span>` : '';

                    const item = document.createElement('div');
                    item.className = 'block-item';
                    item.innerHTML = `
                        <div class="block-height">#${block.height}</div>
                        <div class="block-meta">
                            <div class="block-hash">${truncHash(block.hash, 20)}</div>
                            <div class="block-info">${txCount} txs &middot; ${formatBytes(block.size)} &middot; ${formatTime(block.time)} (${timeAgo(block.time)})</div>
                            ${metaTag}
                        </div>`;
                    item.addEventListener('click', () => {
                        document.getElementById('block-search').value = String(block.height);
                        showBlockDetail(block);
                    });
                    container.appendChild(item);
                } catch (e) {
                    // skip blocks that fail
                }
            }

            if (container.children.length === 0) {
                container.innerHTML = `<div class="loading">${escapeHtml(t('block.noBlocks'))}</div>`;
            }
        } catch (err) {
            document.getElementById('recent-blocks').innerHTML =
                `<div class="loading">${escapeHtml(t('error'))}: ${escapeHtml(err.message)}</div>`;
        }
    }

    // ========================================================
    // 2. TRANSACTION EXPLORER
    // ========================================================

    document.getElementById('tx-search-btn').addEventListener('click', searchTx);
    document.getElementById('tx-search').addEventListener('keydown', e => {
        if (e.key === 'Enter') searchTx();
    });

    async function searchTx() {
        const txid = document.getElementById('tx-search').value.trim();
        if (!txid) return;
        await viewTransaction(txid);
    }

    async function viewTransaction(txid) {
        // Switch to transactions tab
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));
        document.querySelector('[data-tab="transactions"]').classList.add('active');
        document.getElementById('tab-transactions').classList.add('active');

        document.getElementById('tx-search').value = txid;

        try {
            const tx = await apiGet('tx/' + txid);
            showTxDetail(tx);
        } catch (err) {
            showToast(t('tx.notFound') + ': ' + err.message, true);
        }
    }

    function showTxDetail(tx) {
        const el = document.getElementById('tx-detail');
        el.style.display = 'block';

        const isCoinbase = tx.vin && tx.vin.length > 0 && tx.vin[0].coinbase;

        renderInfoGrid('tx-detail-info', [
            { label: t('tx.txid'), value: tx.txid, cls: 'mono' },
            { label: t('tx.size'), value: tx.size + ' bytes' },
            { label: t('tx.vsize'), value: (tx.vsize || tx.size) + ' vB' },
            { label: t('tx.weight'), value: tx.weight },
            { label: t('tx.version'), value: tx.version },
            { label: t('tx.locktime'), value: tx.locktime },
            { label: t('tx.confirmations'), value: tx.confirmations || t('tx.unconfirmed') },
            { label: t('tx.blockHash'), value: tx.blockhash || '—', cls: 'mono' },
            { label: t('tx.type'), value: isCoinbase ? t('tx.coinbase') : t('tx.regular') },
        ]);

        // OP_RETURN metadata
        const metaEl = document.getElementById('tx-metadata');
        metaEl.innerHTML = '';
        if (isCoinbase && tx.vout) {
            for (const out of tx.vout) {
                const spk = out.scriptPubKey;
                if (spk && spk.type === 'nulldata' && spk.hex) {
                    const meta = parseOpReturnMetadata(spk.hex);
                    if (meta) {
                        metaEl.innerHTML = `<div class="metadata-box">${escapeHtml(t('tx.opReturnMeta'))}: ${escapeHtml(meta)}</div>`;
                    }
                }
            }
        }

        // Inputs
        const inputsEl = document.getElementById('tx-inputs');
        inputsEl.innerHTML = '';
        if (tx.vin) {
            tx.vin.forEach(vin => {
                const tr = document.createElement('tr');
                if (vin.coinbase) {
                    tr.innerHTML = `<td class="mono" colspan="3">${escapeHtml(t('tx.coinbase'))}: ${escapeHtml(vin.coinbase)}</td>`;
                } else {
                    const script = vin.scriptSig ? vin.scriptSig.asm : '';
                    const witness = vin.txinwitness ? vin.txinwitness.join(' ') : '';
                    const display = script || (witness ? 'Witness: ' + truncHash(witness, 20) : '—');
                    tr.innerHTML = `
                        <td class="mono"><span class="hash-link" data-txid="${escapeHtml(vin.txid)}">${escapeHtml(truncHash(vin.txid, 12))}</span></td>
                        <td>${vin.vout}</td>
                        <td class="mono" style="max-width:400px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(display)}</td>`;
                    tr.querySelector('.hash-link').addEventListener('click', () => viewTransaction(vin.txid));
                }
                inputsEl.appendChild(tr);
            });
        }

        // Outputs
        const outputsEl = document.getElementById('tx-outputs');
        outputsEl.innerHTML = '';
        if (tx.vout) {
            tx.vout.forEach(vout => {
                const tr = document.createElement('tr');
                const addr = vout.scriptPubKey.address || vout.scriptPubKey.type || '—';
                tr.innerHTML = `
                    <td>${vout.n}</td>
                    <td class="mono">${formatAmount(vout.value)}</td>
                    <td class="mono">${escapeHtml(addr)}</td>`;
                outputsEl.appendChild(tr);
            });
        }

        el.scrollIntoView({ behavior: 'smooth' });
    }

    // ========================================================
    // 3. WALLET (HD Key Generation Flow)
    // ========================================================

    const _hdStepIds = ['hd-step-mnemonic', 'hd-step-master', 'hd-step-privkey', 'hd-step-pubkey', 'hd-step-address'];
    let _lastGeneratedWallet = null;

    function loadWalletGuide() {
        document.getElementById('wallet-guide-notice').innerHTML = t('hd.guideNotice');
        document.getElementById('hd-flow-container').style.display = 'none';
        document.getElementById('hd-backup-warning').style.display = 'none';
        document.getElementById('hd-action-bar').style.display = 'none';
        document.getElementById('wallet-generate-actions').style.display = '';
        _lastGeneratedWallet = null;
        // Clear previous values
        _hdStepIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const qrEl = document.getElementById('hd-address-qr');
        if (qrEl) qrEl.innerHTML = '';
        // Hide recovery input cards
        document.getElementById('hd-mnemonic-input-card').style.display = 'none';
        document.getElementById('hd-xpub-input-card').style.display = 'none';
        document.getElementById('hd-mnemonic-input').value = '';
        document.getElementById('hd-xpub-input').value = '';
        // Hide balance input cards and results
        document.getElementById('hd-xpub-balance-card').style.display = 'none';
        document.getElementById('hd-address-balance-card').style.display = 'none';
        document.getElementById('hd-xpub-balance-result').style.display = 'none';
        document.getElementById('hd-address-balance-result').style.display = 'none';
        document.getElementById('hd-xpub-balance-input').value = '';
        document.getElementById('hd-address-balance-input').value = '';
    }

    function renderKeyPair(xprv, xpub) {
        return `<div class="keypair-box">
            <div class="keypair-row"><span class="keypair-label">xprv</span><span class="keypair-value mono-text privkey-text">${escapeHtml(xprv)}</span></div>
            <div class="keypair-row"><span class="keypair-label">xpub</span><span class="keypair-value mono-text">${escapeHtml(xpub)}</span></div>
        </div>`;
    }

    function renderDerivationChain(chain) {
        // chain[0] = master (m), skip it (shown in step 3)
        // chain[1..N] = each derivation level
        let html = `<div class="derivation-chain">`;
        for (let i = 1; i < chain.length; i++) {
            const level = chain[i];
            const isLast = (i === chain.length - 1);
            const connector = i < chain.length - 1 ? 'has-next' : '';
            html += `<div class="derive-level ${connector}">
                <div class="derive-path-label"><span class="derive-connector">${isLast ? '└' : '├'}</span> <strong>${escapeHtml(level.path)}</strong></div>
                <div class="derive-keys">
                    <div class="keypair-row"><span class="keypair-label">xprv</span><span class="keypair-value mono-text privkey-text">${escapeHtml(level.xprv)}</span></div>
                    <div class="keypair-row"><span class="keypair-label">xpub</span><span class="keypair-value mono-text">${escapeHtml(level.xpub)}</span></div>
                </div>
            </div>`;
        }
        html += `</div>`;
        html += `<div class="derive-note">${t('hd.deriveNote')}</div>`;
        return html;
    }

    document.getElementById('hd-generate-btn').addEventListener('click', async () => {
        const btn = document.getElementById('hd-generate-btn');
        btn.disabled = true;
        btn.textContent = t('hd.generating');

        try {
            const data = await apiPost('wallet/generate', {});

            // Show the flow container
            document.getElementById('hd-flow-container').style.display = 'block';

            // Progressively reveal each step with delay
            const steps = [
                { el: 'hd-step-mnemonic', content: () => {
                    const words = data.mnemonic.split(' ');
                    let html = '<div class="mnemonic-grid">';
                    words.forEach((w, i) => {
                        html += `<div class="mnemonic-word"><span class="word-num">${i + 1}</span><span class="word-text">${escapeHtml(w)}</span></div>`;
                    });
                    html += '</div>';
                    document.getElementById('hd-mnemonic').innerHTML = html;
                }},
                { el: 'hd-step-master', content: () => {
                    document.getElementById('hd-master-keys').innerHTML = renderKeyPair(data.master_xprv, data.master_xpub);
                }},
                { el: 'hd-step-privkey', content: () => {
                    document.getElementById('hd-privkey').textContent = data.private_key_wif;
                }},
                { el: 'hd-step-pubkey', content: () => {
                    document.getElementById('hd-pubkey').textContent = data.public_key_hex;
                }},
                { el: 'hd-step-address', content: () => {
                    document.getElementById('hd-address').textContent = data.address;
                    // Render QR code
                    const qrEl = document.getElementById('hd-address-qr');
                    qrEl.innerHTML = '';
                    new QRCode(qrEl, {
                        text: data.address,
                        width: 128,
                        height: 128,
                        colorDark: '#000000',
                        colorLight: '#ffffff',
                        correctLevel: QRCode.CorrectLevel.M,
                    });
                }},
            ];

            for (let i = 0; i < steps.length; i++) {
                await new Promise(resolve => setTimeout(resolve, i === 0 ? 100 : 300));
                const step = steps[i];
                const stepEl = document.getElementById(step.el);
                step.content();
                stepEl.style.display = '';
                stepEl.style.animationDelay = '0s';
            }

            // Store wallet data for copy/save
            _lastGeneratedWallet = data;

            // Show action buttons
            await new Promise(resolve => setTimeout(resolve, 300));
            document.getElementById('hd-action-bar').style.display = '';

            // Show backup warning after all steps
            await new Promise(resolve => setTimeout(resolve, 100));
            document.getElementById('hd-backup-notice').innerHTML = t('hd.backupWarning');
            document.getElementById('hd-backup-warning').style.display = '';
            showToast(t('hd.generated'));

        } catch (err) {
            showToast(t('error') + ': ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = t('hd.generateBtn');
        }
    });

    function buildWalletText() {
        const d = _lastGeneratedWallet;
        if (!d) return '';
        const sep = '────────────────────────────────────────';
        const lines = [
            t('hd.walletInfoTitle'),
            sep,
            '',
            '[1] ' + t('hd.step2'),
            d.mnemonic,
            '',
            '[2] ' + t('hd.step3'),
            'xprv: ' + d.master_xprv,
            'xpub: ' + d.master_xpub,
            '',
            '[3] ' + t('hd.step5'),
            d.private_key_wif,
            '',
            '[4] ' + t('hd.step6'),
            d.public_key_hex,
            '',
            '[5] ' + t('hd.step7'),
            d.address,
            '',
            sep,
            t('hd.fileDisclaimer'),
        ];
        return lines.join('\n');
    }

    document.getElementById('hd-copy-btn').addEventListener('click', () => {
        const text = buildWalletText();
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            showToast(t('hd.copied'));
        }).catch(() => {
            // Fallback for older browsers
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast(t('hd.copied'));
        });
    });

    document.getElementById('hd-save-btn').addEventListener('click', () => {
        const text = buildWalletText();
        if (!text) return;
        const filename = getLang() === 'ko' ? '크론코인 지갑정보.txt' : 'CronCoin Wallet Info.txt';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(t('hd.saved'));
    });

    // ========================================================
    // 3-1. RECOVER FROM MNEMONIC / XPUB
    // ========================================================

    // Toggle input cards
    document.getElementById('hd-recover-mnemonic-btn').addEventListener('click', () => {
        const card = document.getElementById('hd-mnemonic-input-card');
        const wasHidden = card.style.display === 'none';
        hideAllInputCards();
        hideGeneratedResults();
        card.style.display = wasHidden ? '' : 'none';
    });

    document.getElementById('hd-recover-xpub-btn').addEventListener('click', () => {
        const card = document.getElementById('hd-xpub-input-card');
        const wasHidden = card.style.display === 'none';
        hideAllInputCards();
        hideGeneratedResults();
        card.style.display = wasHidden ? '' : 'none';
    });

    document.getElementById('hd-mnemonic-input-close').addEventListener('click', () => {
        document.getElementById('hd-mnemonic-input-card').style.display = 'none';
    });

    document.getElementById('hd-xpub-input-close').addEventListener('click', () => {
        document.getElementById('hd-xpub-input-card').style.display = 'none';
    });

    // Recover from mnemonic
    document.getElementById('hd-mnemonic-recover-btn').addEventListener('click', async () => {
        const mnemonic = document.getElementById('hd-mnemonic-input').value.trim();
        if (!mnemonic) {
            showToast(t('hd.invalidMnemonic'), true);
            return;
        }

        const btn = document.getElementById('hd-mnemonic-recover-btn');
        btn.disabled = true;
        btn.textContent = t('hd.recovering');

        try {
            const data = await apiPost('wallet/recover-mnemonic', { mnemonic });

            // Hide input cards
            document.getElementById('hd-mnemonic-input-card').style.display = 'none';

            // Show the flow container — same as generate, all 5 steps
            document.getElementById('hd-flow-container').style.display = 'block';

            const steps = [
                { el: 'hd-step-mnemonic', content: () => {
                    const words = data.mnemonic.split(' ');
                    let html = '<div class="mnemonic-grid">';
                    words.forEach((w, i) => {
                        html += `<div class="mnemonic-word"><span class="word-num">${i + 1}</span><span class="word-text">${escapeHtml(w)}</span></div>`;
                    });
                    html += '</div>';
                    document.getElementById('hd-mnemonic').innerHTML = html;
                }},
                { el: 'hd-step-master', content: () => {
                    document.getElementById('hd-master-keys').innerHTML = renderKeyPair(data.master_xprv, data.master_xpub);
                }},
                { el: 'hd-step-privkey', content: () => {
                    document.getElementById('hd-privkey').textContent = data.private_key_wif;
                }},
                { el: 'hd-step-pubkey', content: () => {
                    document.getElementById('hd-pubkey').textContent = data.public_key_hex;
                }},
                { el: 'hd-step-address', content: () => {
                    document.getElementById('hd-address').textContent = data.address;
                    const qrEl = document.getElementById('hd-address-qr');
                    qrEl.innerHTML = '';
                    new QRCode(qrEl, {
                        text: data.address,
                        width: 128, height: 128,
                        colorDark: '#000000', colorLight: '#ffffff',
                        correctLevel: QRCode.CorrectLevel.M,
                    });
                }},
            ];

            for (let i = 0; i < steps.length; i++) {
                await new Promise(resolve => setTimeout(resolve, i === 0 ? 100 : 300));
                const step = steps[i];
                const stepEl = document.getElementById(step.el);
                step.content();
                stepEl.style.display = '';
                stepEl.style.animationDelay = '0s';
            }

            _lastGeneratedWallet = data;

            await new Promise(resolve => setTimeout(resolve, 300));
            document.getElementById('hd-action-bar').style.display = '';

            await new Promise(resolve => setTimeout(resolve, 100));
            document.getElementById('hd-backup-notice').innerHTML = t('hd.backupWarning');
            document.getElementById('hd-backup-warning').style.display = '';
            showToast(t('hd.recovered'));

        } catch (err) {
            showToast(t('hd.invalidMnemonic') + ': ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = t('hd.recoverBtn');
        }
    });

    // Recover from xpub (watch-only)
    document.getElementById('hd-xpub-recover-btn').addEventListener('click', async () => {
        const xpub = document.getElementById('hd-xpub-input').value.trim();
        if (!xpub) {
            showToast(t('hd.invalidXpub'), true);
            return;
        }

        const btn = document.getElementById('hd-xpub-recover-btn');
        btn.disabled = true;
        btn.textContent = t('hd.recovering');

        try {
            const data = await apiPost('wallet/recover-xpub', { xpub });

            // Hide input cards
            document.getElementById('hd-xpub-input-card').style.display = 'none';

            // Show the flow container — only master xpub, pubkey, address (no mnemonic, no privkey)
            document.getElementById('hd-flow-container').style.display = 'block';

            // Hide mnemonic and privkey steps
            document.getElementById('hd-step-mnemonic').style.display = 'none';
            document.getElementById('hd-step-privkey').style.display = 'none';

            // Show master key step (xpub only)
            await new Promise(resolve => setTimeout(resolve, 100));
            const masterEl = document.getElementById('hd-step-master');
            document.getElementById('hd-master-keys').innerHTML =
                `<div class="keypair-box">
                    <div class="keypair-row"><span class="keypair-label" style="background:rgba(46,204,113,0.2);color:var(--success)">xpub</span><span class="keypair-value mono-text">${escapeHtml(data.xpub)}</span></div>
                </div>
                <div class="watch-only-badge">${escapeHtml(t('hd.watchOnly'))}</div>`;
            masterEl.style.display = '';
            masterEl.style.animationDelay = '0s';

            // Show public key step
            await new Promise(resolve => setTimeout(resolve, 300));
            const pubEl = document.getElementById('hd-step-pubkey');
            document.getElementById('hd-pubkey').textContent = data.public_key_hex;
            pubEl.style.display = '';
            pubEl.style.animationDelay = '0s';

            // Show address step
            await new Promise(resolve => setTimeout(resolve, 300));
            const addrEl = document.getElementById('hd-step-address');
            document.getElementById('hd-address').textContent = data.address;
            const qrEl = document.getElementById('hd-address-qr');
            qrEl.innerHTML = '';
            new QRCode(qrEl, {
                text: data.address,
                width: 128, height: 128,
                colorDark: '#000000', colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M,
            });
            addrEl.style.display = '';
            addrEl.style.animationDelay = '0s';

            // Store partial wallet data for copy (no privkey/mnemonic)
            _lastGeneratedWallet = {
                mnemonic: '',
                master_xprv: '',
                master_xpub: data.xpub,
                private_key_wif: '',
                public_key_hex: data.public_key_hex,
                address: data.address,
            };

            await new Promise(resolve => setTimeout(resolve, 300));
            document.getElementById('hd-action-bar').style.display = '';

            // No backup warning for watch-only
            document.getElementById('hd-backup-warning').style.display = 'none';
            showToast(t('hd.recoveredXpub'));

        } catch (err) {
            showToast(t('hd.invalidXpub') + ': ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = t('hd.recoverBtn');
        }
    });

    // ========================================================
    // 3-1b. BALANCE CHECK (xpub / Address)
    // ========================================================

    const _allBalanceCards = ['hd-xpub-balance-card', 'hd-address-balance-card'];

    function hideAllBalanceCards() {
        _allBalanceCards.forEach(id => {
            document.getElementById(id).style.display = 'none';
        });
    }

    function hideAllInputCards() {
        document.getElementById('hd-mnemonic-input-card').style.display = 'none';
        document.getElementById('hd-xpub-input-card').style.display = 'none';
        hideAllBalanceCards();
    }

    function hideGeneratedResults() {
        document.getElementById('hd-flow-container').style.display = 'none';
        document.getElementById('hd-backup-warning').style.display = 'none';
        document.getElementById('hd-action-bar').style.display = 'none';
        document.getElementById('hd-xpub-balance-result').style.display = 'none';
        document.getElementById('hd-address-balance-result').style.display = 'none';
        _lastGeneratedWallet = null;
    }

    // Toggle xpub balance card
    document.getElementById('hd-balance-xpub-btn').addEventListener('click', () => {
        const card = document.getElementById('hd-xpub-balance-card');
        const wasHidden = card.style.display === 'none';
        hideAllInputCards();
        hideGeneratedResults();
        card.style.display = wasHidden ? '' : 'none';
    });

    // Toggle address balance card
    document.getElementById('hd-balance-address-btn').addEventListener('click', () => {
        const card = document.getElementById('hd-address-balance-card');
        const wasHidden = card.style.display === 'none';
        hideAllInputCards();
        hideGeneratedResults();
        card.style.display = wasHidden ? '' : 'none';
    });

    // Close buttons
    document.getElementById('hd-xpub-balance-close').addEventListener('click', () => {
        document.getElementById('hd-xpub-balance-card').style.display = 'none';
    });
    document.getElementById('hd-address-balance-close').addEventListener('click', () => {
        document.getElementById('hd-address-balance-card').style.display = 'none';
    });

    // xpub balance check
    document.getElementById('hd-xpub-balance-check-btn').addEventListener('click', async () => {
        const xpub = document.getElementById('hd-xpub-balance-input').value.trim();
        if (!xpub) {
            showToast(t('bal.invalidXpub'), true);
            return;
        }

        const btn = document.getElementById('hd-xpub-balance-check-btn');
        btn.disabled = true;
        btn.textContent = t('bal.checking');

        try {
            const data = await apiPost('wallet/xpub-balance', { xpub });

            const resultEl = document.getElementById('hd-xpub-balance-result');
            resultEl.style.display = '';

            // Hide the flow container and other results
            document.getElementById('hd-flow-container').style.display = 'none';
            document.getElementById('hd-backup-warning').style.display = 'none';
            document.getElementById('hd-action-bar').style.display = 'none';
            document.getElementById('hd-address-balance-result').style.display = 'none';

            renderInfoGrid('xpub-balance-summary', [
                { label: t('bal.totalBalance'), value: formatCRN(data.total_balance), cls: 'large' },
                { label: t('bal.addressesChecked'), value: data.addresses_checked },
                { label: t('bal.addressesWithBalance'), value: data.addresses_with_balance },
            ]);

            const tbody = document.getElementById('xpub-balance-table');
            tbody.innerHTML = '';

            if (data.addresses.length === 0) {
                tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">${escapeHtml(t('bal.noBalance'))}</td></tr>`;
            } else {
                data.addresses.forEach(addr => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="mono">${escapeHtml(addr.path)}</td>
                        <td class="mono">${escapeHtml(addr.address)}</td>
                        <td class="mono">${formatCRN(addr.balance)}</td>`;
                    tbody.appendChild(tr);
                });
            }

            document.getElementById('hd-xpub-balance-card').style.display = 'none';
            resultEl.scrollIntoView({ behavior: 'smooth' });
            showToast(data.addresses_with_balance > 0
                ? t('bal.totalBalance') + ': ' + formatCRN(data.total_balance)
                : t('bal.noBalance'));
        } catch (err) {
            showToast(t('bal.invalidXpub') + ': ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = t('bal.checkBtn');
        }
    });

    // Address balance check
    document.getElementById('hd-address-balance-check-btn').addEventListener('click', async () => {
        const address = document.getElementById('hd-address-balance-input').value.trim();
        if (!address) {
            showToast(t('bal.invalidAddress'), true);
            return;
        }

        const btn = document.getElementById('hd-address-balance-check-btn');
        btn.disabled = true;
        btn.textContent = t('bal.checking');

        try {
            const data = await apiPost('wallet/address-balance', { address });

            const resultEl = document.getElementById('hd-address-balance-result');
            resultEl.style.display = '';

            // Hide the flow container and other results
            document.getElementById('hd-flow-container').style.display = 'none';
            document.getElementById('hd-backup-warning').style.display = 'none';
            document.getElementById('hd-action-bar').style.display = 'none';
            document.getElementById('hd-xpub-balance-result').style.display = 'none';

            document.getElementById('address-balance-display').innerHTML =
                `<div class="balance-label">${escapeHtml(t('bal.balance'))}</div>
                 <div class="balance-amount">${formatCRN(data.balance)}</div>`;

            renderInfoGrid('address-balance-info', [
                { label: t('bal.address'), value: data.address, cls: 'mono' },
                { label: t('bal.utxoCount'), value: data.utxo_count },
            ]);

            document.getElementById('hd-address-balance-card').style.display = 'none';
            resultEl.scrollIntoView({ behavior: 'smooth' });
            showToast(data.balance > 0
                ? t('bal.balance') + ': ' + formatCRN(data.balance)
                : t('bal.noBalance'));
        } catch (err) {
            showToast(t('bal.invalidAddress') + ': ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = t('bal.checkBtn');
        }
    });

    // ========================================================
    // 3-2. SEND COIN
    // ========================================================

    document.getElementById('send-btn').addEventListener('click', async () => {
        const address = document.getElementById('send-address').value.trim();
        const amount = parseFloat(document.getElementById('send-amount').value);
        if (!address || !amount || amount <= 0) {
            showToast(t('send.invalidInput'), true);
            return;
        }
        const msg = t('send.confirmSend', { amount: formatAmount(amount), address: address });
        if (!confirm(msg)) return;

        try {
            const data = await apiPost('wallet/send', { address, amount });
            document.getElementById('send-result').innerHTML =
                `<div class="address-display">${escapeHtml(t('send.sentTxid'))} <span class="hash-link" id="sent-txid-link">${escapeHtml(data.txid)}</span></div>`;
            document.getElementById('sent-txid-link').addEventListener('click', () => viewTransaction(data.txid));
            document.getElementById('send-address').value = '';
            document.getElementById('send-amount').value = '';
            showToast(t('send.sendSuccess'));
        } catch (err) {
            showToast(t('send.sendFailed') + ': ' + err.message, true);
        }
    });


    async function loadRecentTxList() {
        try {
            const txList = await apiGet('wallet/transactions');
            const tbody = document.getElementById('wallet-tx-list');
            tbody.innerHTML = '';
            if (Array.isArray(txList)) {
                txList.reverse().forEach(tx => {
                    const tr = document.createElement('tr');
                    const amtCls = tx.amount >= 0 ? 'amount-positive' : 'amount-negative';
                    tr.innerHTML = `
                        <td class="mono"><span class="hash-link" data-txid="${escapeHtml(tx.txid)}">${escapeHtml(truncHash(tx.txid, 10))}</span></td>
                        <td>${escapeHtml(tx.category)}</td>
                        <td class="mono ${amtCls}">${formatAmount(tx.amount)}</td>
                        <td>${tx.confirmations}</td>
                        <td>${formatTime(tx.time)}</td>`;
                    tr.querySelector('.hash-link').addEventListener('click', () => viewTransaction(tx.txid));
                    tbody.appendChild(tr);
                });
            }
        } catch (err) {
            showToast(t('error') + ': ' + err.message, true);
        }
    }

    // ========================================================
    // 4. MINING
    // ========================================================

    document.getElementById('mine-btn').addEventListener('click', async () => {
        const nblocks = parseInt(document.getElementById('mine-count').value) || 1;
        const address = document.getElementById('mine-address').value.trim();
        const btn = document.getElementById('mine-btn');
        btn.disabled = true;
        btn.textContent = t('mining.mining');

        try {
            const data = await apiPost('mine', { nblocks, address: address || undefined });
            const resultEl = document.getElementById('mine-result');
            resultEl.innerHTML = `<div class="card-title">${escapeHtml(t('mining.minedResult', { count: data.blocks.length, address: data.address }))}</div>`;
            data.blocks.forEach(hash => {
                const link = document.createElement('span');
                link.className = 'hash-link';
                link.textContent = hash;
                link.addEventListener('click', () => {
                    tabs.forEach(t => t.classList.remove('active'));
                    tabContents.forEach(tc => tc.classList.remove('active'));
                    document.querySelector('[data-tab="blocks"]').classList.add('active');
                    document.getElementById('tab-blocks').classList.add('active');
                    document.getElementById('block-search').value = hash;
                    searchBlock();
                });
                resultEl.appendChild(link);
            });
            showToast(t('mining.minedToast', { count: data.blocks.length }));
            loadMiningInfo();
            updateStatusBar();
        } catch (err) {
            showToast(t('mining.error') + ': ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = t('mining.mineBtn');
        }
    });

    async function loadMiningInfo() {
        try {
            const [mining, blockchain, balance] = await Promise.all([
                apiGet('mining'),
                apiGet('blockchain'),
                apiGet('wallet/balance').catch(() => null),
            ]);

            // Mining balance
            if (balance && balance.mine) {
                const trusted = balance.mine.trusted || 0;
                const immature = balance.mine.immature || 0;
                const pending = balance.mine.untrusted_pending || 0;
                document.getElementById('mining-balance').textContent = formatNumber(trusted) + ' CRN';
                renderInfoGrid('mining-balance-grid', [
                    { label: t('wallet.trusted'), value: formatCRN(trusted) },
                    { label: t('wallet.immature'), value: formatCRN(immature) },
                    { label: t('wallet.pending'), value: formatCRN(pending) },
                ]);
            }

            const reward = getBlockReward(blockchain.blocks);
            const nextHalving = HALVING_INTERVAL_REGTEST - (blockchain.blocks % HALVING_INTERVAL_REGTEST);

            renderInfoGrid('mining-info-grid', [
                { label: t('mining.currentHeight'), value: blockchain.blocks, cls: 'large' },
                { label: t('mining.difficulty'), value: mining.difficulty },
                { label: t('mining.hashrate'), value: (mining.networkhashps || 0).toFixed(2) + ' H/s' },
                { label: t('mining.chain'), value: mining.chain },
                { label: t('mining.blockReward'), value: formatCRN(reward) },
                { label: t('mining.blocksUntilHalving'), value: nextHalving },
                { label: t('mining.totalSupply'), value: formatNumber(getTotalSupply(blockchain.blocks)) + ' CRN' },
                { label: t('mining.poolSize'), value: mining.pooledtx !== undefined ? mining.pooledtx : '—' },
            ]);
        } catch (err) {
            showToast(t('mining.error') + ': ' + err.message, true);
        }
    }

    // ========================================================
    // 5. RICH LIST
    // ========================================================

    async function loadRichList() {
        const tbody = document.getElementById('richlist-table');
        const summary = document.getElementById('richlist-summary');
        tbody.innerHTML = `<tr><td colspan="4" class="loading">${escapeHtml(t('richlist.loading'))}</td></tr>`;
        summary.innerHTML = '';

        try {
            const data = await apiGet('richlist');

            renderInfoGrid('richlist-summary', [
                { label: t('richlist.scannedHeight'), value: data.height, cls: 'large' },
                { label: t('richlist.chain'), value: (_currentChain || 'regtest').toUpperCase() },
                { label: t('richlist.totalSupply'), value: formatNumber(data.total_supply) + ' CRN' },
                { label: t('richlist.totalAddresses'), value: data.total_addresses },
            ]);

            tbody.innerHTML = '';
            const supply = data.total_supply || 1;
            data.addresses.forEach((entry, i) => {
                const tr = document.createElement('tr');
                const pct = (entry.balance / supply * 100).toFixed(2);
                tr.innerHTML = `
                    <td>${i + 1}</td>
                    <td class="mono">${escapeHtml(entry.address)}</td>
                    <td class="mono">${formatNumber(entry.balance)}</td>
                    <td>${pct}%</td>`;
                tbody.appendChild(tr);
            });

            if (data.addresses.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">${escapeHtml(t('block.noBlocks'))}</td></tr>`;
            }
        } catch (err) {
            tbody.innerHTML = '';
            showToast(t('richlist.error') + ': ' + err.message, true);
        }
    }

    // ========================================================
    // 6. NETWORK STATUS
    // ========================================================

    async function loadNetworkTab() {
        try {
            const [chain, net, pool, peers] = await Promise.all([
                apiGet('blockchain'),
                apiGet('network'),
                apiGet('mempool'),
                apiGet('peers'),
            ]);

            renderInfoGrid('chain-info-grid', [
                { label: t('network.chain'), value: chain.chain },
                { label: t('network.blocks'), value: chain.blocks, cls: 'large' },
                { label: t('network.headers'), value: chain.headers },
                { label: t('network.bestBlockHash'), value: chain.bestblockhash, cls: 'mono' },
                { label: t('network.difficulty'), value: chain.difficulty },
                { label: t('network.medianTime'), value: formatTime(chain.mediantime) },
                { label: t('network.verificationProgress'), value: (chain.verificationprogress * 100).toFixed(2) + '%' },
                { label: t('network.totalSupply'), value: formatNumber(getTotalSupply(chain.blocks)) + ' CRN' },
                { label: t('network.pruned'), value: chain.pruned ? t('yes') : t('no') },
                { label: t('network.sizeOnDisk'), value: formatBytes(chain.size_on_disk || 0) },
            ]);

            renderInfoGrid('net-info-grid', [
                { label: t('network.version'), value: net.version },
                { label: t('network.subversion'), value: net.subversion },
                { label: t('network.protocol'), value: net.protocolversion },
                { label: t('network.connections'), value: net.connections },
                { label: t('network.connectionsIn'), value: net.connections_in },
                { label: t('network.connectionsOut'), value: net.connections_out },
                { label: t('network.localRelay'), value: net.localrelay ? t('yes') : t('no') },
                { label: t('network.networkActive'), value: net.networkactive ? t('yes') : t('no') },
            ]);

            renderInfoGrid('mempool-info-grid', [
                { label: t('network.transactions'), value: pool.size },
                { label: t('network.size'), value: formatBytes(pool.bytes || 0) },
                { label: t('network.usage'), value: formatBytes(pool.usage || 0) },
                { label: t('network.maxSize'), value: formatBytes(pool.maxmempool || 0) },
                { label: t('network.minFee'), value: pool.mempoolminfee },
                { label: t('network.minRelayFee'), value: pool.minrelaytxfee },
                { label: t('network.incrementalFee'), value: pool.incrementalrelayfee },
                { label: t('network.unbroadcast'), value: pool.unbroadcastcount },
            ]);

            // Peer table
            const tbody = document.getElementById('peer-table');
            tbody.innerHTML = '';
            if (Array.isArray(peers)) {
                peers.forEach(peer => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="mono">${escapeHtml(peer.addr)}</td>
                        <td>${escapeHtml(peer.subver || '')}</td>
                        <td>${peer.pingtime ? (peer.pingtime * 1000).toFixed(0) : '—'}</td>
                        <td>${formatBytes(peer.bytessent || 0)}</td>
                        <td>${formatBytes(peer.bytesrecv || 0)}</td>`;
                    tbody.appendChild(tr);
                });
            }

            if (peers.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">${escapeHtml(t('network.noPeers'))}</td></tr>`;
            }
        } catch (err) {
            showToast(t('network.error') + ': ' + err.message, true);
        }
    }

    // ========================================================
    // 7. DICE
    // ========================================================

    let _diceKnownHeight = -1;
    let _diceCountdownTimer = null;
    let _dicePollingTimer = null;
    let _diceRevealing = false;

    function diceUpdateTitle(nextHeight) {
        const titleEl = document.getElementById('dice-next-title');
        if (titleEl) titleEl.textContent = t('dice.nextBlock', { height: nextHeight });
    }

    function diceShowWaiting(lastBlockTime) {
        const face = document.getElementById('dice-face');
        face.setAttribute('data-value', '?');
        face.classList.remove('revealed');
        face.innerHTML = '<div class="dice-question">?</div>';

        const heroInfo = document.getElementById('dice-hero-info');
        heroInfo.innerHTML = '';

        // Countdown: next block expected 180s after last block
        const cdEl = document.getElementById('dice-countdown');
        if (_diceCountdownTimer) clearInterval(_diceCountdownTimer);

        function updateCountdown() {
            const now = Math.floor(Date.now() / 1000);
            const nextBlockAt = lastBlockTime + 180;
            let remaining = nextBlockAt - now;
            if (remaining < 0) remaining = 0;
            const min = Math.floor(remaining / 60);
            const sec = remaining % 60;
            cdEl.innerHTML = `<div class="countdown-label">${t('dice.waiting')}</div>${min}:${sec < 10 ? '0' : ''}${sec}`;
        }
        updateCountdown();
        _diceCountdownTimer = setInterval(updateCountdown, 1000);
    }

    function diceShowResult(block) {
        _diceRevealing = true;
        if (_diceCountdownTimer) { clearInterval(_diceCountdownTimer); _diceCountdownTimer = null; }

        playApplause();

        const meta = getBlockMeta(block);
        const dice = meta && meta.R ? meta.R : getDiceFromHash(block.hash);
        const isOdd = meta && meta.P !== undefined ? meta.P === 1 : (dice % 2 !== 0);
        const bh = meta && meta.H !== undefined ? meta.H : block.height;

        // Title shows current revealed block
        diceUpdateTitle(bh);

        const face = document.getElementById('dice-face');
        face.setAttribute('data-value', dice);
        face.classList.add('revealed');
        face.innerHTML = renderDiceDots(dice);

        const cdEl = document.getElementById('dice-countdown');
        cdEl.innerHTML = '';

        const heroInfo = document.getElementById('dice-hero-info');
        const oddEvenText = isOdd ? t('dice.odd') : t('dice.even');
        const oddEvenCls = isOdd ? 'odd' : 'even';
        heroInfo.innerHTML = `
            <div class="dice-number">${dice}</div>
            <div class="dice-oddeven ${oddEvenCls}">${oddEvenText}</div>
            <div class="dice-label">${t('dice.revealed', { height: bh })}</div>
            <div class="dice-label">${meta && meta.T ? escapeHtml(meta.T) : formatTime(block.time)}</div>`;

        // After 5 seconds, go back to waiting mode and reload history
        setTimeout(() => {
            _diceRevealing = false;
            diceUpdateTitle(block.height + 1);
            diceShowWaiting(block.time);
            loadDiceHistory(block.height);
        }, 5000);
    }

    async function loadDiceHistory(height) {
        const tbody = document.getElementById('dice-table');
        tbody.innerHTML = '';
        const count = Math.min(20, height + 1);

        for (let i = 0; i < count; i++) {
            const h = height - i;
            if (h < 0) break;
            try {
                const block = await apiGet('blockheight/' + h);
                const m = getBlockMeta(block);
                const dice = m && m.R ? m.R : getDiceFromHash(block.hash);
                const isOdd = m && m.P !== undefined ? m.P === 1 : (dice % 2 !== 0);
                const bh = m && m.H !== undefined ? m.H : block.height;
                const oeText = isOdd ? t('dice.odd') : t('dice.even');
                const oeCls = isOdd ? 'odd' : 'even';
                const timeDisplay = m && m.T ? escapeHtml(m.T) : formatTime(block.time);

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>#${bh}</strong></td>
                    <td><span class="dice-dot-inline">${dice}</span></td>
                    <td><span class="dice-oddeven ${oeCls}">${oeText}</span></td>
                    <td>${timeDisplay}</td>
                    <td class="mono"><span class="hash-link">${escapeHtml(truncHash(block.hash, 12))}</span></td>`;
                tr.querySelector('.hash-link').addEventListener('click', () => {
                    tabs.forEach(t => t.classList.remove('active'));
                    tabContents.forEach(tc => tc.classList.remove('active'));
                    document.querySelector('[data-tab="blocks"]').classList.add('active');
                    document.getElementById('tab-blocks').classList.add('active');
                    document.getElementById('block-search').value = String(block.height);
                    searchBlock();
                });
                tbody.appendChild(tr);
            } catch (e) {
                // skip
            }
        }
    }

    function startDicePolling() {
        if (_dicePollingTimer) clearInterval(_dicePollingTimer);
        _dicePollingTimer = setInterval(async () => {
            if (_diceRevealing) return;
            try {
                const info = await apiGet('blockchain');
                if (info.blocks > _diceKnownHeight) {
                    const newBlock = await apiGet('blockheight/' + info.blocks);
                    _diceKnownHeight = info.blocks;
                    diceShowResult(newBlock);
                }
            } catch (e) {
                // ignore polling errors
            }
        }, 5000);
    }

    function stopDicePolling() {
        if (_dicePollingTimer) { clearInterval(_dicePollingTimer); _dicePollingTimer = null; }
        if (_diceCountdownTimer) { clearInterval(_diceCountdownTimer); _diceCountdownTimer = null; }
    }

    async function loadDice() {
        try {
            const info = await apiGet('blockchain');
            const height = info.blocks;
            _diceKnownHeight = height;

            const latestBlock = await apiGet('blockheight/' + height);
            diceUpdateTitle(height + 1);
            diceShowWaiting(latestBlock.time);
            await loadDiceHistory(height);
            startDicePolling();
        } catch (err) {
            showToast(t('dice.error') + ': ' + err.message, true);
        }
    }

    // ========================================================
    // 8. GUIDE
    // ========================================================

    const _guideSections = [
        { titleKey: 'guide.blocks.title', descKey: 'guide.blocks.desc', icon: '🔍' },
        { titleKey: 'guide.tx.title', descKey: 'guide.tx.desc', icon: '📄' },
        { titleKey: 'guide.wallet.title', descKey: 'guide.wallet.desc', icon: '💰' },
        { titleKey: 'guide.mining.title', descKey: 'guide.mining.desc', icon: '⛏' },
        { titleKey: 'guide.richlist.title', descKey: 'guide.richlist.desc', icon: '🏆' },
        { titleKey: 'guide.network.title', descKey: 'guide.network.desc', icon: '🌐' },
        { titleKey: 'guide.dice.title', descKey: 'guide.dice.desc', icon: '🎲' },
        { titleKey: 'guide.common.title', descKey: 'guide.common.desc', icon: '⚙' },
    ];

    function loadGuide() {
        const el = document.getElementById('guide-content');
        el.innerHTML = _guideSections.map(sec =>
            `<div class="guide-section">
                <div class="guide-section-title"><span class="guide-icon">${sec.icon}</span> ${escapeHtml(t(sec.titleKey))}</div>
                <div class="guide-section-desc">${escapeHtml(t(sec.descKey))}</div>
            </div>`
        ).join('');
    }

    // ========================================================
    // CHAIN BADGE
    // ========================================================

    let _currentChain = '';

    function updateChainBadge(chain) {
        _currentChain = chain;
        const badge = document.getElementById('chain-badge');
        badge.className = 'chain-badge';
        if (chain === 'regtest') {
            badge.textContent = t('chain.regtest');
            badge.classList.add('regtest');
        } else if (chain === 'test' || chain === 'testnet') {
            badge.textContent = t('chain.testnet');
            badge.classList.add('testnet');
        } else if (chain === 'main') {
            badge.textContent = t('chain.mainnet');
            badge.classList.add('mainnet');
        } else {
            badge.textContent = chain.toUpperCase();
        }
    }

    function updateGlobalNotice(chain) {
        const el = document.getElementById('global-notice');
        if (chain === 'regtest') {
            el.style.display = 'block';
            el.textContent = t('richlist.regtestNotice');
        } else {
            el.style.display = 'none';
        }
    }

    // ========================================================
    // STATUS BAR & AUTO REFRESH
    // ========================================================

    async function updateStatusBar() {
        try {
            const [chain, pool] = await Promise.all([
                apiGet('blockchain'),
                apiGet('mempool').catch(() => null),
            ]);

            document.getElementById('status-dot').classList.remove('disconnected');
            document.getElementById('status-chain').textContent = chain.chain;
            document.getElementById('status-height').textContent = chain.blocks;
            document.getElementById('status-mempool').textContent = pool ? pool.size + ' txs' : '—';
            document.getElementById('status-supply').textContent = formatNumber(getTotalSupply(chain.blocks)) + ' CRN';

            // Update chain badge and global notice
            updateChainBadge(chain.chain);
            updateGlobalNotice(chain.chain);

            // Get connection count from network info
            apiGet('network').then(net => {
                document.getElementById('status-connections').textContent = net.connections;
            }).catch(() => {});
        } catch (err) {
            document.getElementById('status-dot').classList.add('disconnected');
            document.getElementById('status-chain').textContent = t('status.disconnected');
        }
    }

    // Apply saved language on load
    applyI18n();

    // Restore tab from URL hash, default to 'blocks'
    const savedTab = location.hash.replace('#', '') || 'blocks';
    switchTab(savedTab);
    updateStatusBar();

    // Auto-refresh status bar every 30 seconds (tabs are not auto-refreshed)
    setInterval(() => {
        updateStatusBar();
    }, 30000);

})();
