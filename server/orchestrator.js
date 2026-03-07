// AI Collab — Multi-Model Orchestrator
// Runs a 4-round debate: Independent → Cross-Validate → Consensus → Final
// Models: OpenAI GPT-4o-mini (direct) + 3 Cloudflare Workers AI models

const OpenAI = require('openai');
const prompts = require('./prompts');
const MAX_VISION_CACHE_ENTRIES = 100;
const MAX_DIRECT_VISION_IMAGES = 2;
const visionSummaryCache = new Map();

// ===== Provider Call Functions =====

/**
 * Call OpenAI text model.
 */
async function callOpenAI(prompt, apiKey, model = 'gpt-4o-mini') {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.15,
        max_tokens: 2048
    });
    return response.choices[0]?.message?.content || '';
}

/**
 * Call OpenAI with direct image inputs (multimodal).
 */
async function callOpenAIMultimodal(prompt, images, apiKey, model = 'gpt-4o-mini') {
    const client = new OpenAI({ apiKey });
    const safeImages = Array.isArray(images) ? images.filter(img => img?.url).slice(0, MAX_DIRECT_VISION_IMAGES) : [];

    const imageNotes = safeImages.map((img, index) => {
        const defaultLabel = index === 0 ? 'Current screen' : `Previous screen ${index}`;
        return `${index + 1}. ${img.label || defaultLabel} (${img.detail || 'auto'} detail)`;
    }).join('\n');

    const content = [
        {
            type: 'text',
            text: safeImages.length > 0
                ? `${prompt}\n\nAttached screenshot inputs (ordered):\n${imageNotes}\nUse the images directly as visual evidence.`
                : prompt
        },
        ...safeImages.map(img => ({
            type: 'image_url',
            image_url: {
                url: img.url,
                detail: img.detail || 'auto'
            }
        }))
    ];

    const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0.15,
        max_tokens: 2048
    });

    return response.choices[0]?.message?.content || '';
}

/**
 * Analyze a screenshot using OpenAI vision and return a compact summary.
 */
async function callOpenAIVision(prompt, screenshotDataUrl, apiKey, model = 'gpt-4o-mini') {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
        model,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                {
                    type: 'image_url',
                    image_url: {
                        url: screenshotDataUrl,
                        detail: 'high'
                    }
                }
            ]
        }],
        temperature: 0.2,
        max_tokens: 1200
    });
    return response.choices[0]?.message?.content || '';
}

function getScreenshotCacheKey(screenshotDataUrl) {
    if (!screenshotDataUrl) return '';
    let hash = 5381;
    for (let i = 0; i < screenshotDataUrl.length; i += 1) {
        hash = ((hash << 5) + hash) + screenshotDataUrl.charCodeAt(i);
        hash |= 0;
    }
    return `shot_${Math.abs(hash)}`;
}

function cacheVisionSummary(key, summary) {
    if (!key || !summary) return;
    visionSummaryCache.set(key, summary);
    if (visionSummaryCache.size > MAX_VISION_CACHE_ENTRIES) {
        const oldestKey = visionSummaryCache.keys().next().value;
        visionSummaryCache.delete(oldestKey);
    }
}

/**
 * Call Cloudflare Workers AI via REST API
 * Endpoint: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
 */
async function callCloudflare(prompt, accountId, apiToken, model) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: 0.15,
            max_tokens: 2048
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Cloudflare Workers AI error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();

    // Cloudflare returns { result: { response: "..." }, success: true }
    if (data.result?.response) {
        return data.result.response;
    }

    // Some models return in messages format
    if (data.result?.choices?.[0]?.message?.content) {
        return data.result.choices[0].message.content;
    }

    throw new Error('Unexpected Cloudflare response format: ' + JSON.stringify(data));
}

/**
 * Build the list of available models from env keys
 */
