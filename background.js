// AI Collab — Background Service Worker (Manifest V3)
// Opens the side panel when the extension icon is clicked
// Handles screenshot/page extraction and browser-agent actions (scroll + targeted capture)

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set panel behavior:', error));

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendAgentProgress(status, meta = {}) {
    try {
        await chrome.runtime.sendMessage({
            type: 'AGENT_PROGRESS',
            status,
            meta
        });
    } catch {
        // Sidebar may not be listening; capture should still continue.
    }
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) {
        throw new Error('No active tab found');
    }
    return tabs[0];
}

async function executeOnTab(tabId, func, args = []) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args
    });
    return results[0]?.result;
}

async function captureActiveTabScreenshot() {
    return chrome.tabs.captureVisibleTab(null, {
        format: 'jpeg',
        quality: 85
    });
}

async function animateScrollTo(tabId, targetTop, rootSelector = '', durationMs = 900) {
    return executeOnTab(
        tabId,
        async (top, selector, duration) => {
            const root = selector ? document.querySelector(selector) : null;
            const useElementRoot = !!(root && root.scrollHeight > root.clientHeight);
            const getY = () => useElementRoot ? root.scrollTop : window.scrollY;
            const setY = (nextTop) => {
                const safeTop = Math.max(0, Number(nextTop) || 0);
                if (useElementRoot) {
                    root.scrollTop = safeTop;
                } else {
                    window.scrollTo(0, safeTop);
                }
            };

            const start = Number(getY()) || 0;
            const end = Math.max(0, Number(top) || 0);
            const delta = end - start;
            if (Math.abs(delta) < 2) {
                setY(end);
                await new Promise((resolve) => setTimeout(resolve, 80));
                return {
                    y: Math.round(getY()),
                    scrollMode: useElementRoot ? 'element' : 'window'
                };
            }

            const totalDuration = Math.max(260, Math.min(1800, Number(duration) || 900));
            const easeInOut = (t) => (t < 0.5)
                ? 4 * t * t * t
                : 1 - Math.pow(-2 * t + 2, 3) / 2;

            await new Promise((resolve) => {
                const startedAt = performance.now();
                const step = (now) => {
                    const elapsed = now - startedAt;
                    const progress = Math.min(1, elapsed / totalDuration);
                    const eased = easeInOut(progress);
                    setY(start + (delta * eased));
                    if (progress < 1) {
                        requestAnimationFrame(step);
                    } else {
                        resolve();
                    }
                };
                requestAnimationFrame(step);
            });

            setY(end);
            await new Promise((resolve) => setTimeout(resolve, 140));
            return {
                y: Math.round(getY()),
                scrollMode: useElementRoot ? 'element' : 'window'
            };
        },
        [targetTop, rootSelector, durationMs]
    );
}

function isExhaustiveTaskGoal(goal = '') {
    const text = String(goal || '').toLowerCase();
    const hasScopeWord = /\b(all|every|entire|whole|complete|full)\b/.test(text);
    const hasTaskWord = /\b(question|questions|problem|problems|exercise|exercises|task|tasks|worksheet|page|shown)\b/.test(text);
    const hasSolvePattern = /\bsolve\b/.test(text) && hasTaskWord;
    return (hasScopeWord && hasTaskWord) || hasSolvePattern;
}

function mergeQuestionCandidates(candidates = [], maxCount = 24) {
    const merged = [];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;

        const existingIndex = merged.findIndex((existing) => {
            const sameSelector = candidate.selector && existing.selector && candidate.selector === existing.selector;
            if (sameSelector) return true;

            const closeTop = Math.abs(Number(existing.top || 0) - Number(candidate.top || 0)) < 120;
            const similarHeight = Math.abs(Number(existing.height || 0) - Number(candidate.height || 0)) < 160;
            const similarText = String(existing.snippet || '').slice(0, 80) === String(candidate.snippet || '').slice(0, 80);
            return closeTop && (similarHeight || similarText);
        });

        if (existingIndex >= 0) {
            const existing = merged[existingIndex];
            if (Number(candidate.score || 0) > Number(existing.score || 0)) {
                merged[existingIndex] = { ...existing, ...candidate };
            }
        } else {
            merged.push(candidate);
        }
    }

    return merged
        .sort((a, b) => Number(a.top || 0) - Number(b.top || 0))
        .slice(0, maxCount);
}

