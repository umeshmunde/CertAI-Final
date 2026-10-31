document.addEventListener('DOMContentLoaded', () => {

    // Open Access Mode: All certificate extraction and report features are freely available to everyone!

    // ========================================================
    // FACULTY AI API KEYS & DEPLOYMENT MANAGEMENT ENGINE
    // ========================================================
    function getApiUrl(endpoint) {
        const customBase = localStorage.getItem('certai_backend_url') || '';
        if (customBase) {
            return customBase.replace(/\/$/, '') + endpoint;
        }
        // When deployed on Netlify, connect directly to the Render backend to bypass edge timeouts and buffering
        if (window.location.hostname.includes('netlify.app')) {
            return 'https://certai-backend.onrender.com' + endpoint;
        }
        return endpoint;
    }

    // Safe Response Parser: Handles 502/504 spin-up states, empty responses, and non-JSON gracefully
    async function safeParseResponse(response, defaultMsg = 'Server request failed.') {
        const text = await response.text();
        if (!text || !text.trim()) {
            if (!response.ok) {
                if (response.status === 502 || response.status === 504 || response.status === 503) {
                    throw new Error(`The backend on Render is currently spinning up from sleep (HTTP ${response.status}). Free-tier instances sleep after inactivity. Please wait 15–20 seconds and try extracting again.`);
                }
                throw new Error(`Server returned HTTP ${response.status} with an empty response.`);
            }
            return {};
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            if (!response.ok) {
                if (response.status === 502 || response.status === 504) {
                    throw new Error(`Backend server is waking up or temporarily busy (HTTP ${response.status}). Please retry in 15 seconds.`);
                }
                throw new Error(`Server error (${response.status}): ${text.substring(0, 120)}`);
            }
            throw new Error(defaultMsg);
        }
    }

    function getFacultyAuthHeaders() {
        const headers = {};
        const storedKeys = localStorage.getItem('certai_gemini_keys');
        if (storedKeys) {
            try {
                const arr = JSON.parse(storedKeys).filter(k => k && k.trim().length > 5);
                if (arr.length > 0) {
                    headers['x-gemini-keys'] = JSON.stringify(arr);
                }
            } catch (e) {}
        }
        const groqKey = localStorage.getItem('certai_groq_key');
        if (groqKey && groqKey.trim().length > 5) {
            headers['x-groq-key'] = groqKey.trim();
        }
        const ocrKey = localStorage.getItem('certai_ocr_key');
        if (ocrKey && ocrKey.trim().length > 3) {
            headers['x-ocr-key'] = ocrKey.trim();
        }
        return headers;
    }

    // Modal DOM Elements
    const keysModalOverlay = document.getElementById('keys-modal-overlay');
    const openKeysModalBtn = document.getElementById('open-keys-modal-btn');
    const keysModalCloseBtn = document.getElementById('keys-modal-close-btn');
    const bannerManageKeysBtn = document.getElementById('banner-manage-keys-btn');
    const geminiKeysContainer = document.getElementById('gemini-keys-container');
    const addKeySlotBtn = document.getElementById('add-key-slot-btn');
    const testKeysBtn = document.getElementById('test-keys-btn');
    const testKeysLoader = document.getElementById('test-keys-loader');
    const testBtnText = document.getElementById('test-btn-text');
    const saveKeysBtn = document.getElementById('save-keys-btn');
    const clearKeysBtn = document.getElementById('clear-keys-btn');
    const keysStatusMsg = document.getElementById('keys-status-msg');
    const groqKeyInput = document.getElementById('groq-key-input');
    const ocrKeyInput = document.getElementById('ocr-key-input');
    const backendUrlInput = document.getElementById('backend-url-input');
    const navKeysCountBadge = document.getElementById('nav-keys-count-badge');
    const bannerKeysStatusBadge = document.getElementById('banner-keys-status-badge');
    const bannerTitle = document.getElementById('banner-title');
    const bannerDesc = document.getElementById('banner-desc');
    const keysPoolCountPill = document.getElementById('keys-pool-count-pill');

    // Deploy Modal Elements
    const deployModalOverlay = document.getElementById('deploy-modal-overlay');
    const openDeployModalBtn = document.getElementById('open-deploy-modal-btn');
    const deployModalCloseBtn = document.getElementById('deploy-modal-close-btn');
    const deployCloseBtn = document.getElementById('deploy-close-btn');
    const deployTabBtns = document.querySelectorAll('.deploy-tab-btn');
    const deployTabContents = document.querySelectorAll('.deploy-tab-content');

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function updateKeysUIBadges(count) {
        if (navKeysCountBadge) {
            navKeysCountBadge.textContent = count > 0 ? `${count} Active` : '0 Keys';
            navKeysCountBadge.className = `badge-keys-count ${count >= 3 ? 'success' : 'warning'}`;
        }
        if (bannerKeysStatusBadge) {
            bannerKeysStatusBadge.textContent = count > 0 ? `⚡ ${count} Keys Active (Rotated)` : '⚠️ 0 Keys Configured';
            bannerKeysStatusBadge.className = `badge-status-pill ${count >= 3 ? 'success' : 'warning'}`;
        }
        if (bannerTitle) {
            bannerTitle.textContent = count > 0 ? `Faculty Multi-Key Engine (${count} Keys Active)` : 'Faculty Multi-Key Engine';
        }
        if (bannerDesc) {
            bannerDesc.textContent = count > 0
                ? `Automatic round-robin rotation across ${count} Gemini keys. Rate limits multiplied by ${count}x with zero 429 quota errors!`
                : 'Enter 3–4 Gemini API keys for seamless round-robin rotation, multiplying batch speed and preventing 429 rate limits.';
        }
        if (keysPoolCountPill) {
            keysPoolCountPill.textContent = `${count} Active Slots`;
            keysPoolCountPill.className = `badge-status-pill ${count >= 3 ? 'success' : 'info'}`;
        }
    }

    function renderKeySlots(keys) {
        if (!geminiKeysContainer) return;
        const initialCount = Math.max(keys.length, 4);
        geminiKeysContainer.innerHTML = '';

        for (let i = 0; i < initialCount; i++) {
            const keyVal = keys[i] || '';
            const slotEl = document.createElement('div');
            slotEl.className = 'key-slot-row';
            slotEl.setAttribute('data-index', i);

            const labelText = i === 0 ? 'Gemini Key #1 (Primary)' : `Gemini Key #${i + 1}`;
            slotEl.innerHTML = `
                <div class="key-slot-header">
                    <span class="key-slot-label">${labelText}</span>
                    <span class="key-status-badge untested" id="key-status-${i}">⚪ Not Tested</span>
                </div>
                <div class="input-with-icon-right">
                    <input type="password" class="key-input" id="key-input-${i}" placeholder="AIzaSy..." value="${escapeHtml(keyVal)}" autocomplete="off" />
                    <button type="button" class="key-eye-btn" data-target="key-input-${i}" title="Toggle visibility">👁️</button>
                    <button type="button" class="key-clear-btn" data-target="key-input-${i}" title="Clear key">&times;</button>
                </div>
            `;
            geminiKeysContainer.appendChild(slotEl);
        }

        attachKeySlotEvents();
    }

    function attachKeySlotEvents() {
        document.querySelectorAll('.key-eye-btn').forEach(btn => {
            btn.onclick = () => {
                const targetId = btn.getAttribute('data-target');
                const inp = document.getElementById(targetId);
                if (inp) {
                    inp.type = inp.type === 'password' ? 'text' : 'password';
                }
            };
        });

        document.querySelectorAll('.key-clear-btn').forEach(btn => {
            btn.onclick = () => {
                const targetId = btn.getAttribute('data-target');
                const inp = document.getElementById(targetId);
                if (inp) {
                    inp.value = '';
                    const idx = targetId.replace('key-input-', '');
                    const badge = document.getElementById(`key-status-${idx}`);
                    if (badge) {
                        badge.textContent = '⚪ Not Tested';
                        badge.className = 'key-status-badge untested';
                    }
                }
            };
        });

        // Real-time format check: Google AI Studio keys start with "AIzaSy"
        document.querySelectorAll('#gemini-keys-container .key-input').forEach(inp => {
            inp.oninput = () => {
                const idx = inp.id.replace('key-input-', '');
                const badge = document.getElementById(`key-status-${idx}`);
                const val = inp.value.trim();
                if (!badge) return;
                if (!val) {
                    badge.textContent = '⚪ Not Tested';
                    badge.className = 'key-status-badge untested';
                } else if (!val.startsWith('AIzaSy')) {
                    badge.textContent = '⚠️ Must start with AIzaSy...';
                    badge.className = 'key-status-badge invalid';
                } else {
                    badge.textContent = '⚪ Ready to Test';
                    badge.className = 'key-status-badge untested';
                }
            };
        });
    }

    function getEnteredGeminiKeys() {
        const inputs = document.querySelectorAll('#gemini-keys-container .key-input');
        const keys = [];
        inputs.forEach(inp => {
            const val = inp.value.trim();
            if (val.length > 5) keys.push(val);
        });
        return keys;
    }

    function loadSavedKeys() {
        let keys = [];
        const stored = localStorage.getItem('certai_gemini_keys');
        if (stored) {
            try {
                keys = JSON.parse(stored);
            } catch (e) {}
        }

        renderKeySlots(keys);
        updateKeysUIBadges(keys.filter(k => k && k.length > 5).length);

        if (groqKeyInput) groqKeyInput.value = localStorage.getItem('certai_groq_key') || '';
        if (ocrKeyInput) ocrKeyInput.value = localStorage.getItem('certai_ocr_key') || '';
        if (backendUrlInput) backendUrlInput.value = localStorage.getItem('certai_backend_url') || '';

        const savedEngine = localStorage.getItem('certai_ai_engine') || 'auto';
        const engineRadio = document.querySelector(`input[name="ai-engine-choice"][value="${savedEngine}"]`);
        if (engineRadio) engineRadio.checked = true;

        // Also query backend status to check server-loaded keys
        fetch(getApiUrl('/api/keys/status'))
            .then(res => safeParseResponse(res))
            .then(statusData => {
                if (statusData.success && statusData.totalGeminiKeys > 0 && keys.length === 0) {
                    // Pre-fill masked placeholders if env has keys but UI was empty
                    updateKeysUIBadges(statusData.totalGeminiKeys);
                }
            })
            .catch(() => {});
    }

    // Modal Open & Close Event Listeners
    if (openKeysModalBtn) {
        openKeysModalBtn.addEventListener('click', () => {
            if (keysModalOverlay) keysModalOverlay.classList.remove('hidden');
        });
    }
    if (bannerManageKeysBtn) {
        bannerManageKeysBtn.addEventListener('click', () => {
            if (keysModalOverlay) keysModalOverlay.classList.remove('hidden');
        });
    }
    if (keysModalCloseBtn) {
        keysModalCloseBtn.addEventListener('click', () => {
            if (keysModalOverlay) keysModalOverlay.classList.add('hidden');
        });
    }
    if (keysModalOverlay) {
        keysModalOverlay.addEventListener('click', (e) => {
            if (e.target === keysModalOverlay) keysModalOverlay.classList.add('hidden');
        });
    }

    // Add Dynamic Key Slot
    if (addKeySlotBtn) {
        addKeySlotBtn.addEventListener('click', () => {
            const currentSlots = document.querySelectorAll('#gemini-keys-container .key-slot-row');
            const newIndex = currentSlots.length;
            const slotEl = document.createElement('div');
            slotEl.className = 'key-slot-row';
            slotEl.setAttribute('data-index', newIndex);
            slotEl.innerHTML = `
                <div class="key-slot-header">
                    <span class="key-slot-label">Gemini Key #${newIndex + 1}</span>
                    <span class="key-status-badge untested" id="key-status-${newIndex}">⚪ Not Tested</span>
                </div>
                <div class="input-with-icon-right">
                    <input type="password" class="key-input" id="key-input-${newIndex}" placeholder="AIzaSy..." autocomplete="off" />
                    <button type="button" class="key-eye-btn" data-target="key-input-${newIndex}" title="Toggle visibility">👁️</button>
                    <button type="button" class="key-clear-btn" data-target="key-input-${newIndex}" title="Clear key">&times;</button>
                </div>
            `;
            geminiKeysContainer.appendChild(slotEl);
            attachKeySlotEvents();
            slotEl.querySelector('.key-input').focus();
        });
    }

    // Test & Validate All Keys
    if (testKeysBtn) {
        testKeysBtn.addEventListener('click', async () => {
            const inputs = document.querySelectorAll('#gemini-keys-container .key-input');
            const keysToTest = [];
            inputs.forEach(inp => keysToTest.push(inp.value.trim()));

            if (keysToTest.every(k => !k)) {
                if (keysStatusMsg) {
                    keysStatusMsg.textContent = '⚠️ Please enter at least 1 Gemini API key to test.';
                    keysStatusMsg.className = 'status-message status-error';
                    keysStatusMsg.classList.remove('hidden');
                }
                return;
            }

            if (testBtnText) testBtnText.textContent = 'Testing Keys...';
            if (testKeysLoader) testKeysLoader.classList.remove('hidden');
            testKeysBtn.disabled = true;

            try {
                const res = await fetch(getApiUrl('/api/keys/test'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        geminiKeys: keysToTest,
                        groqKey: groqKeyInput ? groqKeyInput.value.trim() : ''
                    })
                });

                const data = await safeParseResponse(res, 'Test request failed');
                if (!res.ok) throw new Error(data.error || 'Test request failed');

                let validCount = 0;
                if (data.results && data.results.gemini) {
                    data.results.gemini.forEach(item => {
                        const badge = document.getElementById(`key-status-${item.index}`);
                        if (badge) {
                            if (item.status === 'valid') {
                                validCount++;
                                badge.textContent = `🟢 Active (${item.latencyMs}ms)`;
                                badge.className = 'key-status-badge valid';
                            } else if (item.status === 'rate_limited') {
                                badge.textContent = `🟡 429 Quota Exceeded`;
                                badge.className = 'key-status-badge rate_limited';
                            } else if (item.status === 'empty') {
                                badge.textContent = `⚪ Empty Slot`;
                                badge.className = 'key-status-badge untested';
                            } else {
                                badge.textContent = `🔴 ${item.message.substring(0, 24)}`;
                                badge.className = 'key-status-badge invalid';
                            }
                        }
                    });
                }

                if (keysStatusMsg) {
                    keysStatusMsg.textContent = `✅ Validation Complete: ${validCount} of ${keysToTest.filter(k => k).length} Gemini keys are active and ready!`;
                    keysStatusMsg.className = validCount > 0 ? 'status-message status-success' : 'status-message status-error';
                    keysStatusMsg.classList.remove('hidden');
                }
            } catch (err) {
                if (keysStatusMsg) {
                    keysStatusMsg.textContent = `❌ Test Error: ${err.message}`;
                    keysStatusMsg.className = 'status-message status-error';
                    keysStatusMsg.classList.remove('hidden');
                }
            } finally {
                if (testBtnText) testBtnText.textContent = '🧪 Test & Validate Keys';
                if (testKeysLoader) testKeysLoader.classList.add('hidden');
                testKeysBtn.disabled = false;
            }
        });
    }

    // Save & Apply Keys
    if (saveKeysBtn) {
        saveKeysBtn.addEventListener('click', async () => {
            const keys = getEnteredGeminiKeys();
            const groqKey = groqKeyInput ? groqKeyInput.value.trim() : '';
            const ocrKey = ocrKeyInput ? ocrKeyInput.value.trim() : '';
            const backendUrl = backendUrlInput ? backendUrlInput.value.trim() : '';
            const selectedEngine = document.querySelector('input[name="ai-engine-choice"]:checked')?.value || 'auto';

            // Save to localStorage for browser persistence
            localStorage.setItem('certai_gemini_keys', JSON.stringify(keys));
            localStorage.setItem('certai_groq_key', groqKey);
            localStorage.setItem('certai_ocr_key', ocrKey);
            localStorage.setItem('certai_backend_url', backendUrl);
            localStorage.setItem('certai_ai_engine', selectedEngine);

            updateKeysUIBadges(keys.length);

            // Sync to backend in-memory pool
            try {
                const res = await fetch(getApiUrl('/api/keys/save'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        geminiKeys: keys,
                        groqKey,
                        ocrKey,
                        activeEngine: selectedEngine
                    })
                });
                const resData = await safeParseResponse(res, 'Save request failed');

                if (keysStatusMsg) {
                    keysStatusMsg.textContent = `💾 Successfully saved ${keys.length} Gemini keys! Multi-key rotation is active for all extractions.`;
                    keysStatusMsg.className = 'status-message status-success';
                    keysStatusMsg.classList.remove('hidden');
                }
                setTimeout(() => {
                    if (keysModalOverlay) keysModalOverlay.classList.add('hidden');
                }, 1600);
            } catch (err) {
                if (keysStatusMsg) {
                    keysStatusMsg.textContent = `Keys saved locally in browser! (${err.message})`;
                    keysStatusMsg.className = 'status-message status-success';
                    keysStatusMsg.classList.remove('hidden');
                }
            }
        });
    }

    // Clear All Keys
    if (clearKeysBtn) {
        clearKeysBtn.addEventListener('click', () => {
            if (confirm('Clear all stored API keys? You can re-enter new ones at any time.')) {
                localStorage.removeItem('certai_gemini_keys');
                localStorage.removeItem('certai_groq_key');
                localStorage.removeItem('certai_ocr_key');
                renderKeySlots([]);
                updateKeysUIBadges(0);
                if (groqKeyInput) groqKeyInput.value = '';
                if (ocrKeyInput) ocrKeyInput.value = '';
                fetch(getApiUrl('/api/keys/save'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ geminiKeys: [], groqKey: '', ocrKey: '' })
                }).catch(() => {});
                if (keysStatusMsg) {
                    keysStatusMsg.textContent = 'All API keys cleared.';
                    keysStatusMsg.className = 'status-message status-info';
                    keysStatusMsg.classList.remove('hidden');
                }
            }
        });
    }

    // Deployment Guide Modal Listeners
    if (openDeployModalBtn) {
        openDeployModalBtn.addEventListener('click', () => {
            if (deployModalOverlay) deployModalOverlay.classList.remove('hidden');
        });
    }
    if (deployModalCloseBtn) {
        deployModalCloseBtn.addEventListener('click', () => {
            if (deployModalOverlay) deployModalOverlay.classList.add('hidden');
        });
    }
    if (deployCloseBtn) {
        deployCloseBtn.addEventListener('click', () => {
            if (deployModalOverlay) deployModalOverlay.classList.add('hidden');
        });
    }
    if (deployModalOverlay) {
        deployModalOverlay.addEventListener('click', (e) => {
            if (e.target === deployModalOverlay) deployModalOverlay.classList.add('hidden');
        });
    }

    // Deployment Tabs Switcher
    deployTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            deployTabBtns.forEach(b => b.classList.remove('active'));
            deployTabContents.forEach(c => {
                c.classList.remove('active');
                c.classList.add('hidden');
            });

            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.classList.remove('hidden');
                targetEl.classList.add('active');
            }
        });
    });

    loadSavedKeys();

    // ---- NAVIGATION LOGIC ----
    const navItems = document.querySelectorAll('.nav-item');
    const ctaBtns = document.querySelectorAll('.cta-btn');
    const pageSections = document.querySelectorAll('.page-section');
    const mobileToggleBtn = document.getElementById('mobile-toggle-btn');
    const mainNavLinks = document.getElementById('main-nav-links');

    if (mobileToggleBtn && mainNavLinks) {
        mobileToggleBtn.addEventListener('click', () => {
            mainNavLinks.classList.toggle('open');
        });

        document.addEventListener('click', (e) => {
            if (!mobileToggleBtn.contains(e.target) && !mainNavLinks.contains(e.target)) {
                mainNavLinks.classList.remove('open');
            }
        });
    }
    
    // Function to change active page
    function navigateToPage(targetId) {
        if (!targetId) return;

        if (mainNavLinks) {
            mainNavLinks.classList.remove('open');
        }

        // Update nav links
        navItems.forEach(item => {
            if (item.getAttribute('data-target') === targetId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Show target section, hide others
        pageSections.forEach(section => {
            if (section.id === targetId) {
                section.classList.add('active');
            } else {
                section.classList.remove('active');
            }
        });

        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Handle initial hash check on load
    const currentHash = window.location.hash.replace('#', '');
    if (currentHash) {
        const validSection = document.getElementById(currentHash);
        if (validSection && validSection.classList.contains('page-section')) {
            navigateToPage(currentHash);
        }
    }

    // Handle hash changes (back/forward browser buttons)
    window.addEventListener('hashchange', () => {
        const newHash = window.location.hash.replace('#', '');
        if (newHash) {
            navigateToPage(newHash);
        }
    });

    // Nav click handlers
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // No preventDefault here so the hash updates in the URL naturally
            const targetId = item.getAttribute('data-target');
            navigateToPage(targetId);
        });
    });

    // CTA button handlers
    ctaBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // We can prevent default here or not, but navigateToPage is still needed
            const targetId = btn.getAttribute('data-target');
            if (targetId) {
                window.location.hash = targetId; // Manually update hash for CTA buttons
                navigateToPage(targetId);
            }
        });
    });


    // ---- FILE UPLOAD & BATCH EXTRACTION LOGIC ----
    const form = document.getElementById('extraction-form');
    const imageInput = document.getElementById('imageUpload');
    const zipInput = document.getElementById('zipUpload');
    const fileChosenText = document.getElementById('file-chosen-text');
    const zipChosenText = document.getElementById('zip-chosen-text');
    const wrapper = document.querySelector('.file-upload-wrapper');
    const submitBtn = document.getElementById('submit-btn');
    const btnText = submitBtn.querySelector('.btn-text');
    const loader = submitBtn.querySelector('.loader');
    const statusMessage = document.getElementById('status-message');
    const folderModeCheckbox = document.getElementById('folderModeCheckbox');
    const uploadLabel = document.getElementById('upload-label');

    // Upload Modes & Tabs
    let currentUploadMode = 'files';
    const uploadTabs = document.querySelectorAll('.upload-tab');
    const uploadGroups = document.querySelectorAll('.upload-group');

    // Batch UI Elements
    const batchProgressSection = document.getElementById('batch-progress-section');
    const batchProgressBar = document.getElementById('batch-progress-bar');
    const batchPercentText = document.getElementById('batch-percent-text');
    const batchStatusHeading = document.getElementById('batch-status-heading');
    const batchTotalCount = document.getElementById('batch-total-count');
    const batchProcessedCount = document.getElementById('batch-processed-count');
    const batchDuplicateCount = document.getElementById('batch-duplicate-count');
    const batchErrorCount = document.getElementById('batch-error-count');
    const batchLogList = document.getElementById('batch-log-list');
    const batchPauseBtn = document.getElementById('batch-pause-btn');
    const batchCancelBtn = document.getElementById('batch-cancel-btn');

    let isBatchPaused = false;
    let isBatchCancelled = false;

    const emptyState = document.getElementById('empty-state');
    const resultsContent = document.getElementById('results-content');
    const resultsTableBody = document.querySelector('#results-table tbody');

    // Latest Result Elements
    const latestResultSection = document.getElementById('latest-result-section');
    const latestResultTableBody = document.querySelector('#latest-result-table tbody');
    const latestRawTextContainer = document.getElementById('latest-raw-text-container');

    // Reports Table Elements
    const reportsEmptyState = document.getElementById('reports-empty-state');
    const reportsContent = document.getElementById('reports-content');
    const reportsTableBody = document.querySelector('#reports-table tbody');

    // Tab switching handler
    uploadTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            uploadTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentUploadMode = tab.getAttribute('data-mode');

            uploadGroups.forEach(group => {
                if (group.id === `group-${currentUploadMode}`) {
                    group.classList.remove('hidden');
                } else {
                    group.classList.add('hidden');
                }
            });
        });
    });

    // Folder selection checkbox handler
    if (folderModeCheckbox) {
        folderModeCheckbox.addEventListener('change', () => {
            if (folderModeCheckbox.checked) {
                imageInput.setAttribute('webkitdirectory', '');
                imageInput.setAttribute('directory', '');
                if (uploadLabel) uploadLabel.textContent = 'Select Certificate Folder (Subfolders & Files)';
                fileChosenText.textContent = 'Click to select a folder containing 200–400 certificates';
            } else {
                imageInput.removeAttribute('webkitdirectory');
                imageInput.removeAttribute('directory');
                if (uploadLabel) uploadLabel.textContent = 'Upload Certificate Images / Bulk Selection';
                updateFileText();
            }
        });
    }

    // Drag and drop styles
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        if (wrapper) wrapper.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    if (wrapper) {
        ['dragenter', 'dragover'].forEach(eventName => {
            wrapper.addEventListener(eventName, () => wrapper.classList.add('dragover'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            wrapper.addEventListener(eventName, () => wrapper.classList.remove('dragover'), false);
        });

        wrapper.addEventListener('drop', (e) => {
            let dt = e.dataTransfer;
            if (currentUploadMode === 'files') {
                imageInput.files = dt.files;
                updateFileText();
            } else if (currentUploadMode === 'zip' && zipInput) {
                zipInput.files = dt.files;
                updateZipText();
            }
        });
    }

    // Update file input text
    imageInput.addEventListener('change', updateFileText);

    function updateFileText() {
        if (imageInput.files.length === 1) {
            fileChosenText.textContent = imageInput.files[0].name;
            fileChosenText.style.color = 'var(--primary-color)';
        } else if (imageInput.files.length > 1) {
            fileChosenText.textContent = `📁 ${imageInput.files.length} Certificate Files Selected! Ready for Bulk Extraction.`;
            fileChosenText.style.color = 'var(--primary-color)';
        } else {
            fileChosenText.textContent = 'Drag & drop 200–400 certificates or click to browse';
            fileChosenText.style.color = 'var(--text-primary)';
        }
    }

    if (zipInput) {
        zipInput.addEventListener('change', updateZipText);
    }

    function updateZipText() {
        if (zipInput && zipInput.files.length > 0) {
            const file = zipInput.files[0];
            const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
            zipChosenText.textContent = `📦 ${file.name} (${sizeMB} MB)`;
            zipChosenText.style.color = 'var(--primary-color)';
        } else if (zipChosenText) {
            zipChosenText.textContent = 'Drag & drop .ZIP file or click to browse';
            zipChosenText.style.color = 'var(--text-primary)';
        }
    }

    // Batch Logger Helper
    function addBatchLog(msg, type = 'info') {
        if (!batchLogList) return;
        const div = document.createElement('div');
        div.className = `log-item ${type}`;
        const time = new Date().toLocaleTimeString();
        div.textContent = `[${time}] ${msg}`;
        batchLogList.appendChild(div);
        batchLogList.scrollTop = batchLogList.scrollHeight;
    }

    // Reset Batch Progress UI
    function resetBatchUI(total = 0) {
        if (!batchProgressSection) return;
        batchProgressSection.classList.remove('hidden');
        batchProgressBar.style.width = '0%';
        batchPercentText.textContent = '0%';
        batchTotalCount.textContent = total;
        batchProcessedCount.textContent = '0';
        batchDuplicateCount.textContent = '0';
        batchErrorCount.textContent = '0';
        batchLogList.innerHTML = '';
        isBatchPaused = false;
        isBatchCancelled = false;
        if (batchPauseBtn) batchPauseBtn.textContent = 'Pause';
    }

    // Pause & Cancel controls
    if (batchPauseBtn) {
        batchPauseBtn.addEventListener('click', () => {
            isBatchPaused = !isBatchPaused;
            batchPauseBtn.textContent = isBatchPaused ? 'Resume' : 'Pause';
            addBatchLog(isBatchPaused ? '⏸️ Batch processing paused by user.' : '▶️ Resuming batch processing...', 'warn');
        });
    }

    if (batchCancelBtn) {
        batchCancelBtn.addEventListener('click', () => {
            isBatchCancelled = true;
            addBatchLog('🛑 Batch processing cancelled by user.', 'error');
            batchStatusHeading.textContent = 'Batch Cancelled';
        });
    }

    // Clear Excel Spreadsheet & Reset Cache Button Handler
    const clearDbBtn = document.getElementById('clear-db-btn');
    if (clearDbBtn) {
        clearDbBtn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to clear the Excel spreadsheet and cached records? This will allow you to start a fresh batch of certificate extractions.')) return;
            try {
                const res = await fetch(getApiUrl('/api/clear-db'), { method: 'POST' });
                const data = await safeParseResponse(res, 'Failed to reset Excel spreadsheet.');
                showStatus(data.message || 'Excel spreadsheet and cache reset successfully!', 'success');
                fetchAllRecords();
                fetchDashboardStats();
            } catch (err) {
                showStatus('Failed to reset Excel spreadsheet: ' + err.message, 'error');
            }
        });
    }

    // Form Submission Router
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideStatus();

        if (currentUploadMode === 'files') {
            const files = Array.from(imageInput.files).filter(f => f.type.startsWith('image/') || f.type.includes('pdf') || f.name.match(/\.(jpg|jpeg|png|webp|pdf)$/i));
            if (files.length === 0) {
                showStatus('Please select one or more certificate files (JPG, PNG, WEBP, PDF).', 'error');
                return;
            }

            if (files.length === 1) {
                await processSingleFileUpload(files[0]);
            } else {
                await processBulkMultiFiles(files);
            }
        } else if (currentUploadMode === 'zip') {
            const zipFile = zipInput ? zipInput.files[0] : null;
            if (!zipFile) {
                showStatus('Please select a .ZIP archive file.', 'error');
                return;
            }
            await processZipUpload(zipFile);
        } else if (currentUploadMode === 'drive') {
            const driveLink = document.getElementById('driveLink').value.trim();
            if (!driveLink) {
                showStatus('Please enter a Google Drive file or folder URL.', 'error');
                return;
            }
            await processDriveUpload(driveLink);
        }
    });

    // Single File Processor
    async function processSingleFileUpload(file) {
        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('image', file);

            const response = await fetch(getApiUrl('/api/extract'), {
                method: 'POST',
                headers: getFacultyAuthHeaders(),
                body: formData
            });

            const result = await safeParseResponse(response, 'Failed to process certificate.');
            if (!response.ok) throw new Error(result.error || 'Failed to process certificate.');

            if (result.isDuplicate) {
                showStatus('ℹ️ Certificate already processed! Loaded existing record directly.', 'info');
            } else {
                showStatus('Extraction successful! Certificate saved to Excel spreadsheet.', 'success');
                addResultToTable(result);
            }

            showLatestResult(result);
            fetchAllRecords();
            fetchDashboardStats();

            setTimeout(() => {
                form.reset();
                updateFileText();
            }, 2000);

        } catch (error) {
            showStatus(error.message, 'error');
        } finally {
            setLoading(false);
        }
    }

    // Fast Client-Side Image Compression (< 0.01s per image)
    async function compressFileOnClient(file) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf') || file.size < 100 * 1024) {
            return file; // Pass PDFs and small files through directly
        }
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxDim = 1400;
                let width = img.width;
                let height = img.height;

                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(new File([blob], file.name, { type: 'image/jpeg' }));
                    } else {
                        resolve(file);
                    }
                }, 'image/jpeg', 0.85);
            };
            img.onerror = () => resolve(file);
            img.src = URL.createObjectURL(file);
        });
    }

    // Bulk Multi-File Processor (Processes 100–300 certificates in < 40 seconds)
    async function processBulkMultiFiles(files) {
        const totalFiles = files.length;
        resetBatchUI(totalFiles);
        addBatchLog(`🚀 Starting ultra-high speed bulk extraction engine for ${totalFiles} certificates...`, 'info');
        batchStatusHeading.textContent = `Processing 0 / ${totalFiles} Certificates...`;

        setLoading(true);

        const chunkSize = 25; // 25 parallel files per micro-batch chunk for sub-40s processing
        let processedCount = 0;
        let successCount = 0;
        let duplicateCount = 0;
        let errorCount = 0;

        for (let i = 0; i < files.length; i += chunkSize) {
            if (isBatchCancelled) {
                addBatchLog(`Stopped batch processing at file ${processedCount}/${totalFiles}.`, 'error');
                break;
            }

            while (isBatchPaused) {
                await new Promise(r => setTimeout(r, 500));
                if (isBatchCancelled) break;
            }

            const rawChunk = files.slice(i, i + chunkSize);
            addBatchLog(`⚡ Fast-compressing & uploading chunk (${i + 1} to ${Math.min(i + chunkSize, totalFiles)} of ${totalFiles})...`, 'info');

            // Compress chunk images on client side in parallel before upload
            const compressedChunk = await Promise.all(rawChunk.map(f => compressFileOnClient(f)));
            const formData = new FormData();
            compressedChunk.forEach(f => formData.append('images', f));

            try {
                const response = await fetch(getApiUrl('/api/extract-batch'), {
                    method: 'POST',
                    headers: getFacultyAuthHeaders(),
                    body: formData
                });

                const result = await safeParseResponse(response, 'Failed to process batch.');

                if (!response.ok) {
                    errorCount += rawChunk.length;
                    addBatchLog(`❌ Chunk error: ${result.error || 'Server error'}`, 'error');
                } else {
                    duplicateCount += result.duplicatesCount || 0;
                    const newExtracted = result.newCount || 0;
                    successCount += newExtracted;

                    addBatchLog(`✅ Chunk complete! (${newExtracted} new extracted, ${result.duplicatesCount || 0} duplicates cached).`, 'success');

                    if (result.batchData && result.batchData.length > 0) {
                        const lastItem = result.batchData[result.batchData.length - 1];
                        showLatestResult({ isBatch: true, data: lastItem });
                        if (lastItem.ai_engine_used) {
                            addBatchLog(`🔄 Processed via: ${lastItem.ai_engine_used}`, 'info');
                        }
                    }
                }
            } catch (err) {
                errorCount += rawChunk.length;
                addBatchLog(`❌ Chunk network failure: ${err.message}`, 'error');
            }

            processedCount += rawChunk.length;
            const pct = Math.round((processedCount / totalFiles) * 100);
            batchProgressBar.style.width = `${pct}%`;
            batchPercentText.textContent = `${pct}%`;
            batchProcessedCount.textContent = processedCount;
            batchDuplicateCount.textContent = duplicateCount;
            batchErrorCount.textContent = errorCount;
            batchStatusHeading.textContent = `Processing ${processedCount} / ${totalFiles} Certificates...`;

            fetchAllRecords();
            fetchDashboardStats();
        }

        setLoading(false);
        if (!isBatchCancelled) {
            batchStatusHeading.textContent = `✅ Batch Complete! Processed ${processedCount} Certificates.`;
            addBatchLog(`🎉 Bulk Extraction Finished! Total: ${totalFiles} | New Extracted: ${successCount} | Duplicates: ${duplicateCount} | Errors: ${errorCount}`, 'success');
            showStatus(`✅ Bulk extraction finished! Processed ${processedCount} certificates into Excel spreadsheet.`, 'success');
        }
    }

    // ZIP Archive Upload Processor
    async function processZipUpload(zipFile) {
        resetBatchUI(1);
        addBatchLog(`📦 Uploading & extracting ZIP archive '${zipFile.name}'...`, 'info');
        batchStatusHeading.textContent = `Extracting ZIP Archive...`;
        setLoading(true);

        try {
            const formData = new FormData();
            formData.append('zipFile', zipFile);

            const response = await fetch(getApiUrl('/api/extract-zip'), {
                method: 'POST',
                headers: getFacultyAuthHeaders(),
                body: formData
            });

            const result = await safeParseResponse(response, 'Failed to process ZIP archive.');

            if (!response.ok) {
                throw new Error(result.error || 'Failed to process ZIP archive.');
            }

            const total = result.totalProcessed || 0;
            batchTotalCount.textContent = total;
            batchProcessedCount.textContent = total;
            batchDuplicateCount.textContent = result.duplicatesCount || 0;
            batchErrorCount.textContent = 0;
            batchProgressBar.style.width = '100%';
            batchPercentText.textContent = '100%';
            batchStatusHeading.textContent = `✅ ZIP Extraction Complete!`;

            addBatchLog(`✅ Extracted & processed ${total} certificates from ZIP! (${result.newCount} new, ${result.duplicatesCount} cached duplicates)`, 'success');
            showStatus(`✅ Processed ${total} certificates from ZIP archive into Excel spreadsheet!`, 'success');

            if (result.batchData && result.batchData.length > 0) {
                showLatestResult({ isBatch: true, data: result.batchData[0] });
            }

            fetchAllRecords();
            fetchDashboardStats();

        } catch (err) {
            addBatchLog(`❌ ZIP Error: ${err.message}`, 'error');
            showStatus(err.message, 'error');
        } finally {
            setLoading(false);
        }
    }

    // Google Drive Link Processor
    async function processDriveUpload(driveLink) {
        resetBatchUI(1);
        addBatchLog(`🔗 Fetching and extracting certificates from Google Drive...`, 'info');
        batchStatusHeading.textContent = `Connecting to Google Drive...`;
        setLoading(true);

        try {
            const formData = new FormData();
            formData.append('driveLink', driveLink);

            const response = await fetch(getApiUrl('/api/extract'), {
                method: 'POST',
                headers: getFacultyAuthHeaders(),
                body: formData
            });

            const result = await safeParseResponse(response, 'Failed to process Google Drive link.');
            if (!response.ok) throw new Error(result.error || 'Failed to process Google Drive link.');

            if (result.isBatch) {
                const total = result.totalProcessed || 0;
                batchTotalCount.textContent = total;
                batchProcessedCount.textContent = total;
                batchProgressBar.style.width = '100%';
                batchPercentText.textContent = '100%';
                batchStatusHeading.textContent = `✅ Drive Folder Extraction Complete!`;
                addBatchLog(`✅ Drive folder extraction finished! Processed ${total} certificates.`, 'success');
                showStatus(`✅ Processed ${total} certificates from Google Drive folder!`, 'success');
            } else if (result.isDuplicate) {
                showStatus('ℹ️ Certificate already processed! Loaded existing record.', 'info');
                addBatchLog(`ℹ️ Loaded cached record from Excel.`, 'info');
            } else {
                showStatus('Extraction successful! Certificate saved to Excel spreadsheet.', 'success');
                addBatchLog(`✅ Single certificate extracted successfully!`, 'success');
            }

            showLatestResult(result);
            fetchAllRecords();
            fetchDashboardStats();

        } catch (err) {
            addBatchLog(`❌ Drive Error: ${err.message}`, 'error');
            showStatus(err.message, 'error');
        } finally {
            setLoading(false);
        }
    }

    let loadingInterval;
    const loadingMessages = [
        "Processing with Gemini Flash VLM...",
        "Visually reading text & dates...",
        "Identifying ranks & high achievers...",
        "Writing to Excel spreadsheet..."
    ];

    function setLoading(isLoading) {
        submitBtn.disabled = isLoading;
        if (isLoading) {
            loader.style.display = 'block';
            submitBtn.style.opacity = '0.8';
            submitBtn.style.cursor = 'not-allowed';
            submitBtn.classList.remove('btn-glow');
            
            btnText.style.display = 'block';
            btnText.textContent = loadingMessages[0];
            let msgIdx = 1;
            loadingInterval = setInterval(() => {
                if(msgIdx < loadingMessages.length) {
                    btnText.textContent = loadingMessages[msgIdx];
                    msgIdx++;
                }
            }, 1200); // Update text every 1.2 seconds
        } else {
            clearInterval(loadingInterval);
            btnText.textContent = "Extract Data Now";
            btnText.style.display = 'block';
            loader.style.display = 'none';
            submitBtn.style.opacity = '1';
            submitBtn.style.cursor = 'pointer';
            submitBtn.classList.add('btn-glow');
        }
    }

    function showStatus(text, type) {
        statusMessage.textContent = text;
        statusMessage.className = `status-message status-${type}`;
        statusMessage.classList.remove('hidden');
    }

    function hideStatus() {
        statusMessage.classList.add('hidden');
    }

    function getRankBadgeHTML(rankPosition) {
        if (!rankPosition || rankPosition === 'N/A') {
            return `<span style="color: var(--text-secondary); font-size: 0.82rem;">N/A</span>`;
        }
        const lower = rankPosition.toLowerCase();

        if (lower.includes('1st') || lower.includes('first') || lower.includes('gold') || (lower.includes('winner') && !lower.includes('runner'))) {
            return `<span class="rank-badge rank-1st">🥇 ${escapeHTML(rankPosition)}</span>`;
        } else if (lower.includes('2nd') || lower.includes('second') || lower.includes('silver') || lower.includes('1st runner') || lower.includes('runner-up') || lower.includes('runner up')) {
            return `<span class="rank-badge rank-2nd">🥈 ${escapeHTML(rankPosition)}</span>`;
        } else if (lower.includes('3rd') || lower.includes('third') || lower.includes('bronze') || lower.includes('2nd runner')) {
            return `<span class="rank-badge rank-3rd">🥉 ${escapeHTML(rankPosition)}</span>`;
        } else if (lower.includes('4th') || lower.includes('fourth') || lower.includes('5th') || lower.includes('fifth') || lower.includes('6th') || lower.includes('sixth') || lower.includes('7th') || lower.includes('eighth') || lower.includes('ninth') || lower.includes('tenth') || lower.includes('rank') || lower.includes('prize') || lower.includes('place')) {
            return `<span class="rank-badge rank-nth">🏅 ${escapeHTML(rankPosition)}</span>`;
        } else if (lower.includes('distinction') || lower.includes('excellence') || lower.includes('honor') || lower.includes('achiever') || lower.includes('outstanding')) {
            return `<span class="rank-badge rank-distinction">🎖️ ${escapeHTML(rankPosition)}</span>`;
        } else {
            return `<span class="rank-badge rank-general">🏆 ${escapeHTML(rankPosition)}</span>`;
        }
    }

    function isHighAchiever(data) {
        if (!data) return false;
        const text = typeof data === 'string' ? data : `${data.Achievement || ''} ${data.Rank_Position || ''} ${data.Details || ''}`;
        if (!text || text === 'N/A') return false;
        const lower = text.toLowerCase();
        const keywords = ['merit', 'winner', 'excellence', '1st', 'first', '2nd', 'second', '3rd', 'third', 'gold', 'silver', 'bronze', 'distinction', 'rank', 'outstanding', 'best', 'runner', 'place', 'position', 'honor', 'prize'];
        return keywords.some(keyword => lower.includes(keyword));
    }

    function addResultToTable(result) {
        const data = result.data;
        
        // Hide empty state, show results
        emptyState.classList.add('hidden');
        resultsContent.classList.remove('hidden');
        
        // Append row to HTML table
        const tr = document.createElement('tr');
        
        tr.innerHTML = `
            <td><strong>${escapeHTML(data.Name_of_Student)}</strong></td>
            <td>${escapeHTML(data.Activity_Event)}</td>
            <td>${escapeHTML(data.Organized_by)}</td>
            <td><span class="badge-mini">${escapeHTML(data.Domain)}</span></td>
            <td>${escapeHTML(data.From_Date)}</td>
            <td>${escapeHTML(data.To_Date)}</td>
            <td>${escapeHTML(data.Venue || 'N/A')}</td>
            <td>${escapeHTML(data.Level || 'N/A')}</td>
            <td>${data.Google_Drive_Link && data.Google_Drive_Link !== 'N/A' ? `<a href="${escapeHTML(data.Google_Drive_Link)}" target="_blank" style="color:var(--primary-color); word-break:break-all;">${escapeHTML(data.Google_Drive_Link)}</a>` : 'N/A'}</td>
            <td>${getRankBadgeHTML(data.Rank_Position)}</td>
            <td><span class="achievement-badge">${escapeHTML(data.Achievement)}</span></td>
        `;
        
        // Prepend so newest is on top
        if (resultsTableBody.firstChild) {
            resultsTableBody.insertBefore(tr, resultsTableBody.firstChild);
        } else {
            resultsTableBody.appendChild(tr);
        }

        // Check if High Achiever to add to Special Report
        if (isHighAchiever(data)) {
            addResultToReportTable(data);
        }
    }

    function showLatestResult(result) {
        latestResultSection.classList.remove('hidden');
        
        // Clear previous latest result
        latestResultTableBody.innerHTML = '';

        if (result.isBatch && Array.isArray(result.batchData)) {
            result.batchData.forEach(data => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${escapeHTML(data.Name_of_Student)}</strong></td>
                    <td>${escapeHTML(data.Activity_Event)}</td>
                    <td>${escapeHTML(data.Organized_by)}</td>
                    <td><span class="badge-mini">${escapeHTML(data.Domain)}</span></td>
                    <td>${escapeHTML(data.From_Date)}</td>
                    <td>${escapeHTML(data.To_Date)}</td>
                    <td>${escapeHTML(data.Venue || 'N/A')}</td>
                    <td>${escapeHTML(data.Level || 'N/A')}</td>
                    <td>${getRankBadgeHTML(data.Rank_Position)}</td>
                    <td><span style="display:inline-block; padding: 6px 12px; border-radius: 20px; background: rgba(16, 185, 129, 0.15); color: #059669; font-size: 0.8rem; font-weight: 700; border: 1px solid rgba(16,185,129,0.3)">${escapeHTML(data.Achievement)}</span></td>
                `;
                latestResultTableBody.appendChild(tr);
            });
        } else if (result.data) {
            const data = result.data;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHTML(data.Name_of_Student)}</strong></td>
                <td>${escapeHTML(data.Activity_Event)}</td>
                <td>${escapeHTML(data.Organized_by)}</td>
                <td><span class="badge-mini">${escapeHTML(data.Domain)}</span></td>
                <td>${escapeHTML(data.From_Date)}</td>
                <td>${escapeHTML(data.To_Date)}</td>
                <td>${escapeHTML(data.Venue || 'N/A')}</td>
                <td>${escapeHTML(data.Level || 'N/A')}</td>
                <td>${getRankBadgeHTML(data.Rank_Position)}</td>
                <td><span style="display:inline-block; padding: 6px 12px; border-radius: 20px; background: rgba(16, 185, 129, 0.15); color: #059669; font-size: 0.8rem; font-weight: 700; border: 1px solid rgba(16,185,129,0.3)">${escapeHTML(data.Achievement)}</span></td>
            `;
            latestResultTableBody.appendChild(tr);
        }

        // Add Raw Text below the mini-table
        latestRawTextContainer.innerHTML = '';
        let rawDiv = document.createElement('div');
        rawDiv.style.padding = '15px';
        rawDiv.style.background = 'rgba(0,0,0,0.03)';
        rawDiv.style.borderRadius = '12px';
        rawDiv.style.border = '1px solid var(--border-color)';
        rawDiv.style.fontFamily = 'monospace';
        rawDiv.style.whiteSpace = 'pre-wrap';
        rawDiv.style.fontSize = '0.85rem';
        rawDiv.style.color = 'var(--text-secondary)';
        
        rawDiv.innerHTML = `<strong>Raw OCR Output:</strong><br/>` + escapeHTML(result.rawText || 'No raw text provided.');
        latestRawTextContainer.appendChild(rawDiv);
    }

    let topPerformersData = [];
    let activeRankFilter = 'all';

    function renderHistoryTable(records) {
        if (!resultsTableBody) return;
        resultsTableBody.innerHTML = '';

        if (!records || records.length === 0) {
            emptyState.classList.remove('hidden');
            resultsContent.classList.add('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        resultsContent.classList.remove('hidden');

        records.forEach(data => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHTML(data.Name_of_Student)}</strong></td>
                <td>${escapeHTML(data.Activity_Event)}</td>
                <td>${escapeHTML(data.Organized_by)}</td>
                <td><span class="badge-mini">${escapeHTML(data.Domain)}</span></td>
                <td>${escapeHTML(data.From_Date)}</td>
                <td>${escapeHTML(data.To_Date)}</td>
                <td>${escapeHTML(data.Venue || 'N/A')}</td>
                <td>${escapeHTML(data.Level || 'N/A')}</td>
                <td>${data.Google_Drive_Link && data.Google_Drive_Link !== 'N/A' ? `<a href="${escapeHTML(data.Google_Drive_Link)}" target="_blank" style="color:var(--primary-color); word-break:break-all;">${escapeHTML(data.Google_Drive_Link)}</a>` : 'N/A'}</td>
                <td>${getRankBadgeHTML(data.Rank_Position)}</td>
                <td><span class="achievement-badge">${escapeHTML(data.Achievement)}</span></td>
            `;
            resultsTableBody.appendChild(tr);
        });
    }

    function renderMeritPage(records) {
        const meritRecords = (records || []).filter(r => isHighAchiever(r));
        topPerformersData = meritRecords;

        // Compute Merit KPI Stats
        let totalCount = meritRecords.length;
        let firstRankCount = 0;
        let runnersUpCount = 0;
        let distinctionCount = 0;

        meritRecords.forEach(r => {
            const text = `${r.Rank_Position || ''} ${r.Achievement || ''}`.toLowerCase();
            if (text.includes('1st') || text.includes('first') || text.includes('gold') || (text.includes('winner') && !text.includes('runner'))) {
                firstRankCount++;
            } else if (text.includes('2nd') || text.includes('3rd') || text.includes('second') || text.includes('third') || text.includes('runner') || text.includes('silver') || text.includes('bronze')) {
                runnersUpCount++;
            } else if (text.includes('distinction') || text.includes('excellence') || text.includes('honor')) {
                distinctionCount++;
            }
        });

        const totalEl = document.getElementById('merit-stat-total');
        const firstEl = document.getElementById('merit-stat-1st');
        const runnerEl = document.getElementById('merit-stat-runners');
        const distEl = document.getElementById('merit-stat-distinction');

        if (totalEl) totalEl.textContent = totalCount;
        if (firstEl) firstEl.textContent = firstRankCount;
        if (runnerEl) runnerEl.textContent = runnersUpCount;
        if (distEl) distEl.textContent = distinctionCount;

        // Filter merit records by active pill and search query
        const searchQuery = (document.getElementById('merit-search-input')?.value || '').toLowerCase().trim();

        let filteredMerit = meritRecords.filter(r => {
            const rankText = `${r.Rank_Position || ''} ${r.Achievement || ''}`.toLowerCase();

            if (activeRankFilter === '1st') {
                if (!rankText.includes('1st') && !rankText.includes('first') && !rankText.includes('gold') && !(rankText.includes('winner') && !rankText.includes('runner'))) return false;
            } else if (activeRankFilter === 'runner') {
                if (!rankText.includes('2nd') && !rankText.includes('3rd') && !rankText.includes('second') && !rankText.includes('third') && !rankText.includes('runner') && !rankText.includes('silver') && !rankText.includes('bronze')) return false;
            } else if (activeRankFilter === 'distinction') {
                if (!rankText.includes('distinction') && !rankText.includes('excellence') && !rankText.includes('honor')) return false;
            }

            if (searchQuery) {
                const searchHaystack = `${r.Name_of_Student || ''} ${r.Activity_Event || ''} ${r.Organized_by || ''} ${r.Details || ''} ${r.Rank_Position || ''} ${r.Achievement || ''}`.toLowerCase();
                if (!searchHaystack.includes(searchQuery)) return false;
            }

            return true;
        });

        if (!reportsTableBody) return;
        reportsTableBody.innerHTML = '';

        if (filteredMerit.length === 0) {
            reportsEmptyState.classList.remove('hidden');
            reportsContent.classList.add('hidden');
            return;
        }

        reportsEmptyState.classList.add('hidden');
        reportsContent.classList.remove('hidden');

        filteredMerit.forEach(data => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHTML(data.Name_of_Student)}</strong></td>
                <td>${getRankBadgeHTML(data.Rank_Position)}</td>
                <td><span class="achievement-badge alt">${escapeHTML(data.Achievement)}</span></td>
                <td><strong>${escapeHTML(data.Activity_Event)}</strong><br/><small style="color: var(--text-secondary);">${escapeHTML(data.Details || 'N/A')}</small></td>
                <td><span class="badge-mini">${escapeHTML(data.Domain)}</span></td>
                <td>${escapeHTML(data.Organized_by)}</td>
            `;
            reportsTableBody.appendChild(tr);
        });
    }

    // Export Top Performers to Full Excel
    const exportTopBtn = document.getElementById('export-top-performers-btn');
    if (exportTopBtn) {
        exportTopBtn.addEventListener('click', async () => {
            if (topPerformersData.length === 0) {
                alert('No high achievers to export yet.');
                return;
            }

            // Generate using ExcelJS
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Top Performers');

            worksheet.columns = [
                { header: 'Sl. No.', key: 'Sl_No', width: 8 },
                { header: 'Name of Student', key: 'Name_of_Student', width: 25 },
                { header: 'Activity / Event', key: 'Activity_Event', width: 20 },
                { header: 'Details', key: 'Details', width: 35 },
                { header: 'Organized by', key: 'Organized_by', width: 25 },
                { header: 'From Date', key: 'From_Date', width: 12 },
                { header: 'To Date', key: 'To_Date', width: 12 },
                { header: 'Venue', key: 'Venue', width: 20 },
                { header: 'Level\n(State/National/International)', key: 'Level', width: 20 },
                { header: '(Google Drive Link)', key: 'Google_Drive_Link', width: 15 },
                { header: 'Achievement', key: 'Achievement', width: 20 },
                { header: 'Rank / Position', key: 'Rank_Position', width: 22 }
            ];

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, name: 'Times New Roman' };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            headerRow.height = 40;
            
            headerRow.eachCell({ includeEmpty: true }, function(cell) {
                cell.border = {
                    top: {style:'medium'}, left: {style:'medium'},
                    bottom: {style:'medium'}, right: {style:'medium'}
                };
            });
            
            const achievementCell = worksheet.getCell('K1');
            achievementCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF5E35B1' }
            };
            achievementCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Times New Roman' };

            const rankCell = worksheet.getCell('L1');
            rankCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFB71C1C' }
            };
            rankCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Times New Roman' };

            topPerformersData.forEach((data, index) => {
                const addedRow = worksheet.addRow([
                    index + 1,
                    data.Name_of_Student || 'N/A',
                    data.Activity_Event || 'N/A',
                    data.Details || 'N/A',
                    data.Organized_by || 'N/A',
                    data.From_Date || 'N/A',
                    data.To_Date || 'N/A',
                    data.Venue || 'N/A',
                    data.Level || 'N/A',
                    data.Google_Drive_Link || 'N/A',
                    data.Achievement || 'N/A',
                    data.Rank_Position || 'N/A'
                ]);

                addedRow.height = 35;
                addedRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                addedRow.font = { name: 'Times New Roman' };
                
                addedRow.eachCell({ includeEmpty: true }, function(cell, colNumber) {
                    cell.border = {
                        top: {style:'thin'}, left: {style:'medium'},
                        bottom: {style:'thin'}, right: {style:'medium'}
                    };
                    if (colNumber === 10 && cell.value && cell.value !== 'N/A') {
                        cell.value = { text: cell.value.toString(), hyperlink: cell.value.toString() };
                        cell.font = { color: { argb: 'FF0000FF' }, underline: true, name: 'Times New Roman' };
                    }
                });
            });

            // generate file using exceljs
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Top_Performers_Report.xlsx';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        });
    }

    function addResultToReportTable(data) {
        renderMeritPage(allRecords);
    }

    // Rank filter pill listeners
    document.querySelectorAll('.rank-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.rank-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeRankFilter = btn.getAttribute('data-rank-filter');
            renderMeritPage(allRecords);
        });
    });

    // Merit search listener
    const meritSearchInput = document.getElementById('merit-search-input');
    if (meritSearchInput) {
        meritSearchInput.addEventListener('input', () => {
            renderMeritPage(allRecords);
        });
    }

    // ---- ANALYTICS & MANAGEMENT LOGIC ----
    let allRecords = [];
    const studentSearchInput = document.getElementById('student-search');
    const suggestionsDropdown = document.getElementById('search-suggestions');
    const analyticsContent = document.getElementById('analytics-content');
    const analyticsEmpty = document.getElementById('analytics-empty');

    async function fetchAllRecords() {
        try {
            const response = await fetch(getApiUrl('/api/records'));
            const data = await safeParseResponse(response, 'Failed to load records.');
            allRecords = Array.isArray(data) ? data : [];
            console.log("Records loaded:", allRecords.length);
            
            renderHistoryTable(allRecords);
            renderMeritPage(allRecords);
        } catch (error) {
            console.error("Failed to fetch records:", error);
        }
    }

    function setupAnalytics() {
        if (!studentSearchInput) return;

        studentSearchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            if (query.length < 1) {
                suggestionsDropdown.classList.add('hidden');
                return;
            }

            // Get unique student names
            const names = [...new Set(allRecords.map(r => r.Name_of_Student))];
            const matches = names.filter(name => name.toLowerCase().includes(query)).slice(0, 5);

            if (matches.length > 0) {
                suggestionsDropdown.innerHTML = '';
                matches.forEach(name => {
                    const div = document.createElement('div');
                    div.className = 'suggestion-item';
                    div.textContent = name;
                    div.onclick = () => {
                        studentSearchInput.value = name;
                        suggestionsDropdown.classList.add('hidden');
                        renderStudentProfile(name);
                    };
                    suggestionsDropdown.appendChild(div);
                });
                suggestionsDropdown.classList.remove('hidden');
            } else {
                suggestionsDropdown.classList.add('hidden');
            }
        });

        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (e.target !== studentSearchInput) {
                suggestionsDropdown.classList.add('hidden');
            }
        });
    }

    function renderStudentProfile(studentName) {
        const studentRecords = allRecords.filter(r => r.Name_of_Student === studentName);
        if (studentRecords.length === 0) return;

        analyticsEmpty.classList.add('hidden');
        analyticsContent.classList.remove('hidden');

        // Header Info
        document.getElementById('profile-name').textContent = studentName;
        const initials = studentName.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
        document.getElementById('profile-initials').textContent = initials;
        
        // Stats
        const domains = studentRecords.map(r => r.Domain).filter(d => d !== 'N/A');
        const dominantDomain = domains.length > 0 ? mode(domains) : 'General';
        document.getElementById('profile-stats').textContent = `Total Credentials: ${studentRecords.length} | Primary Domain: ${dominantDomain}`;

        // Timeline
        const timelineContainer = document.getElementById('timeline-container');
        timelineContainer.innerHTML = '';
        
        // Sort by date (naive string sort, but better than nothing)
        const sortedRecords = [...studentRecords].sort((a, b) => new Date(b.From_Date) - new Date(a.From_Date));

        sortedRecords.forEach(record => {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            item.innerHTML = `
                <div class="timeline-content">
                    <div class="timeline-date">${record.From_Date}</div>
                    <div class="timeline-title">${record.Activity_Event} ${record.Rank_Position && record.Rank_Position !== 'N/A' ? getRankBadgeHTML(record.Rank_Position, record.Achievement) : ''}</div>
                    <div class="timeline-org">${record.Organized_by}</div>
                </div>
            `;
            timelineContainer.appendChild(item);
        });

        // Evaluation Summary (Skills)
        const skillsSummary = document.getElementById('skills-summary');
        skillsSummary.innerHTML = '';

        // Group by Domain
        const domainGroups = {};
        studentRecords.forEach(r => {
            const d = r.Domain || 'General';
            if (!domainGroups[d]) domainGroups[d] = [];
            domainGroups[d].push(r);
        });

        Object.keys(domainGroups).forEach(domain => {
            const group = domainGroups[domain];
            
            const card = document.createElement('div');
            card.className = 'skill-domain-card';
            card.innerHTML = `
                <div class="skill-domain-title">
                    ${domain}
                </div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">
                    Based on ${group.length} certificate(s) including "${group[0].Activity_Event}"
                </div>
            `;
            skillsSummary.appendChild(card);
        });
    }

    function mode(arr) {
        return arr.sort((a,b) =>
              arr.filter(v => v===a).length
            - arr.filter(v => v===b).length
        ).pop();
    }

    // ---- DASHBOARD & CHARTS LOGIC ----
    let eventChartInstance = null;
    let domainChartInstance = null;
    let levelChartInstance = null;
    let achievementChartInstance = null;

    let activeFilterCategory = 'all';

    async function fetchDashboardStats() {
        try {
            const [statsRes, recordsRes] = await Promise.all([
                fetch(getApiUrl('/api/stats')),
                fetch(getApiUrl('/api/records'))
            ]);

            const stats = await safeParseResponse(statsRes, 'Failed to load stats.');
            const records = await safeParseResponse(recordsRes, 'Failed to load records.');

            // Update allRecords cache
            allRecords = Array.isArray(records) ? records : [];

            // 1. Update KPI Card Values
            document.getElementById('stat-total-uploads').textContent = stats.total || 0;
            document.getElementById('stat-it-count').textContent = stats.itCertificatesCount || 0;
            document.getElementById('stat-internship-count').textContent = stats.internshipsCount || 0;
            document.getElementById('stat-hackathon-count').textContent = stats.hackathonsCount || 0;
            document.getElementById('stat-research-count').textContent = stats.researchCount || 0;
            document.getElementById('stat-workshop-count').textContent = stats.workshopsCount || 0;

            // 2. Render Charts
            renderEventDistributionChart(stats.byEvent || {});
            renderDomainBreakdownChart(stats.byDomain || {});
            renderLevelDistributionChart(stats.byLevel || {});
            renderAchievementChart(stats.byAchievement || {});

            // 3. Render Filtered Table
            renderDashboardFilteredTable(activeFilterCategory);

        } catch (error) {
            console.error('Error loading dashboard stats:', error);
        }
    }

    function renderEventDistributionChart(byEvent) {
        const ctx = document.getElementById('eventDistributionChart');
        if (!ctx) return;

        const labels = Object.keys(byEvent);
        const data = Object.values(byEvent);

        if (eventChartInstance) eventChartInstance.destroy();

        eventChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels.length ? labels : ['No Data'],
                datasets: [{
                    data: data.length ? data : [1],
                    backgroundColor: [
                        '#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'
                    ],
                    borderWidth: 2,
                    borderColor: 'rgba(255, 255, 255, 0.8)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 12, font: { family: 'Inter' } } }
                }
            }
        });
    }

    function renderDomainBreakdownChart(byDomain) {
        const ctx = document.getElementById('domainBreakdownChart');
        if (!ctx) return;

        const labels = Object.keys(byDomain);
        const data = Object.values(byDomain);

        if (domainChartInstance) domainChartInstance.destroy();

        domainChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels.length ? labels : ['No Data'],
                datasets: [{
                    label: 'Certificates',
                    data: data.length ? data : [0],
                    backgroundColor: 'rgba(99, 102, 241, 0.85)',
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } },
                    x: { ticks: { font: { family: 'Inter' } } }
                }
            }
        });
    }

    function renderLevelDistributionChart(byLevel) {
        const ctx = document.getElementById('levelDistributionChart');
        if (!ctx) return;

        const labels = Object.keys(byLevel);
        const data = Object.values(byLevel);

        if (levelChartInstance) levelChartInstance.destroy();

        levelChartInstance = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: labels.length ? labels : ['No Data'],
                datasets: [{
                    data: data.length ? data : [1],
                    backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 12 } }
                }
            }
        });
    }

    function renderAchievementChart(byAchievement) {
        const ctx = document.getElementById('achievementChart');
        if (!ctx) return;

        const labels = Object.keys(byAchievement);
        const data = Object.values(byAchievement);

        if (achievementChartInstance) achievementChartInstance.destroy();

        achievementChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels.length ? labels : ['No Data'],
                datasets: [{
                    label: 'Count',
                    data: data.length ? data : [0],
                    backgroundColor: 'rgba(236, 72, 153, 0.85)',
                    borderRadius: 8
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { beginAtZero: true, ticks: { precision: 0 } }
                }
            }
        });
    }

    function renderDashboardFilteredTable(categoryFilter) {
        const tbody = document.querySelector('#dashboard-filtered-table tbody');
        if (!tbody) return;

        tbody.innerHTML = '';

        let filtered = allRecords;

        if (categoryFilter && categoryFilter !== 'all') {
            const filterLower = categoryFilter.toLowerCase();
            filtered = allRecords.filter(r => {
                const event = (r.Activity_Event || '').toLowerCase();
                const domain = (r.Domain || '').toLowerCase();
                const details = (r.Details || '').toLowerCase();

                if (categoryFilter === 'IT') {
                    return domain.includes('it') || domain.includes('software') || domain.includes('tech') || details.includes('python') || details.includes('java') || details.includes('web');
                }
                return event.includes(filterLower) || details.includes(filterLower);
            });
        }

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="7" style="text-align:center; color: var(--text-secondary); padding: 2rem;">No certificates found for "${categoryFilter}" category.</td>`;
            tbody.appendChild(tr);
            return;
        }

        filtered.slice(0, 15).forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHTML(r.Name_of_Student)}</strong></td>
                <td><span class="badge-mini">${escapeHTML(r.Activity_Event)}</span></td>
                <td>${escapeHTML(r.Domain || 'N/A')}</td>
                <td>${escapeHTML(r.Organized_by || 'N/A')}</td>
                <td>${escapeHTML(r.From_Date || 'N/A')}</td>
                <td>${escapeHTML(r.To_Date || 'N/A')}</td>
                <td><span class="achievement-badge">${escapeHTML(r.Achievement || 'N/A')}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }

    // Category pill handlers
    document.querySelectorAll('.pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilterCategory = btn.getAttribute('data-filter');
            renderDashboardFilteredTable(activeFilterCategory);
        });
    });

    // Refresh Dashboard button
    const refreshDashBtn = document.getElementById('refresh-dashboard-btn');
    if (refreshDashBtn) {
        refreshDashBtn.addEventListener('click', fetchDashboardStats);
    }

    // ---- CUSTOM REPORT GENERATOR LOGIC ----
    const reportRoleSelect = document.getElementById('report-participant-type');
    const reportEventSelect = document.getElementById('report-event-type');
    const reportTableBody = document.querySelector('#custom-reports-table tbody');
    const reportCountBadge = document.getElementById('report-count-badge');
    const downloadReportExcelBtn = document.getElementById('download-report-excel-btn');
    const printReportPdfBtn = document.getElementById('print-report-pdf-btn');

    async function fetchCustomReport() {
        if (!reportTableBody) return;
        const participantType = reportRoleSelect?.value || 'all';
        const eventType = reportEventSelect?.value || 'all';

        try {
            const url = getApiUrl(`/api/reports/custom?participantType=${encodeURIComponent(participantType)}&eventType=${encodeURIComponent(eventType)}`);
            const res = await fetch(url);
            const data = await safeParseResponse(res, 'Failed to fetch report.');
            
            const records = data.records || [];
            if (reportCountBadge) reportCountBadge.textContent = `${records.length} Records Found`;

            reportTableBody.innerHTML = '';
            if (records.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td colspan="12" style="text-align:center; color: var(--text-secondary); padding: 2rem;">No certificates found matching selected report filters.</td>`;
                reportTableBody.appendChild(tr);
                return;
            }

            records.forEach(r => {
                const tr = document.createElement('tr');
                const roleBadge = r.Participant_Type === 'Faculty' ? '<span class="rank-badge rank-distinction">👨‍🏫 Faculty</span>' : '<span class="rank-badge rank-1st">🎓 Student</span>';
                const driveLinkHTML = r.Google_Drive_Link && r.Google_Drive_Link !== 'N/A' 
                    ? `<a href="${escapeHTML(r.Google_Drive_Link)}" target="_blank" style="color:var(--primary-color); word-break:break-all;">${escapeHTML(r.Google_Drive_Link)}</a>` 
                    : '<span style="color:var(--text-secondary);">N/A</span>';

                tr.innerHTML = `
                    <td><strong>${escapeHTML(r.Name_of_Student)}</strong></td>
                    <td>${roleBadge}</td>
                    <td><span class="badge-mini">${escapeHTML(r.Activity_Event)}</span></td>
                    <td>${escapeHTML(r.Organized_by || 'N/A')}</td>
                    <td><span class="badge-mini">${escapeHTML(r.Domain || 'N/A')}</span></td>
                    <td>${escapeHTML(r.From_Date || 'N/A')}</td>
                    <td>${escapeHTML(r.To_Date || 'N/A')}</td>
                    <td>${escapeHTML(r.Venue || 'N/A')}</td>
                    <td>${escapeHTML(r.Level || 'N/A')}</td>
                    <td>${driveLinkHTML}</td>
                    <td>${getRankBadgeHTML(r.Rank_Position)}</td>
                    <td><span class="achievement-badge">${escapeHTML(r.Achievement || 'N/A')}</span></td>
                `;
                reportTableBody.appendChild(tr);
            });
        } catch (err) {
            console.error('Failed to fetch custom report:', err);
        }
    }

    [reportRoleSelect, reportEventSelect].forEach(select => {
        if (select) select.addEventListener('change', fetchCustomReport);
    });

    if (downloadReportExcelBtn) {
        downloadReportExcelBtn.addEventListener('click', () => {
            const participantType = reportRoleSelect?.value || 'all';
            const eventType = reportEventSelect?.value || 'all';
            window.location.href = getApiUrl(`/api/reports/export-excel?participantType=${encodeURIComponent(participantType)}&eventType=${encodeURIComponent(eventType)}`);
        });
    }

    if (printReportPdfBtn) {
        printReportPdfBtn.addEventListener('click', () => {
            window.print();
        });
    }

    // Initial load
    fetchAllRecords();
    setupAnalytics();
    fetchDashboardStats();
    fetchCustomReport();

    function escapeHTML(str) {
        if (!str) return 'N/A';
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }
});