function getAvailableModels(envKeys) {
    const models = [];

    if (envKeys.openai) {
        models.push({
            name: 'GPT-4o',
            provider: 'openai',
            supportsVision: true,
            call: (prompt, options = {}) => {
                if (options.images && options.images.length > 0) {
                    return callOpenAIMultimodal(prompt, options.images, envKeys.openai);
                }
                return callOpenAI(prompt, envKeys.openai);
            },
        });
    }

    if (envKeys.cf_accountId && envKeys.cf_apiToken) {
        // Mistral Small 3.1 24B — fast, strong general purpose
        models.push({
            name: 'Mistral 24B',
            provider: 'cloudflare',
            supportsVision: false,
            call: (prompt) => callCloudflare(
                prompt, envKeys.cf_accountId, envKeys.cf_apiToken,
                '@cf/mistralai/mistral-small-3.1-24b-instruct'
            ),
        });

        // Google Gemma 3 12B — multi-capability, 128K context
        models.push({
            name: 'Gemma 12B',
            provider: 'cloudflare',
            supportsVision: false,
            call: (prompt) => callCloudflare(
                prompt, envKeys.cf_accountId, envKeys.cf_apiToken,
                '@cf/google/gemma-3-12b-it'
            ),
        });

        // DeepSeek R1 Distill 32B — reasoning, outperforms o1-mini
        models.push({
            name: 'DeepSeek R1 32B',
            provider: 'cloudflare',
            supportsVision: false,
            call: (prompt) => callCloudflare(
                prompt, envKeys.cf_accountId, envKeys.cf_apiToken,
                '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
            ),
        });
    }

    return models;
}

function buildDirectVisionImages(context, priorContexts = []) {
    const images = [];

    if (context?.screenshot) {
        images.push({
            url: context.screenshot,
            detail: 'high',
            label: 'Current visible screen'
        });
    }

    const priorWithScreens = (priorContexts || []).filter(ctx => ctx?.screenshot);
    if (priorWithScreens.length > 0) {
        const latestPrior = priorWithScreens[priorWithScreens.length - 1];
        images.push({
            url: latestPrior.screenshot,
            detail: 'low',
            label: 'Most recent prior screen'
        });
    }

    return images.slice(0, MAX_DIRECT_VISION_IMAGES);
}

function getDirectVisionImagesForRound(baseImages, roundNumber) {
    if (!Array.isArray(baseImages) || baseImages.length === 0) return [];

    // Use high detail where precision matters most, low detail in middle rounds.
    const currentDetail = (roundNumber === 1 || roundNumber === 4) ? 'high' : 'low';
    return baseImages.map((img, idx) => ({
        ...img,
        detail: idx === 0 ? currentDetail : 'low'
    }));
}

async function callModelWithOptionalVision(model, prompt, directVisionImages) {
    if (model?.supportsVision && Array.isArray(directVisionImages) && directVisionImages.length > 0) {
        return model.call(prompt, { images: directVisionImages });
    }
    return model.call(prompt, {});
}

/**
 * If a screenshot is present, summarize it once and share that summary with all models.
 * This lets text-only models use visual context without direct image support.
 */
async function enrichSingleContextWithVision(context, envKeys, onProgress = () => { }, progressText = null) {
    if (!context) return null;
    if (context.screenSummary) return context;
    if (!context.screenshot || !envKeys.openai) return context;

    const cacheKey = getScreenshotCacheKey(context.screenshot);
    if (cacheKey && visionSummaryCache.has(cacheKey)) {
        return {
            ...context,
            screenSummary: visionSummaryCache.get(cacheKey),
            screenSummarySource: 'cache'
        };
    }

    if (progressText) {
        onProgress(1, progressText);
    }

    const visionPrompt = `You are extracting reliable context from a user's screenshot for other AI models.

Return a concise report with these sections:
1) Visible UI and layout
2) Exact text on screen (include numbers, labels, and values)
3) Key entities (names, products, versions, dates, prices, errors)
4) What the user is likely trying to do
5) Ambiguities or unreadable areas

Rules:
- Be precise and literal; do not invent content.
- Quote exact on-screen text where possible.
- If any text is blurry or cut off, explicitly mark it uncertain.`;

    try {
        const summary = await callOpenAIVision(visionPrompt, context.screenshot, envKeys.openai);
        if (cacheKey) cacheVisionSummary(cacheKey, summary?.trim() || '');
        return {
            ...context,
            screenSummary: summary?.trim() || ''
        };
    } catch (err) {
        console.error('[Vision] Failed to analyze screenshot:', err.message);
        return {
            ...context,
            screenSummary: '',
            screenSummaryError: err.message
        };
    }
}