async function collectQuestionCandidatesAtCurrentPosition(tabId, goal, rootSelector, maxCandidates = 12) {
    return executeOnTab(
        tabId,
        (goalText, selector, requestedCount) => {
            const normalizeText = (value, maxLen = 1200) => String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, maxLen);

            const esc = (value) => {
                if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
                return String(value).replace(/["\\]/g, '\\$&');
            };

            const cssPath = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
                if (el.id) return `#${esc(el.id)}`;

                const parts = [];
                let node = el;
                for (let depth = 0; node && depth < 7 && node.nodeType === Node.ELEMENT_NODE; depth += 1) {
                    let part = node.nodeName.toLowerCase();
                    if (node.classList && node.classList.length > 0) {
                        const cls = Array.from(node.classList).slice(0, 2).map(c => esc(c)).join('.');
                        if (cls) part += `.${cls}`;
                    }

                    const parent = node.parentElement;
                    if (parent) {
                        const same = Array.from(parent.children).filter(c => c.nodeName === node.nodeName);
                        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
                    }

                    parts.unshift(part);
                    const selectorText = parts.join(' > ');
                    try {
                        if (document.querySelectorAll(selectorText).length === 1) return selectorText;
                    } catch {
                        // Continue climbing.
                    }
                    node = parent;
                }

                return parts.join(' > ');
            };

            const root = selector ? document.querySelector(selector) : null;
            const canScrollRoot = !!(root && root.scrollHeight > root.clientHeight);
            const rootRect = canScrollRoot ? root.getBoundingClientRect() : null;
            const viewportTop = canScrollRoot ? rootRect.top : 0;
            const viewportBottom = canScrollRoot ? rootRect.bottom : window.innerHeight;
            const scrollTop = canScrollRoot ? root.scrollTop : window.scrollY;

            const projectTop = (rectTop) => canScrollRoot
                ? Math.max(0, Math.round(rectTop - rootRect.top + root.scrollTop))
                : Math.max(0, Math.round(rectTop + window.scrollY));

            const isVisibleNow = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 36) return false;
                if (rect.bottom < viewportTop || rect.top > viewportBottom) return false;
                if (rect.right < 0 || rect.left > window.innerWidth) return false;
                return true;
            };

            const stopWords = new Set([
                'the', 'this', 'that', 'with', 'from', 'into', 'your', 'you', 'and', 'for', 'are', 'can', 'please',
                'show', 'solve', 'what', 'when', 'where', 'which', 'about', 'using', 'need', 'help', 'page', 'screen',
                'question', 'questions', 'answer', 'answers', 'find', 'give', 'tell'
            ]);

            const goalKeywords = normalizeText(goalText, 800)
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter(word => word.length >= 4 && !stopWords.has(word));

            const scoreCandidate = (el, text) => {
                const lower = text.toLowerCase();
                const classAndId = `${el.className || ''} ${el.id || ''} ${el.getAttribute('data-testid') || ''}`.toLowerCase();
                const interactiveCount = el.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]').length;
                const hasQuestionWord = /(question|problem|exercise|task|quiz|prompt)/i.test(classAndId) || /(question|problem|exercise|task|quiz|prompt)/i.test(lower);
                const hasInstructionVerb = /(solve|find|determine|calculate|evaluate|simplify|choose|select|compute|what is|which)/i.test(lower);
                const hasChoicePattern = /(\b[a-d]\)|\b[a-d]\.|①|②|③|④|\(\s*[a-d]\s*\))/i.test(lower);
                const hasMathSignal = /[=+\-*/^]|sqrt|graph|table|chart|plot|function|slope|intercept|triangle|angle/.test(lower);
                let keywordOverlap = 0;
                for (const kw of goalKeywords) {
                    if (lower.includes(kw)) keywordOverlap += 1;
                }

                let score = 0;
                if (hasQuestionWord) score += 7;
                if (lower.includes('?')) score += 4;
                if (hasInstructionVerb) score += 4;
                if (hasChoicePattern) score += 3;
                if (hasMathSignal) score += 3;
                if (interactiveCount > 0) score += Math.min(6, interactiveCount * 2);
                if (keywordOverlap > 0) score += Math.min(10, keywordOverlap * 2);
                if (text.length >= 80 && text.length <= 1600) score += 2;
                return {
                    score,
                    keywordOverlap,
                    interactiveCount
                };
            };

            const candidateMap = new Map();
            const upsertCandidate = (el, source) => {
                if (!el || !isVisibleNow(el)) return;
                const rect = el.getBoundingClientRect();
                if (rect.width < 180 || rect.height < 44) return;

                const text = normalizeText(el.innerText || el.textContent || '', 1400);
                if (text.length < 24) return;

                const scoring = scoreCandidate(el, text);
                if (scoring.score < 8) return;

                const selectorText = cssPath(el);
                const projectedTop = projectTop(rect.top);
                const key = selectorText || `${projectedTop}:${Math.round(rect.height)}:${text.slice(0, 80)}`;
                const candidate = {
                    selector: selectorText,
                    source,
                    score: Number(scoring.score.toFixed(2)),
                    keywordOverlap: scoring.keywordOverlap,
                    interactiveCount: scoring.interactiveCount,
                    top: projectedTop,
                    left: Math.max(0, Math.round(rect.left)),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    snippet: text
                };

                const existing = candidateMap.get(key);
                if (!existing || candidate.score > existing.score) {
                    candidateMap.set(key, candidate);
                }
            };

            const containerSelector = [
                '[data-testid*="question" i]',
                '[data-qa*="question" i]',
                '[class*="question" i]',
                '[id*="question" i]',
                '[class*="problem" i]',
                '[id*="problem" i]',
                '[class*="exercise" i]',
                '[id*="exercise" i]',
                '[class*="quiz" i]',
                '[id*="quiz" i]',
                '[class*="assessment" i]',
                '[id*="assessment" i]',
                'fieldset',
                'form'
            ].join(',');

            Array.from(document.querySelectorAll(containerSelector)).slice(0, 300).forEach((el) => upsertCandidate(el, 'container'));
            Array.from(document.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]'))
                .slice(0, 500)
                .forEach((node) => {
                    if (!isVisibleNow(node)) return;
                    const container = node.closest('fieldset, form, li, article, section, div, tr, td') || node.parentElement || node;
                    upsertCandidate(container, 'interactive');
                });
            Array.from(document.querySelectorAll('h1, h2, h3, h4, p, li, td, label, strong, em, div'))
                .slice(0, 1800)
                .forEach((node) => {
                    if (!isVisibleNow(node)) return;
                    const text = normalizeText(node.textContent || '', 500);
                    if (text.length < 28) return;
                    if (!/(\?|question|problem|exercise|solve|find|determine|calculate|compute|graph|table|chart)/i.test(text)) return;
                    const container = node.closest('li, article, section, fieldset, form, tr, td, div') || node;
                    upsertCandidate(container, 'text');
                });

            return {
                scrollTop: Math.round(scrollTop),
                candidates: Array.from(candidateMap.values())
                    .sort((a, b) => Number(a.top || 0) - Number(b.top || 0))
                    .slice(0, Math.max(4, Math.min(24, Number(requestedCount) || 12)))
            };
        },
        [String(goal || ''), String(rootSelector || ''), maxCandidates]
    );
}

async function getPageContent(tabId) {
    return executeOnTab(tabId, () => {
        const selection = window.getSelection()?.toString();
        if (selection && selection.length > 50) {
            return {
                title: document.title,
                url: window.location.href,
                content: selection.substring(0, 10000),
                type: 'selection'
            };
        }

        const mainEl = document.querySelector('article') ||
            document.querySelector('main') ||
            document.querySelector('[role="main"]') ||
            document.body;

        const clone = mainEl.cloneNode(true);
        clone.querySelectorAll('script, style, nav, header, footer, aside, iframe, svg, [role="navigation"], [role="banner"], [role="complementary"], [aria-hidden="true"]')
            .forEach(el => el.remove());

        const text = clone.innerText
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 10000);

        return {
            title: document.title,
            url: window.location.href,
            content: text || `[No extractable text. Title: ${document.title}]`,
            type: text ? 'page' : 'empty'
        };
    });
}

