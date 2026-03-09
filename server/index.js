// AI Collab — Express Backend Server
// Reads API keys from .env, handles multi-AI orchestration with SSE streaming

const express = require('express');
const cors = require('cors');
const path = require('path');
const { runCollaboration } = require('./orchestrator');

// ===== Load .env file =====
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Server-side API keys (hardcoded in .env)
const ENV_KEYS = {
    openai: process.env.OPENAI_API_KEY || '',
    openai_chat_model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o',
    openai_vision_model: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
    enable_openai_vision_packet: process.env.ENABLE_OPENAI_VISION_PACKET || 'true',
    enable_cost_optimized_mode: process.env.ENABLE_COST_OPTIMIZED_MODE || 'true',
    debug_ai_telemetry: process.env.DEBUG_AI_TELEMETRY || 'false',
    cf_accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    cf_apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
};

function parseBooleanFlag(value, fallback = true) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
}

// Log which providers are configured
console.log('\n🔑 API Key Status:');
console.log(`   OpenAI:      ${ENV_KEYS.openai ? `✅ configured (chat=${ENV_KEYS.openai_chat_model}, vision=${ENV_KEYS.openai_vision_model})` : '❌ missing'}`);
console.log(`   Cloudflare:  ${ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken ? '✅ configured' : '❌ missing'}`);
console.log(`   Vision pkt:  ${String(ENV_KEYS.enable_openai_vision_packet).toLowerCase() !== 'false' ? '✅ enabled' : '❌ disabled'}`);
console.log(`   Cost mode:   ${String(ENV_KEYS.enable_cost_optimized_mode).toLowerCase() !== 'false' ? '✅ enabled' : '❌ disabled'}`);
console.log('');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
    const providers = [];
    if (ENV_KEYS.openai) providers.push('openai');
    if (ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken) providers.push('cloudflare');

    let modelCount = 0;
    if (ENV_KEYS.openai) modelCount += 1;
    if (ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken) modelCount += 2;

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers,
        modelCount,
        features: ['chat', 'agent-scroll', 'cost-optimized-routing', 'vision-packet']
    });
});

// Main chat endpoint with SSE streaming
app.post('/api/chat', async (req, res) => {
    const { message, context, priorContexts, history, options } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    if (!ENV_KEYS.openai && !(ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken)) {
        return res.status(500).json({
            error: 'No providers configured. Add OPENAI_API_KEY and/or Cloudflare keys in server/.env.'
        });
    }

    // Log page context if received
    if (context) {
        const hasScreenshot = !!context.screenshot;
        const priorCount = Array.isArray(priorContexts) ? priorContexts.length : 0;
        console.log(`📄 Page context received: type=${context.type}, title="${context.title}", ${context.content?.length || 0} chars, screenshot=${hasScreenshot ? 'yes' : 'no'}, priorScreens=${priorCount}`);
    }

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const requestEnvKeys = { ...ENV_KEYS };
        if (options && Object.prototype.hasOwnProperty.call(options, 'enableOpenAIVisionPacket')) {
            requestEnvKeys.enable_openai_vision_packet = parseBooleanFlag(
                options.enableOpenAIVisionPacket,
                true
            ) ? 'true' : 'false';
        }
        if (options && Object.prototype.hasOwnProperty.call(options, 'enableCostOptimizedMode')) {
            requestEnvKeys.enable_cost_optimized_mode = parseBooleanFlag(
                options.enableCostOptimizedMode,
                true
            ) ? 'true' : 'false';
        }

        const result = await runCollaboration(
            message,
            context || null,
            Array.isArray(priorContexts) ? priorContexts : [],
            requestEnvKeys,
            history || [],
            (round, status) => {
                sendEvent({ type: 'progress', round, status });
            }
        );

        if (parseBooleanFlag(requestEnvKeys.debug_ai_telemetry, false) && result.meta) {
            console.log('[Telemetry]', JSON.stringify({
                route_decision: result.meta.routeDecision,
                rounds_run: result.meta.rounds_run,
                early_exit: result.meta.early_exit,
                selected_models: result.meta.selected_models,
                tokens_in: result.meta.totals?.tokens_in,
                tokens_out: result.meta.totals?.tokens_out,
                cache_hit_rate: result.meta.cache_hit_rate,
                estimated_cost_usd: result.meta.totals?.estimated_cost_usd
            }));
        }

        sendEvent({
            type: 'result',
            finalAnswer: result.finalAnswer,
            rounds: result.rounds,
            meta: result.meta || null
        });
    } catch (err) {
        console.error('Orchestration error:', err.message);
        sendEvent({ type: 'error', error: err.message });
    }

    res.end();
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        AI Collab Server Running          ║');
    console.log('║                                          ║');
    console.log(`║   URL:  http://localhost:${PORT}            ║`);
    console.log(`║   API:  http://localhost:${PORT}/api/chat   ║`);
    console.log('║                                          ║');
    console.log('║   Ready for multi-AI collaboration! 🧠   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
