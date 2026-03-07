// AI Collab — Multi-Model Orchestrator
// Runs the 3-round debate: Independent → Critique → Synthesize
// Models: OpenAI GPT-4o-mini (direct) + 3 Cloudflare Workers AI models

const OpenAI = require('openai');
const prompts = require('./prompts');

// ===== Provider Call Functions =====

/**
 * Call OpenAI (GPT-4o-mini) — direct, uses your own key
 */
async function callOpenAI(prompt, apiKey, model = 'gpt-4o-mini') {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2048
    });
    return response.choices[0]?.message?.content || '';
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
            temperature: 0.3,
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
            call: (prompt) => callOpenAI(prompt, envKeys.openai),
        });
    }

    if (envKeys.cf_accountId && envKeys.cf_apiToken) {
        // Mistral Small 3.1 24B — fast, strong general purpose
        models.push({
            name: 'Mistral 24B',
            provider: 'cloudflare',
            call: (prompt) => callCloudflare(
                prompt, envKeys.cf_accountId, envKeys.cf_apiToken,
                '@cf/mistralai/mistral-small-3.1-24b-instruct'
            ),
        });

        // Google Gemma 3 12B — multi-capability, 128K context
        models.push({
            name: 'Gemma 12B',
            provider: 'cloudflare',
            call: (prompt) => callCloudflare(
                prompt, envKeys.cf_accountId, envKeys.cf_apiToken,
                '@cf/google/gemma-3-12b-it'
            ),
        });

        // DeepSeek R1 Distill 32B — reasoning, outperforms o1-mini
        models.push({
            name: 'DeepSeek R1 32B',
            provider: 'cloudflare',
            call: (prompt) => callCloudflare(
                prompt, envKeys.cf_accountId, envKeys.cf_apiToken,
                '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
            ),
        });
    }

    return models;
}

/**
 * Run the full 3-round collaboration
 * @param {string} message - User's question
 * @param {object|null} context - Optional page context
 * @param {object} envKeys - { openai, cf_accountId, cf_apiToken }
 * @param {Array} history - Previous conversation messages [{role, content}]
 * @param {function} onProgress - Callback for progress updates
 */
async function runCollaboration(message, context, envKeys, history = [], onProgress = () => { }) {
    const availableModels = getAvailableModels(envKeys);

    if (availableModels.length === 0) {
        throw new Error('No API keys configured. Please add keys to server/.env file.');
    }

    const rounds = [];

    // ===== Special case: Only 1 model available =====
    if (availableModels.length === 1) {
        const model = availableModels[0];
        onProgress(1, `${model.name} is answering...`);

        const prompt = prompts.round1(message, context, history);
        const text = await model.call(prompt);

        rounds.push({
            round: 1,
            name: 'Direct Answer',
            responses: [{ model: model.name, text }]
        });

        return { finalAnswer: text, rounds };
    }

    // ===== Round 1: Independent Answers =====
    onProgress(1, 'Models answering independently...');

    const r1Prompt = prompts.round1(message, context, history);
    const r1Results = await Promise.allSettled(
        availableModels.map(async (model) => {
            try {
                const text = await model.call(r1Prompt);
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

    if (r1Responses.length === 1) {
        return { finalAnswer: r1Responses[0].text, rounds };
    }

    // ===== Round 2: Peer Critique =====
    onProgress(2, 'Models cross-checking answers...');

    const r2Prompt = prompts.round2(message, r1Responses, history);
    const r2Results = await Promise.allSettled(
        availableModels.map(async (model) => {
            try {
                const text = await model.call(r2Prompt);
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
        name: 'Peer Critique',
        responses: r2Responses.map(r => ({ model: r.model, text: r.text }))
    });

    // ===== Round 3: Final Synthesis =====
    onProgress(3, 'Synthesizing final answer...');

    const r3Prompt = prompts.round3(message, r1Responses, r2Responses, history);
    const synthesizer = availableModels.find(m => m.provider === 'openai') || availableModels[0];

    let finalAnswer;
    try {
        finalAnswer = await synthesizer.call(r3Prompt);
    } catch (err) {
        console.error(`[R3] Synthesis failed:`, err.message);
        finalAnswer = r2Responses[0]?.text || r1Responses[0]?.text || 'Unable to synthesize a final answer.';
    }

    rounds.push({
        round: 3,
        name: 'Final Synthesis',
        responses: [{ model: `${synthesizer.name} (Synthesizer)`, text: finalAnswer }]
    });

    return { finalAnswer, rounds };
}

module.exports = { runCollaboration };