async function getAgentPageState(tabId, includeScreenshot = true) {
    const state = await executeOnTab(
        tabId,
        (maxContentChars, maxElements) => {
            const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
                const rect = el.getBoundingClientRect();
                if (rect.width < 4 || rect.height < 4) return false;
                if (rect.bottom < 0 || rect.right < 0) return false;
                if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
                return true;
            };

            const esc = (value) => {
                if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
                return String(value).replace(/["\\]/g, '\\$&');
            };

            const cssPath = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
                if (el.id) return `#${esc(el.id)}`;

                const parts = [];
                let node = el;
                for (let depth = 0; node && depth < 6 && node.nodeType === Node.ELEMENT_NODE; depth += 1) {
                    let part = node.nodeName.toLowerCase();

                    if (node.classList && node.classList.length > 0) {
                        const cls = Array.from(node.classList).slice(0, 2).map(c => esc(c)).join('.');
                        if (cls) part += `.${cls}`;
                    }

                    const parent = node.parentElement;
                    if (parent) {
                        const same = Array.from(parent.children).filter(c => c.nodeName === node.nodeName);
                        if (same.length > 1) {
                            part += `:nth-of-type(${same.indexOf(node) + 1})`;
                        }
                    }

                    parts.unshift(part);
                    const selector = parts.join(' > ');
                    try {
                        if (document.querySelectorAll(selector).length === 1) {
                            return selector;
                        }
                    } catch {
                        // Keep climbing if selector was invalid for some edge case.
                    }
                    node = parent;
                }

                return parts.join(' > ');
            };

            const getLabel = (el) => {
                const aria = el.getAttribute('aria-label');
                if (aria && aria.trim()) return aria.trim();
                const placeholder = el.getAttribute('placeholder');
                if (placeholder && placeholder.trim()) return placeholder.trim();
                const title = el.getAttribute('title');
                if (title && title.trim()) return title.trim();
                const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                if (txt) return txt.slice(0, 120);
                return '';
            };

            const interactiveSelector = [
                'button',
                'a[href]',
                'input',
                'textarea',
                'select',
                '[role="button"]',
                '[role="link"]',
                '[contenteditable="true"]',
                '[data-testid]'
            ].join(',');

            const all = Array.from(document.querySelectorAll(interactiveSelector))
                .filter(visible)
                .slice(0, maxElements);

            const elements = all.map((el, idx) => {
                const rect = el.getBoundingClientRect();
                const selector = cssPath(el);
                return {
                    elementId: `e${idx + 1}`,
                    selector,
                    tag: el.tagName.toLowerCase(),
                    type: (el.getAttribute('type') || '').toLowerCase(),
                    role: (el.getAttribute('role') || '').toLowerCase(),
                    label: getLabel(el),
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    enabled: !el.disabled
                };
            });

            const pageText = (document.body?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, maxContentChars);

            return {
                title: document.title || 'Unknown',
                url: window.location.href || 'Unknown',
                content: pageText,
                scroll: {
                    x: Math.round(window.scrollX),
                    y: Math.round(window.scrollY),
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    documentHeight: document.documentElement.scrollHeight
                },
                elements
            };
        },
        [12000, 80]
    );

    if (!includeScreenshot) return state;

    const screenshot = await captureActiveTabScreenshot().catch(() => null);
    return { ...state, screenshot };
}

