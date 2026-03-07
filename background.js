// AI Collab — Background Service Worker (Manifest V3)
// Opens the side panel when the extension icon is clicked
// Handles screenshot capture and page content extraction

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set panel behavior:', error));

// Listen for messages from sidebar
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ===== Screenshot Capture =====
    if (message.type === 'CAPTURE_SCREENSHOT') {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (!tabs[0]?.id) {
                sendResponse({ error: 'No active tab found' });
                return;
            }

            const tab = tabs[0];

            try {
                // Capture the visible tab as JPEG (smaller than PNG, good enough for vision)
                const dataUrl = await chrome.tabs.captureVisibleTab(null, {
                    format: 'jpeg',
                    quality: 85
                });

                sendResponse({
                    screenshot: dataUrl,  // "data:image/jpeg;base64,..."
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            } catch (err) {
                console.error('Screenshot capture error:', err);
                sendResponse({
                    error: err.message,
                    title: tab.title || 'Unknown',
                    url: tab.url || 'Unknown'
                });
            }
        });

        return true; // Keep message channel open for async response
    }

    // ===== Text Content Extraction (fallback) =====
    if (message.type === 'GET_PAGE_CONTENT') {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (!tabs[0]?.id) {
                sendResponse({ error: 'No active tab found' });
                return;
            }

            const tab = tabs[0];
            const baseInfo = {
                title: tab.title || 'Unknown',
                url: tab.url || 'Unknown',
            };

            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
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
                    }
                });

                sendResponse(results[0]?.result || { ...baseInfo, content: '[Extraction failed]', type: 'error' });
            } catch (err) {
                sendResponse({ ...baseInfo, content: `[Extraction error: ${err.message}]`, type: 'error' });
            }
        });

        return true;
    }
});