async function enrichContextWithVision(context, priorContexts, envKeys, onProgress = () => { }) {
    const enrichedCurrent = await enrichSingleContextWithVision(
        context || null,
        envKeys,
        onProgress,
        context?.screenshot ? 'Analyzing the visible screen...' : null
    );

    const rawPrior = Array.isArray(priorContexts) ? priorContexts : [];
    const priorTail = rawPrior.slice(-3);
    const enrichedPrior = [];

    for (let i = 0; i < priorTail.length; i += 1) {
        const prior = priorTail[i];
        const progressText = prior?.screenshot
            ? `Reviewing previous screen ${i + 1}/${priorTail.length}...`
            : null;
        const enriched = await enrichSingleContextWithVision(prior, envKeys, onProgress, progressText);
        if (enriched) enrichedPrior.push(enriched);
    }

    return {
        context: enrichedCurrent,
        priorContexts: enrichedPrior
    };
}

/**
 * Run the full 4-round collaboration
 * @param {string} message - User's question
 * @param {object|null} context - Optional page context
 * @param {Array} priorContexts - Previous captured contexts
 * @param {object} envKeys - { openai, cf_accountId, cf_apiToken }
 * @param {Array} history - Previous conversation messages [{role, content}]
 * @param {function} onProgress - Callback for progress updates
 */