async function captureFullPageFrames(tabId, maxShots = 6) {
    await sendAgentProgress('Inspecting page scroll structure...');
    const initialState = await executeOnTab(tabId, () => {
        const esc = (value) => {
            if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
            return String(value).replace(/["\\]/g, '\\$&');
        };

        const cssPath = (el) => {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
            if (el.id) return `#${esc(el.id)}`;

            const parts = [];
            let node = el;
            for (let depth = 0; node && depth < 7 && node.nodeType === Node.ELEMENT_NODE; depth += 1) {
                let part = node.nodeName.toLowerCase();
                if (node.classList && node.classList.length > 0) {
                    const cls = Array.from(node.classList).slice(0, 2).map(c => esc(c)).join('.');
                    if (cls) part += `.${cls}`;
                }

                const parent = node.parentElement;
                if (parent) {
                    const same = Array.from(parent.children).filter(c => c.nodeName === node.nodeName);
                    if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
                }

                parts.unshift(part);
                const selector = parts.join(' > ');
                try {
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch {
                    // Continue climbing.
                }
                node = parent;
            }

            return parts.join(' > ');
        };

        const isScrollableContainer = (el) => {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
            const style = window.getComputedStyle(el);
            if (!style) return false;

            const overflowY = String(style.overflowY || '').toLowerCase();
            if (!['auto', 'scroll', 'overlay'].includes(overflowY)) return false;
            if (el.clientHeight < 140 || el.clientWidth < 180) return false;

            const rect = el.getBoundingClientRect();
            if (rect.width < 180 || rect.height < 120) return false;

            const scrollable = el.scrollHeight - el.clientHeight;
            return scrollable > Math.max(120, el.clientHeight * 0.15);
        };

        const resolveScrollRoot = () => {
            const docScroller = document.scrollingElement || document.documentElement;
            const windowScrollable = Math.max(0, docScroller.scrollHeight - window.innerHeight);

            let bestEl = null;
            let bestScore = -1;
            const pool = Array.from(document.querySelectorAll('main, [role="main"], article, section, div')).slice(0, 2200);
            for (const el of pool) {
                if (!isScrollableContainer(el)) continue;
                const scrollable = Math.max(0, el.scrollHeight - el.clientHeight);
                const hints = `${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''}`.toLowerCase();
                let score = scrollable + Math.min(2200, el.clientHeight * 2);
                if (/(main|content|question|problem|exercise|worksheet|assessment|quiz|task)/.test(hints)) score += 520;
                if (score > bestScore) {
                    bestScore = score;
                    bestEl = el;
                }
            }

            if (bestEl) {
                const bestScrollable = Math.max(0, bestEl.scrollHeight - bestEl.clientHeight);
                if (windowScrollable === 0 || bestScrollable >= windowScrollable * 0.72) {
                    const selector = cssPath(bestEl);
                    if (selector) {
                        return {
                            kind: 'element',
                            selector,
                            viewportHeight: Math.max(1, bestEl.clientHeight),
                            documentHeight: Math.max(bestEl.clientHeight, bestEl.scrollHeight),
                            currentTop: Math.round(bestEl.scrollTop)
                        };
                    }
                }
            }

            return {
                kind: 'window',
                selector: '',
                viewportHeight: Math.max(1, window.innerHeight),
                documentHeight: Math.max(window.innerHeight, docScroller.scrollHeight),
                currentTop: Math.round(window.scrollY)
            };
        };

        const scrollRoot = resolveScrollRoot();
        return {
            title: document.title || 'Unknown',
            url: window.location.href || 'Unknown',
            startY: Math.max(0, Number(scrollRoot.currentTop || 0)),
            viewportHeight: Math.max(1, Number(scrollRoot.viewportHeight || window.innerHeight || 1)),
            documentHeight: Math.max(1, Number(scrollRoot.documentHeight || document.documentElement.scrollHeight || 1)),
            content: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000),
            scrollRoot
        };
    });

    const viewportHeight = Math.max(1, Number(initialState?.viewportHeight || 1));
    const documentHeight = Math.max(viewportHeight, Number(initialState?.documentHeight || viewportHeight));
    const startY = Math.max(0, Number(initialState?.startY || 0));
    const title = String(initialState?.title || 'Unknown');
    const url = String(initialState?.url || 'Unknown');
    const content = String(initialState?.content || '');
    const scrollRootSelector = String(initialState?.scrollRoot?.selector || '');
    const scrollMode = String(initialState?.scrollRoot?.kind || 'window');

    const safeMaxShots = Math.max(2, Math.min(10, Number(maxShots) || 6));
    const scrollable = Math.max(0, documentHeight - viewportHeight);

    const positions = [];
    if (scrollable === 0) {
        positions.push(0);
    } else {
        for (let i = 0; i < safeMaxShots; i += 1) {
            const ratio = safeMaxShots === 1 ? 0 : (i / (safeMaxShots - 1));
            positions.push(Math.round(scrollable * ratio));
        }
    }

    const uniquePositions = Array.from(new Set(positions));
    const frames = [];

    for (let i = 0; i < uniquePositions.length; i += 1) {
        const y = uniquePositions[i];
        await sendAgentProgress(`Scanning page section ${i + 1}/${uniquePositions.length}...`, {
            phase: 'full-page',
            step: i + 1,
            total: uniquePositions.length
        });
        const settled = await animateScrollTo(tabId, y, scrollRootSelector, 950);
        const settledY = Number.isFinite(Number(settled?.y)) ? Number(settled.y) : y;

        const screenshot = await captureActiveTabScreenshot();
        frames.push({
            title,
            url,
            type: 'page',
            content,
            screenshot,
            capturedAt: new Date().toISOString(),
            scroll: {
                y: Math.round(Number(settledY || 0)),
                viewportHeight,
                documentHeight
            }
        });
        await sendAgentProgress(`Captured page section ${i + 1}/${uniquePositions.length}.`, {
            phase: 'full-page',
            step: i + 1,
            total: uniquePositions.length
        });
    }

    await sendAgentProgress('Restoring page position...');
    await animateScrollTo(tabId, startY, scrollRootSelector, 720);

    return {
        frames,
        metrics: {
            mode: 'full-page',
            scrollMode,
            viewportHeight,
            documentHeight,
            capturedShots: frames.length
        }
    };
}

async function captureQuestionFocusedFrames(tabId, goal, maxShots = 6) {
    const safeMaxShots = Math.max(2, Math.min(10, Number(maxShots) || 6));
    const exhaustiveGoal = isExhaustiveTaskGoal(goal);
    const detectionCandidateLimit = exhaustiveGoal
        ? Math.max(16, safeMaxShots * 2)
        : Math.max(10, safeMaxShots * 2);

    await sendAgentProgress('Detecting question blocks on page...');
    const detection = await executeOnTab(
        tabId,
        (goalText, requestedCount) => {
            const normalizeText = (value, maxLen = 1200) => String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, maxLen);

            const isRenderable = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 36) return false;
                if (rect.width > window.innerWidth * 1.35) return false;
                if (rect.height > window.innerHeight * 2.4) return false;
                return true;
            };

            const esc = (value) => {
                if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
                return String(value).replace(/["\\]/g, '\\$&');
            };

            const cssPath = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
                if (el.id) return `#${esc(el.id)}`;

                const parts = [];
                let node = el;
                for (let depth = 0; node && depth < 7 && node.nodeType === Node.ELEMENT_NODE; depth += 1) {
                    let part = node.nodeName.toLowerCase();

                    if (node.classList && node.classList.length > 0) {
                        const cls = Array.from(node.classList).slice(0, 2).map(c => esc(c)).join('.');
                        if (cls) part += `.${cls}`;
                    }

                    const parent = node.parentElement;
                    if (parent) {
                        const same = Array.from(parent.children).filter(c => c.nodeName === node.nodeName);
                        if (same.length > 1) {
                            part += `:nth-of-type(${same.indexOf(node) + 1})`;
                        }
                    }

                    parts.unshift(part);
                    const selector = parts.join(' > ');
                    try {
                        if (document.querySelectorAll(selector).length === 1) return selector;
                    } catch {
                        // Continue to parent.
                    }
                    node = parent;
                }

                return parts.join(' > ');
            };

            const isScrollableContainer = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
                const style = window.getComputedStyle(el);
                if (!style) return false;

                const overflowY = String(style.overflowY || '').toLowerCase();
                if (!['auto', 'scroll', 'overlay'].includes(overflowY)) return false;
                if (el.clientHeight < 120 || el.clientWidth < 180) return false;

                const scrollable = el.scrollHeight - el.clientHeight;
                return scrollable > Math.max(120, el.clientHeight * 0.15);
            };

            const resolveScrollRoot = () => {
                const docScroller = document.scrollingElement || document.documentElement;
                const windowScrollable = Math.max(0, docScroller.scrollHeight - window.innerHeight);

                let bestEl = null;
                let bestScore = -1;
                const pool = Array.from(document.querySelectorAll('main, [role="main"], article, section, div')).slice(0, 2200);
                for (const el of pool) {
                    if (!isScrollableContainer(el)) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 180 || rect.height < 100) continue;

                    const scrollable = Math.max(0, el.scrollHeight - el.clientHeight);
                    const hints = `${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''}`.toLowerCase();
                    let score = scrollable + Math.min(2200, el.clientHeight * 2);
                    if (/(main|content|question|problem|exercise|worksheet|assessment|quiz|task)/.test(hints)) score += 520;

                    if (score > bestScore) {
                        bestScore = score;
                        bestEl = el;
                    }
                }

                if (bestEl) {
                    const bestScrollable = Math.max(0, bestEl.scrollHeight - bestEl.clientHeight);
                    if (windowScrollable === 0 || bestScrollable >= windowScrollable * 0.72) {
                        const selector = cssPath(bestEl);
                        if (selector) {
                            return {
                                kind: 'element',
                                selector,
                                viewportHeight: Math.max(1, bestEl.clientHeight),
                                documentHeight: Math.max(bestEl.clientHeight, bestEl.scrollHeight),
                                currentTop: Math.round(bestEl.scrollTop)
                            };
                        }
                    }
                }

                return {
                    kind: 'window',
                    selector: '',
                    viewportHeight: Math.max(1, window.innerHeight),
                    documentHeight: Math.max(window.innerHeight, docScroller.scrollHeight),
                    currentTop: Math.round(window.scrollY)
                };
            };

            const scrollRoot = resolveScrollRoot();
            const rootElement = scrollRoot.kind === 'element' && scrollRoot.selector
                ? document.querySelector(scrollRoot.selector)
                : null;
            const rootRect = rootElement ? rootElement.getBoundingClientRect() : null;

            const projectTopToScrollRoot = (rectTop) => {
                if (rootElement && rootRect) {
                    return Math.max(0, Math.round(rectTop - rootRect.top + rootElement.scrollTop));
                }
                return Math.max(0, Math.round(rectTop + window.scrollY));
            };

            const stopWords = new Set([
                'the', 'this', 'that', 'with', 'from', 'into', 'your', 'you', 'and', 'for', 'are', 'can', 'please',
                'show', 'solve', 'what', 'when', 'where', 'which', 'about', 'using', 'need', 'help', 'page', 'screen',
                'question', 'questions', 'answer', 'answers', 'find', 'give', 'tell'
            ]);

            const goalKeywords = normalizeText(goalText, 800)
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter(word => word.length >= 4 && !stopWords.has(word));

            const scoreCandidate = (el, text) => {
                const lower = text.toLowerCase();
                const classAndId = `${el.className || ''} ${el.id || ''} ${el.getAttribute('data-testid') || ''}`.toLowerCase();
                const interactiveCount = el.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]').length;
                const hasQuestionMark = lower.includes('?');
                const hasQuestionWord = /(question|problem|exercise|task|quiz|prompt)/i.test(classAndId) || /(question|problem|exercise|task|quiz|prompt)/i.test(lower);
                const hasNumberedPrefix = /(^|\s)(q\s*\d+|question\s*\d+|problem\s*\d+|exercise\s*\d+|\d+\s*[\)\.\:])/i.test(lower);
                const hasInstructionVerb = /(solve|find|determine|calculate|evaluate|simplify|choose|select|compute|what is|which)/i.test(lower);
                const hasChoicePattern = /(\b[a-d]\)|\b[a-d]\.|①|②|③|④|\(\s*[a-d]\s*\))/i.test(lower);
                const hasMathSignal = /[=+\-*/^]|sqrt|graph|table|chart|plot|function|slope|intercept|triangle|angle/.test(lower);

                let keywordOverlap = 0;
                if (goalKeywords.length > 0) {
                    for (const kw of goalKeywords) {
                        if (lower.includes(kw)) keywordOverlap += 1;
                    }
                }

                let score = 0;
                if (hasQuestionWord) score += 7;
                if (hasQuestionMark) score += 4;
                if (hasNumberedPrefix) score += 4;
                if (hasInstructionVerb) score += 4;
                if (hasChoicePattern) score += 3;
                if (hasMathSignal) score += 3;
                if (interactiveCount > 0) score += Math.min(6, interactiveCount * 2);
                if (keywordOverlap > 0) score += Math.min(10, keywordOverlap * 2);
                if (text.length >= 80 && text.length <= 1400) score += 2;
                if (text.length > 2200) score -= 2;

                return {
                    score,
                    keywordOverlap,
                    interactiveCount
                };
            };

            const candidateMap = new Map();
            const maxCandidates = Math.max(6, Math.min(24, Number(requestedCount) || 12));

            const upsertCandidate = (el, source) => {
                if (!el || !isRenderable(el)) return;
                const rect = el.getBoundingClientRect();
                if (rect.width < 180 || rect.height < 44) return;

                const text = normalizeText(el.innerText || el.textContent || '', 1400);
                if (text.length < 24) return;

                const scoring = scoreCandidate(el, text);
                if (scoring.score < 8) return;

                const selector = cssPath(el);
                const projectedTop = projectTopToScrollRoot(rect.top);
                const key = selector || `${projectedTop}:${Math.round(rect.height)}:${text.slice(0, 80)}`;
                const candidate = {
                    selector,
                    source,
                    score: Number(scoring.score.toFixed(2)),
                    keywordOverlap: scoring.keywordOverlap,
                    interactiveCount: scoring.interactiveCount,
                    top: projectedTop,
                    left: Math.max(0, Math.round(rect.left)),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    snippet: text
                };

                const existing = candidateMap.get(key);
                if (!existing || candidate.score > existing.score) {
                    candidateMap.set(key, candidate);
                }
            };

            const containerSelector = [
                '[data-testid*="question" i]',
                '[data-qa*="question" i]',
                '[class*="question" i]',
                '[id*="question" i]',
                '[class*="problem" i]',
                '[id*="problem" i]',
                '[class*="exercise" i]',
                '[id*="exercise" i]',
                '[class*="quiz" i]',
                '[id*="quiz" i]',
                '[class*="assessment" i]',
                '[id*="assessment" i]',
                'fieldset',
                'form'
            ].join(',');

            const directContainers = Array.from(document.querySelectorAll(containerSelector)).slice(0, 260);
            for (const el of directContainers) {
                upsertCandidate(el, 'container');
            }

            const interactiveNodes = Array.from(
                document.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]')
            ).slice(0, 400);

            for (const node of interactiveNodes) {
                if (!isRenderable(node)) continue;
                const container = node.closest('fieldset, form, li, article, section, div, tr, td') || node.parentElement || node;
                upsertCandidate(container, 'interactive');
            }

            const textNodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, li, td, label, strong, em, div')).slice(0, 1600);
            for (const node of textNodes) {
                if (!isRenderable(node)) continue;
                const text = normalizeText(node.textContent || '', 500);
                if (text.length < 28) continue;
                if (!/(\?|question|problem|exercise|solve|find|determine|calculate|compute|graph|table|chart)/i.test(text)) {
                    continue;
                }
                const container = node.closest('li, article, section, fieldset, form, tr, td, div') || node;
                upsertCandidate(container, 'text');
            }

            const sortedByScore = Array.from(candidateMap.values())
                .sort((a, b) => b.score - a.score || a.top - b.top);

            const deduped = [];
            for (const candidate of sortedByScore) {
                const overlaps = deduped.some((existing) => {
                    const verticalDistance = Math.abs(existing.top - candidate.top);
                    const sameBand = verticalDistance < Math.max(120, Math.min(existing.height, candidate.height) * 0.65);
                    const horizontalOverlap = Math.abs(existing.left - candidate.left) < Math.max(220, Math.min(existing.width, candidate.width));
                    return sameBand && horizontalOverlap;
                });
                if (!overlaps) deduped.push(candidate);
                if (deduped.length >= maxCandidates * 2) break;
            }

            const finalCandidates = deduped
                .sort((a, b) => a.top - b.top)
                .slice(0, maxCandidates);

            return {
                title: document.title || 'Unknown',
                url: window.location.href || 'Unknown',
                startY: Math.max(0, Number(scrollRoot.currentTop || 0)),
                viewportHeight: Math.max(1, Number(scrollRoot.viewportHeight || window.innerHeight || 1)),
                documentHeight: Math.max(1, Number(scrollRoot.documentHeight || document.documentElement.scrollHeight || 1)),
                pageText: normalizeText(document.body?.innerText || '', 12000),
                goalKeywords,
                candidates: finalCandidates,
                scrollRoot
            };
        },
        [String(goal || ''), detectionCandidateLimit]
    );

    const viewportHeight = Math.max(1, Number(detection?.viewportHeight || 1));
    const documentHeight = Math.max(viewportHeight, Number(detection?.documentHeight || viewportHeight));
    const scrollable = Math.max(0, documentHeight - viewportHeight);
    const startY = Math.max(0, Number(detection?.startY || 0));
    const title = String(detection?.title || 'Unknown');
    const url = String(detection?.url || 'Unknown');
    const pageText = String(detection?.pageText || '');
    const pageAnchorText = pageText ? pageText.slice(0, 700) : '';
    const initialCandidates = Array.isArray(detection?.candidates) ? detection.candidates : [];
    const scrollRootSelector = String(detection?.scrollRoot?.selector || '');
    const scrollMode = String(detection?.scrollRoot?.kind || 'window');

    let candidates = mergeQuestionCandidates(initialCandidates, exhaustiveGoal ? 28 : 18);

    const shouldSurveyWholePage = exhaustiveGoal || scrollable > Math.round(viewportHeight * 1.15);
    if (shouldSurveyWholePage) {
        const surveyStep = Math.max(260, Math.round(viewportHeight * 0.78));
        const surveyPositions = [];
        for (let y = 0; y <= scrollable; y += surveyStep) {
            surveyPositions.push(Math.max(0, Math.min(scrollable, y)));
        }
        if (surveyPositions[surveyPositions.length - 1] !== scrollable) {
            surveyPositions.push(scrollable);
        }

        const uniqueSurveyPositions = Array.from(new Set(surveyPositions));
        const maxSurveyStops = exhaustiveGoal ? 20 : 12;
        const boundedSurveyPositions = uniqueSurveyPositions.length <= maxSurveyStops
            ? uniqueSurveyPositions
            : Array.from({ length: maxSurveyStops }, (_, index) => {
                const ratio = maxSurveyStops === 1 ? 0 : (index / (maxSurveyStops - 1));
                const mappedIndex = Math.round((uniqueSurveyPositions.length - 1) * ratio);
                return uniqueSurveyPositions[mappedIndex];
            });
        const collectedCandidates = [...candidates];

        await sendAgentProgress(`Surveying full page (${boundedSurveyPositions.length} scan stops)...`, {
            phase: 'question-survey',
            total: boundedSurveyPositions.length,
            exhaustiveGoal
        });

        for (let i = 0; i < boundedSurveyPositions.length; i += 1) {
            const surveyTop = boundedSurveyPositions[i];
            await sendAgentProgress(`Survey scan ${i + 1}/${boundedSurveyPositions.length}...`, {
                phase: 'question-survey',
                step: i + 1,
                total: boundedSurveyPositions.length
            });
            await animateScrollTo(tabId, surveyTop, scrollRootSelector, 820);
            const visiblePass = await collectQuestionCandidatesAtCurrentPosition(
                tabId,
                goal,
                scrollRootSelector,
                exhaustiveGoal ? 18 : 12
            );
            if (Array.isArray(visiblePass?.candidates) && visiblePass.candidates.length > 0) {
                collectedCandidates.push(...visiblePass.candidates);
                candidates = mergeQuestionCandidates(collectedCandidates, exhaustiveGoal ? 32 : 20);
            }
        }
    }

    await sendAgentProgress(
        candidates.length > 0
            ? `Found ${candidates.length} question candidates.`
            : 'No clear question candidates found.',
        {
            phase: 'question-detection',
            candidatesFound: candidates.length
        }
    );

    if (candidates.length === 0) {
        return {
            frames: [],
            metrics: {
                mode: 'question-targeted',
                scrollMode,
                viewportHeight,
                documentHeight,
                candidatesFound: 0,
                capturedShots: 0
            },
            detection: {
                goalKeywords: Array.isArray(detection?.goalKeywords) ? detection.goalKeywords : [],
                candidates: []
            }
        };
    }

    const captureLimit = exhaustiveGoal
        ? Math.max(safeMaxShots, Math.min(18, candidates.length))
        : safeMaxShots;

    const targets = [];
    for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const approxCenter = Math.round(candidate.top + (candidate.height * 0.45));
        const targetY = Math.max(0, Math.min(scrollable, Math.round(approxCenter - (viewportHeight * 0.5))));
        const close = targets.findIndex((item) => Math.abs(item.y - targetY) < Math.max(80, Math.round(viewportHeight * 0.3)));

        if (close >= 0) {
            if (candidate.score > targets[close].candidate.score) {
                targets[close] = { y: targetY, candidate };
            }
        } else {
            targets.push({ y: targetY, candidate });
        }
    }

    const orderedTargets = targets
        .sort((a, b) => a.y - b.y)
        .slice(0, captureLimit);

    const frames = [];
    for (let i = 0; i < orderedTargets.length; i += 1) {
        const target = orderedTargets[i];
        await sendAgentProgress(`Scrolling to question ${i + 1}/${orderedTargets.length}...`, {
            phase: 'question-capture',
            step: i + 1,
            total: orderedTargets.length,
            selector: target.candidate.selector || ''
        });
        const settled = await executeOnTab(
            tabId,
            async (selector, fallbackTop, rootSelector) => {
                const root = rootSelector ? document.querySelector(rootSelector) : null;
                const canScrollRoot = !!(root && root.scrollHeight > root.clientHeight);
                const getY = () => canScrollRoot ? root.scrollTop : window.scrollY;
                const setY = (nextTop) => {
                    const safeTop = Math.max(0, Number(nextTop) || 0);
                    if (canScrollRoot) {
                        root.scrollTop = safeTop;
                    } else {
                        window.scrollTo(0, safeTop);
                    }
                };

                let targetTop = Math.max(0, Number(fallbackTop) || 0);
                if (selector) {
                    const el = document.querySelector(selector);
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        if (canScrollRoot) {
                            const rootRect = root.getBoundingClientRect();
                            targetTop = Math.max(
                                0,
                                Math.round((rect.top - rootRect.top) + root.scrollTop - (root.clientHeight * 0.28))
                            );
                        } else {
                            targetTop = Math.max(
                                0,
                                Math.round(rect.top + window.scrollY - (window.innerHeight * 0.28))
                            );
                        }
                    }
                }

                const start = Number(getY()) || 0;
                const end = targetTop;
                const delta = end - start;
                if (Math.abs(delta) >= 2) {
                    const easeInOut = (t) => (t < 0.5)
                        ? 4 * t * t * t
                        : 1 - Math.pow(-2 * t + 2, 3) / 2;
                    await new Promise((resolve) => {
                        const startedAt = performance.now();
                        const totalDuration = 980;
                        const step = (now) => {
                            const elapsed = now - startedAt;
                            const progress = Math.min(1, elapsed / totalDuration);
                            const eased = easeInOut(progress);
                            setY(start + (delta * eased));
                            if (progress < 1) {
                                requestAnimationFrame(step);
                            } else {
                                resolve();
                            }
                        };
                        requestAnimationFrame(step);
                    });
                } else {
                    setY(end);
                }

                await new Promise((resolve) => setTimeout(resolve, 140));
                return {
                    y: canScrollRoot ? Math.round(root.scrollTop) : Math.round(window.scrollY)
                };
            },
            [target.candidate.selector || '', target.y, scrollRootSelector]
        );

        const finalY = Number.isFinite(Number(settled?.y)) ? Number(settled.y) : target.y;
        await sendAgentProgress(`Capturing question ${i + 1}/${orderedTargets.length}...`, {
            phase: 'question-capture',
            step: i + 1,
            total: orderedTargets.length
        });

        const screenshot = await captureActiveTabScreenshot();

        frames.push({
            title,
            url,
            type: 'question',
            content: pageAnchorText
                ? `Question focus ${i + 1}/${orderedTargets.length}\n${target.candidate.snippet || ''}\n\nPage anchor text:\n${pageAnchorText}`
                : `Question focus ${i + 1}/${orderedTargets.length}\n${target.candidate.snippet || ''}`,
            screenshot,
            capturedAt: new Date().toISOString(),
            scroll: {
                y: Math.round(finalY),
                viewportHeight,
                documentHeight
            },
            focus: {
                mode: 'question-targeted',
                score: target.candidate.score,
                source: target.candidate.source || 'unknown',
                keywordOverlap: target.candidate.keywordOverlap || 0,
                interactiveCount: target.candidate.interactiveCount || 0,
                selector: target.candidate.selector || '',
                top: target.candidate.top,
                height: target.candidate.height
            }
        });
        await sendAgentProgress(`Captured question ${i + 1}/${orderedTargets.length}.`, {
            phase: 'question-capture',
            step: i + 1,
            total: orderedTargets.length
        });
    }

    await sendAgentProgress('Restoring page position...');
    await animateScrollTo(tabId, startY, scrollRootSelector, 760);

    return {
        frames,
        metrics: {
            mode: 'question-targeted',
            scrollMode,
            viewportHeight,
            documentHeight,
            candidatesFound: candidates.length,
            capturedShots: frames.length
        },
        detection: {
            goalKeywords: Array.isArray(detection?.goalKeywords) ? detection.goalKeywords : [],
            candidates: candidates.map((candidate, index) => ({
                rank: index + 1,
                top: candidate.top,
                height: candidate.height,
                score: candidate.score,
                source: candidate.source || 'unknown',
                snippet: String(candidate.snippet || '').slice(0, 220)
            }))
        }
    };
}

