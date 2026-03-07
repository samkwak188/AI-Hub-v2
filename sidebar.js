// AI Collab — Sidebar Logic
// Chat interface, API communication, page context extraction
// API keys are handled server-side — no key management needed in the extension

(() => {
    'use strict';

    // ===== State =====
    let messages = [];
    let isLoading = false;
    let includePageContext = false;
    let settings = {
        serverUrl: 'http://localhost:3001'
    };

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
    const btnCheckServer = $('#btnCheckServer');
    const settingsModal = $('#settingsModal');
    const contextStatus = $('#contextStatus');

    // ===== Init =====
    function init() {
        loadSettings();
        bindEvents();
        userInput.focus();
    }

    // ===== Settings =====
    function loadSettings() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['aiCollab_settings'], (result) => {
                if (result.aiCollab_settings) {
                    settings = { ...settings, ...result.aiCollab_settings };
                    populateSettingsForm();
                }
            });
        } else {
            const saved = localStorage.getItem('aiCollab_settings');
            if (saved) {
                settings = { ...settings, ...JSON.parse(saved) };
                populateSettingsForm();
            }
        }
    }

    function saveSettings() {
        settings.serverUrl = $('#serverUrl').value.trim() || 'http://localhost:3001';

        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ aiCollab_settings: settings });
        } else {
            localStorage.setItem('aiCollab_settings', JSON.stringify(settings));
        }

        settingsModal.classList.remove('open');
    }

    function populateSettingsForm() {
        $('#serverUrl').value = settings.serverUrl;
    }

    // ===== Events =====
    function bindEvents() {
        btnSend.addEventListener('click', sendMessage);
        btnSettings.addEventListener('click', openSettings);
        btnCloseSettings.addEventListener('click', () => settingsModal.classList.remove('open'));
        btnSaveSettings.addEventListener('click', saveSettings);
        btnNewChat.addEventListener('click', clearChat);
        btnContext.addEventListener('click', togglePageContext);
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
    async function togglePageContext() {
        includePageContext = !includePageContext;
        btnContext.classList.toggle('active', includePageContext);

        if (includePageContext) {
            // Immediately try to extract to give user feedback
            contextStatus.textContent = '📄 Extracting page content...';
            contextStatus.classList.remove('hidden');
            const content = await getPageContent();
            if (content) {
                const charCount = content.content?.length || 0;
                const typeLabel = content.type === 'pdf' ? 'PDF detected' :
                    content.type === 'selection' ? 'Selection captured' :
                        content.type === 'restricted' ? 'Restricted page' :
                            content.type === 'error' ? 'Limited access' :
                                `${charCount} chars extracted`;
                contextStatus.textContent = `📄 ${typeLabel} — ${content.title || 'page'}`;
                contextStatus.classList.add('success');
            } else {
                contextStatus.textContent = '⚠️ Could not access page';
                contextStatus.classList.add('error');
            }
        } else {
            contextStatus.classList.add('hidden');
            contextStatus.classList.remove('success', 'error');
            contextStatus.textContent = '';
        }
    }

    async function getPageContent() {
        if (!includePageContext) return null;

        return new Promise((resolve) => {
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('Page context error:', chrome.runtime.lastError);
                        resolve(null);
                    } else if (!response) {
                        console.error('Page context: empty response');
                        resolve(null);
                    } else {
                        // Always return the response — even error types have useful info
                        resolve(response);
                    }
                });
            } else {
                // Not running as extension (e.g., opened as file directly)
                resolve(null);
            }
        });
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

        // Get page context if enabled
        const pageContext = await getPageContent();

        // Show thinking indicator
        const thinkingEl = showThinking();

        try {
            const response = await callBackend(text, pageContext, thinkingEl);
            removeThinking(thinkingEl);

            if (response.error) {
                addErrorMessage(response.error);
            } else {
                addAssistantMessage(response);
            }
        } catch (err) {
            removeThinking(thinkingEl);
            addErrorMessage(getErrorText(err));
        }

        isLoading = false;
        btnSend.disabled = !userInput.value.trim();
        scrollToBottom();
    }

    // ===== API Call =====
    async function callBackend(message, pageContext, thinkingEl) {
        const url = `${settings.serverUrl}/api/chat`;

        const body = { message };

        if (pageContext) {
            body.context = pageContext;
        }

        // Conversation history (last 10 messages for context)
        body.history = messages.slice(-10).map(m => ({
            role: m.role,
            content: m.content
        }));

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
            rounds: response.rounds
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
            details.innerHTML = renderRounds(response.rounds);

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

    function renderRounds(rounds) {
        const roundNames = ['Independent Answers', 'Peer Critique', 'Final Synthesis'];
        let html = '';

        rounds.forEach((round, i) => {
            html += `<div class="round-card">
        <div class="round-header">
          <span class="round-number">Round ${i + 1}</span>
          <span class="round-title">${roundNames[i] || `Round ${i + 1}`}</span>
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
        <span class="progress-step" data-round="2">R2 Critique</span>
        <span class="progress-step" data-round="3">R3 Synthesize</span>
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
        chatContainer.innerHTML = '';
        if (welcomeState) {
            chatContainer.appendChild(welcomeState);
            welcomeState.style.display = '';
        }
        userInput.focus();
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        });
    }

    function formatMarkdown(text) {
        if (!text) return '';

        // Escape HTML first
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Code blocks
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
        });

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

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
