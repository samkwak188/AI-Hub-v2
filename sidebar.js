// AI Collab — Sidebar Logic
// Chat interface, API communication, page context extraction
// API keys are handled server-side — no key management needed in the extension

(() => {
    'use strict';

    // ===== State =====
    let messages = [];
    let isLoading = false;
    let includePageContext = false;
    let cachedScreenContext = null;
    let screenContextHistory = [];
    let settings = {
        serverUrl: 'http://localhost:3001',
        enableOpenAIVisionPacket: true,
        enableCostOptimizedMode: true,
        enableAgentMode: false
    };
    let liveThinkingEl = null;

    const MAX_PRIOR_CONTEXTS = 14;
    const MAX_CURRENT_CONTEXT_TEXT_CHARS = 12000;
    const MAX_PRIOR_CONTEXT_TEXT_CHARS = 4000;

    // ===== DOM Elements =====
    const $ = (sel) => document.querySelector(sel);
    const chatContainer = $('#chatContainer');
    const welcomeState = $('#welcomeState');
    const userInput = $('#userInput');
    const btnSend = $('#btnSend');
    const btnSettings = $('#btnSettings');
    const btnCloseSettings = $('#btnCloseSettings');
    const btnSaveSettings = $('#btnSaveSettings');
    const btnNewChat = $('#btnNewChat');
    const btnContext = $('#btnContext');
    const btnAgentMode = $('#btnAgentMode');
    const btnVisionPacket = $('#btnVisionPacket');
    const btnCostMode = $('#btnCostMode');
    const btnCheckServer = $('#btnCheckServer');
    const settingsModal = $('#settingsModal');
    const contextStatus = $('#contextStatus');

    // ===== Init =====
    function init() {
        loadSettings();
        bindEvents();
        bindRuntimeListeners();
        updateVisionPacketButtonState();
        updateCostModeButtonState();
        updateAgentModeButtonState();
        userInput.focus();
    }

    // ===== Settings =====
    function parseBooleanSetting(value, fallback = true) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        }
        return fallback;
    }

    function isVisionPacketEnabled() {
        return parseBooleanSetting(settings.enableOpenAIVisionPacket, true);
    }

    function isCostOptimizedModeEnabled() {
        return parseBooleanSetting(settings.enableCostOptimizedMode, true);
    }

    function isAgentModeEnabled() {
        return parseBooleanSetting(settings.enableAgentMode, false);
    }

    function persistSettings() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ aiCollab_settings: settings });
        } else {
            localStorage.setItem('aiCollab_settings', JSON.stringify(settings));
        }
    }

    function loadSettings() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['aiCollab_settings'], (result) => {
                if (result.aiCollab_settings) {
                    settings = { ...settings, ...result.aiCollab_settings };
                }
                settings.enableOpenAIVisionPacket = parseBooleanSetting(settings.enableOpenAIVisionPacket, true);
                settings.enableCostOptimizedMode = parseBooleanSetting(settings.enableCostOptimizedMode, true);
                settings.enableAgentMode = parseBooleanSetting(settings.enableAgentMode, false);
                populateSettingsForm();
            });
        } else {
            const saved = localStorage.getItem('aiCollab_settings');
            if (saved) {
                settings = { ...settings, ...JSON.parse(saved) };
            }
            settings.enableOpenAIVisionPacket = parseBooleanSetting(settings.enableOpenAIVisionPacket, true);
            settings.enableCostOptimizedMode = parseBooleanSetting(settings.enableCostOptimizedMode, true);
            settings.enableAgentMode = parseBooleanSetting(settings.enableAgentMode, false);
            populateSettingsForm();
        }
    }

    function saveSettings() {
        settings.serverUrl = $('#serverUrl').value.trim() || 'http://localhost:3001';
        settings.enableOpenAIVisionPacket = parseBooleanSetting(settings.enableOpenAIVisionPacket, true);
        settings.enableCostOptimizedMode = parseBooleanSetting(settings.enableCostOptimizedMode, true);
        settings.enableAgentMode = parseBooleanSetting(settings.enableAgentMode, false);
        persistSettings();

        settingsModal.classList.remove('open');
    }

    function populateSettingsForm() {
        $('#serverUrl').value = settings.serverUrl;
        updateVisionPacketButtonState();
        updateCostModeButtonState();
        updateAgentModeButtonState();
    }

    function updateVisionPacketButtonState() {
        if (!btnVisionPacket) return;
        const enabled = isVisionPacketEnabled();
        btnVisionPacket.classList.toggle('active', enabled);
        const label = btnVisionPacket.querySelector('span');
        if (label) label.textContent = enabled ? 'Vision Packet On' : 'Vision Packet Off';
        btnVisionPacket.title = enabled
            ? 'OpenAI vision packet is enabled'
            : 'OpenAI vision packet is disabled';
    }

    function toggleVisionPacket() {
        settings.enableOpenAIVisionPacket = !isVisionPacketEnabled();
        updateVisionPacketButtonState();
        persistSettings();
    }

    function updateCostModeButtonState() {
        if (!btnCostMode) return;
        const enabled = isCostOptimizedModeEnabled();
        btnCostMode.classList.toggle('active', enabled);
        const label = btnCostMode.querySelector('span');
        if (label) label.textContent = enabled ? 'Cost On' : 'Cost Off';
        btnCostMode.title = enabled
            ? 'Adaptive routing and early exits are enabled'
            : 'Adaptive routing and early exits are disabled';
    }

    function toggleCostMode() {
        settings.enableCostOptimizedMode = !isCostOptimizedModeEnabled();
        updateCostModeButtonState();
        persistSettings();
    }

    function updateAgentModeButtonState() {
        if (!btnAgentMode) return;
        const enabled = isAgentModeEnabled();
        btnAgentMode.classList.toggle('active', enabled);
        const label = btnAgentMode.querySelector('span');
        if (label) label.textContent = enabled ? 'Agent On' : 'Agent Off';
        btnAgentMode.title = enabled
            ? 'Agent mode enabled: AI detects question regions, scrolls to them, and captures targeted screenshots'
            : 'Agent mode disabled';
    }

    function toggleAgentMode() {
        settings.enableAgentMode = !isAgentModeEnabled();
        updateAgentModeButtonState();
        persistSettings();
    }

    // ===== Events =====
    function bindEvents() {
        btnSend.addEventListener('click', sendMessage);
        btnSettings.addEventListener('click', openSettings);
        btnCloseSettings.addEventListener('click', () => settingsModal.classList.remove('open'));
        btnSaveSettings.addEventListener('click', saveSettings);
        btnNewChat.addEventListener('click', clearChat);
        btnContext.addEventListener('click', togglePageContext);
        if (btnAgentMode) btnAgentMode.addEventListener('click', toggleAgentMode);
        if (btnVisionPacket) btnVisionPacket.addEventListener('click', toggleVisionPacket);
        if (btnCostMode) btnCostMode.addEventListener('click', toggleCostMode);
        btnCheckServer.addEventListener('click', checkServerConnection);

        userInput.addEventListener('input', handleInputChange);
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Close modal on overlay click
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) settingsModal.classList.remove('open');
        });
    }

    function bindRuntimeListeners() {
        if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;

        chrome.runtime.onMessage.addListener((message) => {
            if (!message || message.type !== 'AGENT_PROGRESS') return false;
            if (liveThinkingEl && typeof message.status === 'string' && message.status.trim()) {
                updateThinkingText(liveThinkingEl, message.status.trim());
                scrollToBottom();
            }
            return false;
        });
    }

    function handleInputChange() {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
        btnSend.disabled = !userInput.value.trim() || isLoading;
    }

    function openSettings() {
        populateSettingsForm();
        settingsModal.classList.add('open');
    }

    // ===== Page Context =====
    function getContextLabel(context) {
        const charCount = context.content?.length || 0;
        if (context.type === 'selection') return 'selection';
        if (context.type === 'restricted') return 'limited text access';
        if (context.type === 'error') return 'limited access';
        return `${charCount} chars`;
    }

    function showContextReadyStatus(context, mode) {
        const hasScreenshot = !!context?.screenshot;
        const label = getContextLabel(context || {});

        contextStatus.classList.remove('hidden', 'error');
        contextStatus.classList.add('success');
        contextStatus.textContent = hasScreenshot
            ? `Screen context ${mode} (${label}) - ${context?.title || 'page'}`
            : `Text context ${mode} (${label}) - ${context?.title || 'page'}`;
    }

    function getContextKey(context) {
        if (!context) return '';
        const title = context.title || '';
        const url = context.url || '';
        const capturedAt = context.capturedAt || '';
        return `${title}|${url}|${capturedAt}`;
    }

    function addContextToHistory(context) {
        if (!context) return;

        const newKey = getContextKey(context);
        if (!newKey) return;

        const alreadyPresent = screenContextHistory.some(ctx => getContextKey(ctx) === newKey);
        if (alreadyPresent) return;

        screenContextHistory.push(context);
        if (screenContextHistory.length > 18) {
            screenContextHistory = screenContextHistory.slice(-18);
        }
    }

    function mapContextForModel(context, includeScreenshot = true, maxTextChars = MAX_CURRENT_CONTEXT_TEXT_CHARS) {
        if (!context) return null;

        return {
            title: context.title || 'Unknown',
            url: context.url || 'Unknown',
            type: context.type || 'screen',
            capturedAt: context.capturedAt || new Date().toISOString(),
            content: (context.content || '').slice(0, maxTextChars),
            screenshot: includeScreenshot ? (context.screenshot || null) : null,
            focus: context.focus || null
        };
    }

    function buildPriorContexts(currentContext) {
        if (!includePageContext || screenContextHistory.length === 0) return [];

        const currentKey = getContextKey(currentContext);
        return screenContextHistory
            .filter(ctx => getContextKey(ctx) !== currentKey)
            .slice(-MAX_PRIOR_CONTEXTS)
            .map(ctx => mapContextForModel(ctx, true, MAX_PRIOR_CONTEXT_TEXT_CHARS))
            .filter(Boolean);
    }

    async function captureAndCacheScreenContext(statusText = 'Capturing screen context...') {
        if (!includePageContext) return null;

        contextStatus.textContent = statusText;
        contextStatus.classList.remove('hidden', 'success', 'error');

        const screenContext = await getScreenContext();
        if (screenContext) {
            cachedScreenContext = screenContext;
            addContextToHistory(screenContext);
            showContextReadyStatus(screenContext, 'updated');
            return screenContext;
        }

        contextStatus.textContent = 'Could not capture screen context';
        contextStatus.classList.add('error');
        return null;
    }

    async function resolveScreenContextForMessage() {
        if (!includePageContext) return null;

        // Always capture a fresh screenshot on every message.
        return captureAndCacheScreenContext('Capturing screen context...');
    }

    async function togglePageContext() {
        includePageContext = !includePageContext;
        btnContext.classList.toggle('active', includePageContext);

        if (includePageContext) {
            await captureAndCacheScreenContext('Capturing screen context...');
        } else {
            cachedScreenContext = null;
            screenContextHistory = [];
            contextStatus.classList.add('hidden');
            contextStatus.classList.remove('success', 'error');
            contextStatus.textContent = '';
        }
    }

    function sendRuntimeMessage(message) {
        return new Promise((resolve) => {
            if (typeof chrome === 'undefined' || !chrome.runtime) {
                resolve(null);
                return;
            }

            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(`Runtime message failed (${message.type}):`, chrome.runtime.lastError);
                    resolve(null);
                    return;
                }
                resolve(response || null);
            });
        });
    }

    async function getScreenshot() {
        if (!includePageContext) return null;
        const response = await sendRuntimeMessage({ type: 'CAPTURE_SCREENSHOT' });
        if (!response || response.error || !response.screenshot) {
            return null;
        }
        return response;
    }

    async function getPageContent() {
        if (!includePageContext) return null;

        const response = await sendRuntimeMessage({ type: 'GET_PAGE_CONTENT' });
        if (!response) return null;

        // Always return the response — even error types have useful info
        return response;
    }

    async function getScreenContext() {
        if (!includePageContext) return null;

        const [pageContent, screenshot] = await Promise.all([
            getPageContent(),
            getScreenshot()
        ]);

        if (!pageContent && !screenshot) return null;

        return {
            title: pageContent?.title || screenshot?.title || 'Unknown',
            url: pageContent?.url || screenshot?.url || 'Unknown',
            type: pageContent?.type || 'screen',
            content: pageContent?.content || '',
            screenshot: screenshot?.screenshot || null,
            capturedAt: new Date().toISOString()
        };
    }

    function mapAgentStateToContext(pageState) {
        if (!pageState) return null;
        return {
            title: pageState.title || 'Unknown',
            url: pageState.url || 'Unknown',
            type: pageState.type || 'page',
            content: pageState.content || '',
            screenshot: pageState.screenshot || null,
            capturedAt: pageState.capturedAt || new Date().toISOString(),
            focus: pageState.focus || null
        };
    }

    function getHistoryPayloadForModel() {
        // Exclude current user message because it is sent separately as `message`.
        return messages.slice(0, -1).map(m => ({
            role: m.role,
            content: m.content
        }));
    }

    async function captureFullPageContexts(maxShots = 6) {
        const response = await sendRuntimeMessage({
            type: 'AGENT_CAPTURE_FULL_PAGE',
            maxShots
        });

        if (!response) {
            return {
                contexts: [],
                metrics: null,
                error: 'No response from extension background worker.'
            };
        }

        if (response.ok === false) {
            return {
                contexts: [],
                metrics: response.metrics || null,
                error: response.error || 'Full-page capture failed in extension background worker.'
            };
        }

        if (!Array.isArray(response.frames) || response.frames.length === 0) {
            return {
                contexts: [],
                metrics: response.metrics || null,
                error: 'Full-page capture returned no screenshot frames.'
            };
        }

        return {
            contexts: response.frames.map((frame) => mapAgentStateToContext(frame)).filter(Boolean),
            metrics: response.metrics || null,
            error: null
        };
    }

    async function captureQuestionContexts(goal, maxShots = 6) {
        const response = await sendRuntimeMessage({
            type: 'AGENT_CAPTURE_QUESTIONS',
            goal,
            maxShots
        });

        if (!response) {
            return {
                contexts: [],
                metrics: null,
                error: 'No response from extension background worker.'
            };
        }

        if (response.ok === false) {
            return {
                contexts: [],
                metrics: response.metrics || null,
                error: response.error || 'Question-targeted capture failed in extension background worker.'
            };
        }

        if (!Array.isArray(response.frames)) {
            return {
                contexts: [],
                metrics: response.metrics || null,
                error: 'Question-targeted capture returned invalid frame data.'
            };
        }

        return {
            contexts: response.frames.map((frame) => mapAgentStateToContext(frame)).filter(Boolean),
            metrics: response.metrics || null,
            error: null
        };
    }

    function updateThinkingText(el, text) {
        if (!el) return;
        const textEl = el.querySelector('.thinking-text');
        if (textEl) textEl.textContent = text;
    }

    function buildAgentSurveySummary(contexts, goal) {
        if (!Array.isArray(contexts) || contexts.length === 0) return '';

        const lines = [];
        lines.push(`Agent survey goal: ${goal}`);
        lines.push(`Captured regions: ${contexts.length}`);

        contexts.forEach((ctx, index) => {
            const snippet = String(ctx?.content || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 280);
            const top = Number(ctx?.focus?.top || ctx?.scroll?.y || 0);
            lines.push(`${index + 1}. top=${top} ${snippet}`);
        });

        return lines.join('\n').slice(0, 5000);
    }

    async function runAgentMode(goal, thinkingEl) {
        includePageContext = true;
        btnContext.classList.add('active');
        screenContextHistory = [];
        cachedScreenContext = null;

        updateThinkingText(thinkingEl, 'Agent detecting question blocks on the live page...');
        const targetedCapture = await captureQuestionContexts(goal, 10);
        let contexts = targetedCapture.contexts;

        if (!contexts.length) {
            if (targetedCapture.error) {
                updateThinkingText(thinkingEl, `Question-targeted capture unavailable (${targetedCapture.error}). Trying full-page scan...`);
            } else {
                updateThinkingText(thinkingEl, 'No clear question blocks detected. Falling back to full-page scan...');
            }
        }

        let fullPageCapture = { contexts: [], metrics: null, error: null };
        if (!contexts.length) {
            fullPageCapture = await captureFullPageContexts(10);
            contexts = fullPageCapture.contexts;
        }

        if (!contexts.length) {
            const reasonParts = [targetedCapture.error, fullPageCapture.error].filter(Boolean);
            const reasonText = reasonParts.length > 0
                ? ` Capture error: ${reasonParts.join(' | ')}`
                : '';
            throw new Error(`Agent could not capture usable page screenshots.${reasonText}`);
        }

        if (!targetedCapture.error && !targetedCapture.contexts.length && fullPageCapture.contexts.length > 0) {
            updateThinkingText(thinkingEl, 'No clear question blocks detected. Falling back to full-page scan...');
        }

        contexts.forEach((ctx) => addContextToHistory(ctx));
        const finalContext = contexts[contexts.length - 1];
        const surveySummary = buildAgentSurveySummary(contexts, goal);
        if (surveySummary) {
            finalContext.content = `${surveySummary}\n\n${finalContext.content || ''}`.trim();
        }
        cachedScreenContext = finalContext;
        showContextReadyStatus(finalContext, 'updated');

        const targetedShotCount = Number(targetedCapture?.metrics?.capturedShots || 0);
        const fullPageShotCount = Number(fullPageCapture?.metrics?.capturedShots || 0);
        const captureLabel = targetedShotCount > 0
            ? `question-focused capture (${targetedShotCount} shots)`
            : (fullPageShotCount > 0
                ? `full-page capture (${fullPageShotCount} shots)`
                : `single-screen capture (${contexts.length} shot)`);
        updateThinkingText(thinkingEl, `Agent finished ${captureLabel}. Running multi-model collaboration...`);
        return callBackend(goal, finalContext, thinkingEl);
    }

    // ===== Server Connection =====
    async function checkServerConnection() {
        const statusDot = $('#serverStatus .status-dot');
        const statusText = $('#serverStatus .status-text');
        const providerList = $('#providerList');

        statusText.textContent = 'Checking...';
        statusDot.className = 'status-dot';
        if (providerList) providerList.textContent = '';

        try {
            const url = settings.serverUrl || $('#serverUrl').value.trim();
            const res = await fetch(`${url}/health`, { method: 'GET' });
            if (res.ok) {
                const data = await res.json();
                statusDot.className = 'status-dot connected';
                statusText.textContent = `Connected — ${data.modelCount || 0} models active`;
                if (providerList && data.providers) {
                    providerList.textContent = `(${data.providers.join(', ')})`;
                }
            } else {
                throw new Error('Server returned error');
            }
        } catch (err) {
            statusDot.className = 'status-dot error';
            statusText.textContent = 'Cannot connect — is the server running?';
        }
    }

    // ===== Chat =====
    async function sendMessage() {
        const text = userInput.value.trim();
        if (!text || isLoading) return;

        // Hide welcome state
        if (welcomeState) {
            welcomeState.style.display = 'none';
        }

        // Add user message
        addMessage('user', text);
        userInput.value = '';
        userInput.style.height = 'auto';
        btnSend.disabled = true;
        isLoading = true;

        const agentMode = isAgentModeEnabled();
        // In non-agent mode, capture fresh context once per message.
        const pageContext = agentMode ? null : await resolveScreenContextForMessage();

        // Show thinking indicator
        const thinkingEl = showThinking();
        liveThinkingEl = thinkingEl;

        try {
            const response = agentMode
                ? await runAgentMode(text, thinkingEl)
                : await callBackend(text, pageContext, thinkingEl);
            removeThinking(thinkingEl);
            liveThinkingEl = null;

            if (response.error) {
                addErrorMessage(response.error);
            } else {
                addAssistantMessage(response);
            }
        } catch (err) {
            removeThinking(thinkingEl);
            liveThinkingEl = null;
            addErrorMessage(getErrorText(err));
        }

        isLoading = false;
        btnSend.disabled = !userInput.value.trim();
        scrollToBottom();
    }

    // ===== API Call =====
    async function callBackend(message, pageContext, thinkingEl) {
        const url = `${settings.serverUrl}/api/chat`;

        const body = {
            message,
            options: {
                enableOpenAIVisionPacket: isVisionPacketEnabled(),
                enableCostOptimizedMode: isCostOptimizedModeEnabled()
            }
        };

        if (pageContext) {
            body.context = mapContextForModel(pageContext, true, MAX_CURRENT_CONTEXT_TEXT_CHARS);
            const priorContexts = buildPriorContexts(pageContext);
            if (priorContexts.length > 0) {
                body.priorContexts = priorContexts;
            }
        }

        // Include full current-session history so models decide whether the new question
        // is a continuation or a fresh topic.
        body.history = getHistoryPayloadForModel();

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Server error (${res.status})`);
        }

        // Handle SSE streaming
        if (res.headers.get('content-type')?.includes('text/event-stream')) {
            return handleSSE(res, thinkingEl);
        }

        return res.json();
    }

    async function handleSSE(response, thinkingEl) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.type === 'progress') {
                            updateThinkingProgress(thinkingEl, data.round, data.status);
                        } else if (data.type === 'result') {
                            result = data;
                        } else if (data.type === 'error') {
                            throw new Error(data.error);
                        }
                    } catch (e) {
                        if (e.message !== 'Unexpected end of JSON input') {
                            throw e;
                        }
                    }
                }
            }
        }

        return result || { error: 'No response received from server' };
    }

    // ===== Rendering =====
    function addMessage(role, content) {
        messages.push({ role, content, timestamp: Date.now() });

        const el = document.createElement('div');
        el.className = `message ${role}`;

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.innerHTML = formatMarkdown(content);

        el.appendChild(bubble);
        chatContainer.appendChild(el);
        scrollToBottom();
    }

    function addAssistantMessage(response) {
        messages.push({
            role: 'assistant',
            content: response.finalAnswer,
            timestamp: Date.now(),
            rounds: response.rounds,
            meta: response.meta || null
        });

        const el = document.createElement('div');
        el.className = 'message assistant';

        // Main answer bubble
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.innerHTML = formatMarkdown(response.finalAnswer);
        el.appendChild(bubble);

        // Collaboration details toggle
        if (response.rounds && response.rounds.length > 0) {
            const toggle = document.createElement('button');
            toggle.className = 'collab-toggle';
            toggle.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        See how models collaborated
      `;

            const details = document.createElement('div');
            details.className = 'collab-details';
            details.innerHTML = renderRounds(response.rounds, response.meta || null);

            toggle.addEventListener('click', () => {
                toggle.classList.toggle('open');
                details.classList.toggle('open');
            });

            el.appendChild(toggle);
            el.appendChild(details);
        }

        chatContainer.appendChild(el);
        scrollToBottom();
    }

    function renderTelemetrySummary(meta) {
        if (!meta) return '';

        const route = meta.routeDecision || {};
        const path = route.recommended_path || 'unknown';
        const roundsRun = meta.rounds_run || 0;
        const earlyExit = meta.early_exit?.triggered
            ? `early exit: ${meta.early_exit.stage}`
            : 'early exit: none';
        const cost = typeof meta.totals?.estimated_cost_usd === 'number'
            ? `$${meta.totals.estimated_cost_usd.toFixed(4)} est.`
            : 'cost unavailable';
        const cacheHit = typeof meta.cache_hit_rate === 'number'
            ? `${Math.round(meta.cache_hit_rate * 100)}% cache`
            : 'cache unavailable';
        const models = Array.isArray(meta.selected_models) ? meta.selected_models.join(', ') : 'unknown';

        return `<div class="round-card">
        <div class="round-header">
          <span class="round-number">Meta</span>
          <span class="round-title">Route ${path}</span>
        </div>
        <div class="model-response cloudflare">
          <div class="model-response-text"><p>Models: ${models}<br>Rounds: ${roundsRun}<br>${earlyExit}<br>${cost}<br>${cacheHit}</p></div>
        </div>
      </div>`;
    }

    function renderRounds(rounds, meta) {
        const roundNames = ['Independent Answers', 'Peer Cross-Validation', 'Consensus Discussion', 'Final Synthesis'];
        let html = renderTelemetrySummary(meta);

        rounds.forEach((round, i) => {
            html += `<div class="round-card">
        <div class="round-header">
          <span class="round-number">Round ${i + 1}</span>
          <span class="round-title">${round.name || roundNames[i] || `Round ${i + 1}`}</span>
        </div>`;

            if (round.responses) {
                round.responses.forEach(resp => {
                    const modelClass = getModelClass(resp.model);
                    html += `<div class="model-response ${modelClass}">
            <div class="model-response-header">
              <span class="model-dot ${modelClass}"></span>
              <span class="model-name">${resp.model || 'Unknown'}</span>
            </div>
            <div class="model-response-text">${formatMarkdown(resp.text || resp.content || '')}</div>
          </div>`;
                });
            }

            html += '</div>';
        });

        return html;
    }

    function getModelClass(name) {
        if (!name) return 'cloudflare';
        const lower = name.toLowerCase();
        if (lower.includes('gpt')) return 'gpt';
        if (lower.includes('claude')) return 'claude';
        if (lower.includes('gemini')) return 'gemini';
        if (lower.includes('gemma')) return 'cloudflare';
        if (lower.includes('deepseek')) return 'cloudflare';
        if (lower.includes('mistral')) return 'cloudflare';
        if (lower.includes('llama') || lower.includes('maverick')) return 'llama';
        return 'cloudflare';
    }

    function addErrorMessage(text) {
        const el = document.createElement('div');
        el.className = 'error-message';
        el.textContent = text;
        chatContainer.appendChild(el);
        scrollToBottom();
    }

    // ===== Thinking Indicator =====
    function showThinking() {
        const el = document.createElement('div');
        el.className = 'thinking';
        el.innerHTML = `
      <div class="thinking-status">
        <div class="thinking-dots">
          <span></span><span></span><span></span>
        </div>
        <span class="thinking-text">Models are thinking...</span>
      </div>
      <div class="thinking-progress">
        <span class="progress-step active" data-round="1">R1 Independent</span>
        <span class="progress-step" data-round="2">R2 Validate</span>
        <span class="progress-step" data-round="3">R3 Consensus</span>
        <span class="progress-step" data-round="4">R4 Final</span>
      </div>
    `;
        chatContainer.appendChild(el);
        scrollToBottom();
        return el;
    }

    function updateThinkingProgress(el, round, status) {
        if (!el) return;

        const textEl = el.querySelector('.thinking-text');
        if (textEl && status) textEl.textContent = status;

        const steps = el.querySelectorAll('.progress-step');
        steps.forEach(step => {
            const stepRound = parseInt(step.dataset.round);
            if (stepRound < round) {
                step.classList.remove('active');
                step.classList.add('done');
            } else if (stepRound === round) {
                step.classList.add('active');
                step.classList.remove('done');
            } else {
                step.classList.remove('active', 'done');
            }
        });
    }

    function removeThinking(el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    // ===== Utilities =====
    function clearChat() {
        messages = [];
        cachedScreenContext = null;
        screenContextHistory = [];
        chatContainer.innerHTML = '';
        if (welcomeState) {
            chatContainer.appendChild(welcomeState);
            welcomeState.style.display = '';
        }
        if (includePageContext) {
            contextStatus.classList.remove('hidden', 'error');
            contextStatus.classList.add('success');
            contextStatus.textContent = 'Screen context will refresh on your next question';
        }
        userInput.focus();
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        });
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceRepeated(text, pattern, replacement) {
        let output = text;
        while (true) {
            const next = output.replace(pattern, replacement);
            if (next === output) return output;
            output = next;
        }
    }

    function normalizePlainMathSymbols(text) {
        if (!text) return text;

        return text.split('\n').map((line) => {
            if (!/\bpi\b/i.test(line)) return line;

            const looksMathLike = /[=+\-*/^0-9()]|\b(radius|diameter|circumference|area|perimeter|volume|arc|sector|radian|angle|circle|sphere|equation|function|sin|cos|tan)\b/i.test(line);
            if (!looksMathLike) return line;

            return line.replace(/(^|[^A-Za-z])pi(?=[^A-Za-z]|$)/gi, '$1π');
        }).join('\n');
    }

    function latexExprToReadableHtml(expr) {
        if (!expr) return '';

        let out = expr.trim();
        out = out.replace(/\\\\/g, '<br>');
        out = out.replace(/\\left/g, '').replace(/\\right/g, '');
        out = out.replace(/\\,/g, ' ');
        out = out.replace(/\\;/g, ' ');
        out = out.replace(/\\:/g, ' ');
        out = out.replace(/\\!/g, '');

        out = replaceRepeated(out, /\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)');
        out = replaceRepeated(out, /\\sqrt\s*\{([^{}]+)\}/g, 'sqrt($1)');

        out = out.replace(/\\(sin|cos|tan|cot|sec|csc)\s*\^\s*\{-1\}/gi, (_, fn) => `${fn.toLowerCase()}<sup>-1</sup>`);

        const symbolMap = {
            '\\pi': 'π',
            '\\phi': 'phi',
            '\\theta': 'theta',
            '\\alpha': 'alpha',
            '\\beta': 'beta',
            '\\gamma': 'gamma',
            '\\Delta': 'Delta',
            '\\delta': 'delta',
            '\\omega': 'omega',
            '\\lambda': 'lambda',
            '\\mu': 'mu',
            '\\sigma': 'sigma',
            '\\pm': '±',
            '\\times': 'x',
            '\\cdot': '·',
            '\\leq': '<=',
            '\\geq': '>=',
            '\\neq': '!=',
            '\\approx': '~',
            '\\to': '->',
            '\\infty': 'infinity'
        };

        Object.entries(symbolMap).forEach(([latex, readable]) => {
            out = out.replace(new RegExp(escapeRegExp(latex), 'g'), readable);
        });

        out = out.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>');
        out = out.replace(/\^([A-Za-z0-9+\-]+)/g, '<sup>$1</sup>');
        out = out.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>');
        out = out.replace(/_([A-Za-z0-9+\-]+)/g, '<sub>$1</sub>');

        out = out.replace(/\\([{}])/g, '$1');
        out = out.replace(/[{}]/g, '');
        out = out.replace(/\\([A-Za-z]+)/g, '$1');
        out = out.replace(/\s{2,}/g, ' ').trim();

        return out;
    }

    function renderLatexMath(text) {
        if (!text) return text;
        let out = text;

        // Display math: \[ ... \] and $$ ... $$
        out = out.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, expr) => `<span class="math-block">${latexExprToReadableHtml(expr)}</span>`);
        out = out.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_, expr) => `<span class="math-block">${latexExprToReadableHtml(expr)}</span>`);

        // Inline math: \( ... \)
        out = out.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_, expr) => `<span class="math-inline">${latexExprToReadableHtml(expr)}</span>`);

        return out;
    }

    function formatMarkdown(text) {
        if (!text) return '';

        // Escape HTML first
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Store code blocks/inline code as tokens so math conversion skips them
        const codeTokens = [];
        const pushCodeToken = (value) => {
            const token = `@@CODE_TOKEN_${codeTokens.length}@@`;
            codeTokens.push({ token, value });
            return token;
        };

        // Code blocks
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            return pushCodeToken(`<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
        });

        // Inline code
        html = html.replace(/`([^`]+)`/g, (_, code) => pushCodeToken(`<code>${code}</code>`));

        // LaTeX-like math to readable math
        html = renderLatexMath(html);
        html = normalizePlainMathSymbols(html);

        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // Italic
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // Headers
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        // Unordered lists
        html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // Blockquotes
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Horizontal rules
        html = html.replace(/^---$/gm, '<hr>');

        // Line breaks → paragraphs
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');

        // Wrap in paragraph
        if (!html.startsWith('<h') && !html.startsWith('<pre') && !html.startsWith('<ul') && !html.startsWith('<blockquote')) {
            html = `<p>${html}</p>`;
        }

        html = html.replace(/<p><\/p>/g, '');

        // Restore code tokens
        codeTokens.forEach(({ token, value }) => {
            html = html.replace(token, value);
        });

        return html;
    }

    function getErrorText(err) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            return 'Cannot connect to the backend server. Make sure it\'s running:\n\ncd server && node index.js';
        }
        return err.message || 'An unexpected error occurred.';
    }

    // ===== Start =====
    init();
})();