async function executeAgentAction(tabId, action) {
    const result = await executeOnTab(
        tabId,
        (inputAction) => {
            const normalize = (v) => String(v || '').trim();
            const actionType = normalize(inputAction?.type).toUpperCase();

            if (actionType === 'SCROLL') {
                const direction = normalize(inputAction.direction).toLowerCase() || 'down';
                const pixels = Number.isFinite(Number(inputAction.pixels))
                    ? Number(inputAction.pixels)
                    : Math.round(window.innerHeight * 0.75);
                const delta = direction === 'up' ? -Math.abs(pixels) : Math.abs(pixels);
                window.scrollBy({ top: delta, behavior: 'smooth' });
                return {
                    ok: true,
                    type: 'SCROLL',
                    message: `Scrolled ${direction} by ${Math.abs(delta)}px.`,
                    scrollY: Math.round(window.scrollY)
                };
            }

            return {
                ok: false,
                type: actionType || 'UNKNOWN',
                message: `Unsupported action type in scroll-only mode: ${actionType || '(missing)'}`
            };
        },
        [action || {}]
    );

    await sleep(550);
    return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;

    if (!type) return false;
    const handledTypes = new Set([
        'CAPTURE_SCREENSHOT',
        'GET_PAGE_CONTENT',
        'AGENT_GET_PAGE_STATE',
        'AGENT_CAPTURE_QUESTIONS',
        'AGENT_CAPTURE_FULL_PAGE',
        'AGENT_EXECUTE_ACTION'
    ]);
    if (!handledTypes.has(type)) return false;

    (async () => {
        // ===== Screenshot Capture =====
        if (type === 'CAPTURE_SCREENSHOT') {
            const tab = await getActiveTab();
            try {
                const dataUrl = await captureActiveTabScreenshot();
                sendResponse({
                    screenshot: dataUrl,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            } catch (err) {
                sendResponse({
                    error: err.message,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            }
            return;
        }

        // ===== Text Content Extraction =====
        if (type === 'GET_PAGE_CONTENT') {
            const tab = await getActiveTab();
            const baseInfo = {
                title: tab.title || 'Unknown',
                url: tab.url || 'Unknown'
            };

            try {
                const content = await getPageContent(tab.id);
                sendResponse(content || { ...baseInfo, content: '[Extraction failed]', type: 'error' });
            } catch (err) {
                sendResponse({ ...baseInfo, content: `[Extraction error: ${err.message}]`, type: 'error' });
            }
            return;
        }

        // ===== Agent: Snapshot =====
        if (type === 'AGENT_GET_PAGE_STATE') {
            const tab = await getActiveTab();
            try {
                const includeScreenshot = message?.includeScreenshot !== false;
                const state = await getAgentPageState(tab.id, includeScreenshot);
                sendResponse({
                    ok: true,
                    ...state
                });
            } catch (err) {
                sendResponse({
                    ok: false,
                    error: err.message,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            }
            return;
        }

        // ===== Agent: Execute Action =====
        if (type === 'AGENT_EXECUTE_ACTION') {
            const tab = await getActiveTab();
            try {
                if (String(message?.action?.type || '').toUpperCase() === 'WAIT') {
                    const waitMs = Number.isFinite(Number(message?.action?.ms))
                        ? Math.max(0, Math.min(5000, Number(message.action.ms)))
                        : 700;
                    await sleep(waitMs);
                    const refreshedTab = await getActiveTab();
                    sendResponse({
                        ok: true,
                        type: 'WAIT',
                        waitedMs: waitMs,
                        title: refreshedTab.title || 'Unknown',
                        url: refreshedTab.url || 'Unknown'
                    });
                    return;
                }

                const actionResult = await executeAgentAction(tab.id, message?.action || {});
                const refreshedTab = await getActiveTab();
                sendResponse({
                    ...actionResult,
                    title: refreshedTab.title || 'Unknown',
                    url: refreshedTab.url || 'Unknown'
                });
            } catch (err) {
                sendResponse({
                    ok: false,
                    error: err.message,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            }
            return;
        }

        // ===== Agent: Question-targeted capture =====
        if (type === 'AGENT_CAPTURE_QUESTIONS') {
            const tab = await getActiveTab();
            try {
                const maxShots = Number.isFinite(Number(message?.maxShots))
                    ? Number(message.maxShots)
                    : 6;
                const goal = typeof message?.goal === 'string' ? message.goal : '';
                const result = await captureQuestionFocusedFrames(tab.id, goal, maxShots);
                console.log(
                    '[AgentCapture] question-targeted',
                    {
                        scrollMode: result?.metrics?.scrollMode || 'unknown',
                        candidatesFound: Number(result?.metrics?.candidatesFound || 0),
                        capturedShots: Number(result?.metrics?.capturedShots || 0)
                    }
                );
                sendResponse({
                    ok: true,
                    ...result
                });
            } catch (err) {
                sendResponse({
                    ok: false,
                    error: err.message,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            }
            return;
        }

        // ===== Agent: Full-page scroll capture =====
        if (type === 'AGENT_CAPTURE_FULL_PAGE') {
            const tab = await getActiveTab();
            try {
                const maxShots = Number.isFinite(Number(message?.maxShots))
                    ? Number(message.maxShots)
                    : 6;
                const result = await captureFullPageFrames(tab.id, maxShots);
                console.log(
                    '[AgentCapture] full-page',
                    {
                        scrollMode: result?.metrics?.scrollMode || 'unknown',
                        capturedShots: Number(result?.metrics?.capturedShots || 0)
                    }
                );
                sendResponse({
                    ok: true,
                    ...result
                });
            } catch (err) {
                sendResponse({
                    ok: false,
                    error: err.message,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            }
            return;
        }
    })().catch((err) => {
        sendResponse({
            ok: false,
            error: err?.message || String(err)
        });
    });

    // Keep channel open for async response
    return true;
});