async function runCollaboration(message, context, priorContexts, envKeys, history = [], onProgress = () => { }) {
    const availableModels = getAvailableModels(envKeys);

    if (availableModels.length === 0) {
        throw new Error('No API keys configured. Please add keys to server/.env file.');
    }

    const rounds = [];
    const enrichedPayload = await enrichContextWithVision(context, priorContexts, envKeys, onProgress);
    const enrichedContext = enrichedPayload.context;
    const enrichedPriorContexts = enrichedPayload.priorContexts;
    const baseDirectVisionImages = buildDirectVisionImages(enrichedContext, enrichedPriorContexts);
    const hasDirectVision = baseDirectVisionImages.length > 0 && availableModels.some(m => m.supportsVision);

    if (hasDirectVision) {
        onProgress(1, 'Vision-capable models are directly inspecting screenshots...');
    }

    // ===== Special case: Only 1 model available =====
    if (availableModels.length === 1) {
        const model = availableModels[0];
        onProgress(1, `${model.name} is answering...`);

        const prompt = prompts.round1(message, enrichedContext, enrichedPriorContexts, history);
        const r1VisionImages = getDirectVisionImagesForRound(baseDirectVisionImages, 1);
        const text = await callModelWithOptionalVision(model, prompt, r1VisionImages);

        rounds.push({
            round: 1,
            name: 'Direct Answer',
            responses: [{ model: model.name, text }]
        });

        let finalAnswer = text;
        try {
            onProgress(2, `${model.name} is self-validating the answer...`);
            const selfCheckPrompt = prompts.round4(
                message,
                [{ model: model.name, text }],
                [],
                [],
                enrichedContext,
                enrichedPriorContexts,
                history
            );
            const r4VisionImages = getDirectVisionImagesForRound(baseDirectVisionImages, 4);
            finalAnswer = await callModelWithOptionalVision(model, selfCheckPrompt, r4VisionImages);
            rounds.push({
                round: 2,
                name: 'Self-Validation',
                responses: [{ model: `${model.name} (Self-Check)`, text: finalAnswer }]
            });
        } catch (err) {
            console.error('[Single-model] Self-validation failed:', err.message);
        }

        return { finalAnswer, rounds };
    }

    // ===== Round 1: Independent Answers =====
    onProgress(1, 'Models answering independently...');

    const r1Prompt = prompts.round1(message, enrichedContext, enrichedPriorContexts, history);
    const r1VisionImages = getDirectVisionImagesForRound(baseDirectVisionImages, 1);
    const r1Results = await Promise.allSettled(
        availableModels.map(async (model) => {
            try {
                const text = await callModelWithOptionalVision(model, r1Prompt, r1VisionImages);
                return { model: model.name, text, error: null };
            } catch (err) {
                console.error(`[R1] ${model.name} failed:`, err.message);
                return { model: model.name, text: null, error: err.message };
            }
        })
    );

    const r1Responses = r1Results
        .map(r => r.status === 'fulfilled' ? r.value : { model: 'Unknown', text: null, error: r.reason?.message })
        .filter(r => r.text);

    if (r1Responses.length === 0) {
        const errors = r1Results
            .map(r => r.status === 'fulfilled' ? r.value : { model: 'Unknown', error: r.reason?.message })
            .map(r => `${r.model}: ${r.error}`)
            .join('; ');
        throw new Error(`All models failed in Round 1: ${errors}`);
    }

    rounds.push({
        round: 1,
        name: 'Independent Answers',
        responses: r1Responses.map(r => ({ model: r.model, text: r.text }))
    });

    // ===== Round 2: Peer Cross-Validation =====
    onProgress(2, 'Models cross-checking answers...');

    const r2Prompt = prompts.round2(message, r1Responses, enrichedContext, enrichedPriorContexts, history);
    const r2VisionImages = getDirectVisionImagesForRound(baseDirectVisionImages, 2);
    const r2Results = await Promise.allSettled(
        availableModels.map(async (model) => {
            try {
                const text = await callModelWithOptionalVision(model, r2Prompt, r2VisionImages);
                return { model: model.name, text, error: null };
            } catch (err) {
                console.error(`[R2] ${model.name} failed:`, err.message);
                return { model: model.name, text: null, error: err.message };
            }
        })
    );

    const r2Responses = r2Results
        .map(r => r.status === 'fulfilled' ? r.value : { model: 'Unknown', text: null, error: r.reason?.message })
        .filter(r => r.text);

    rounds.push({
        round: 2,
        name: 'Peer Cross-Validation',
        responses: r2Responses.map(r => ({ model: r.model, text: r.text }))
    });

    // ===== Round 3: Consensus Discussion =====
    onProgress(3, 'Models discussing a consensus...');
    const r3Prompt = prompts.round3(message, r1Responses, r2Responses, enrichedContext, enrichedPriorContexts, history);
    const r3VisionImages = getDirectVisionImagesForRound(baseDirectVisionImages, 3);
    const r3Results = await Promise.allSettled(
        availableModels.map(async (model) => {
            try {
                const text = await callModelWithOptionalVision(model, r3Prompt, r3VisionImages);
                return { model: model.name, text, error: null };
            } catch (err) {
                console.error(`[R3] ${model.name} failed:`, err.message);
                return { model: model.name, text: null, error: err.message };
            }
        })
    );

    const r3Responses = r3Results
        .map(r => r.status === 'fulfilled' ? r.value : { model: 'Unknown', text: null, error: r.reason?.message })
        .filter(r => r.text);

    rounds.push({
        round: 3,
        name: 'Consensus Discussion',
        responses: r3Responses.map(r => ({ model: r.model, text: r.text }))
    });

    // ===== Round 4: Final Synthesis =====
    onProgress(4, 'Producing final agreed answer...');

    const consensusInputs = r3Responses.length > 0 ? r3Responses : r2Responses;
    const r4Prompt = prompts.round4(message, r1Responses, r2Responses, consensusInputs, enrichedContext, enrichedPriorContexts, history);
    const r4VisionImages = getDirectVisionImagesForRound(baseDirectVisionImages, 4);
    const synthesizer = availableModels.find(m => m.provider === 'openai') || availableModels[0];

    let finalAnswer;
    try {
        finalAnswer = await callModelWithOptionalVision(synthesizer, r4Prompt, r4VisionImages);
    } catch (err) {
        console.error(`[R4] Synthesis failed:`, err.message);
        finalAnswer = r3Responses[0]?.text || r2Responses[0]?.text || r1Responses[0]?.text || 'Unable to synthesize a final answer.';
    }

    rounds.push({
        round: 4,
        name: 'Final Synthesis',
        responses: [{ model: `${synthesizer.name} (Synthesizer)`, text: finalAnswer }]
    });

    return { finalAnswer, rounds };
}

module.exports = { runCollaboration };
