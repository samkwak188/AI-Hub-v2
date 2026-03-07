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
    cf_accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    cf_apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
};

// Log which providers are configured
console.log('\n🔑 API Key Status:');
console.log(`   OpenAI:      ${ENV_KEYS.openai ? '✅ configured' : '❌ missing'}`);
console.log(`   Cloudflare:  ${ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken ? '✅ configured' : '❌ missing'}`);
console.log('');

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
    const providers = [];
    if (ENV_KEYS.openai) providers.push('openai');
    if (ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken) providers.push('cloudflare');

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers,
        modelCount: providers.includes('cloudflare') ? 4 : 1
    });
});

// Main chat endpoint with SSE streaming
app.post('/api/chat', async (req, res) => {
    const { message, context, history } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    if (!ENV_KEYS.openai && !(ENV_KEYS.cf_accountId && ENV_KEYS.cf_apiToken)) {
        return res.status(500).json({
            error: 'No API keys configured on the server. Please add keys to server/.env file.'
        });
    }

    // Log page context if received
    if (context) {
        console.log(`📄 Page context received: type=${context.type}, title="${context.title}", ${context.content?.length || 0} chars`);
    }

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const result = await runCollaboration(
            message,
            context || null,
            ENV_KEYS,
            history || [],
            (round, status) => {
                sendEvent({ type: 'progress', round, status });
            }
        );

        sendEvent({
            type: 'result',
            finalAnswer: result.finalAnswer,
            rounds: result.rounds
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
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║        AI Collab Server Running          ║`);
    console.log(`║                                          ║`);
    console.log(`║   URL:  http://localhost:${PORT}            ║`);
    console.log(`║   API:  http://localhost:${PORT}/api/chat   ║`);
    console.log(`║                                          ║`);
    console.log(`║   Ready for multi-AI collaboration! 🧠   ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    console.log('');
});
