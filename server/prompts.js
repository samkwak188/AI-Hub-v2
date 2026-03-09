const MAX_HISTORY_CHARS = 12000;
const MAX_CONTEXT_CHARS = 7000;
const MAX_PRIOR_CONTEXTS = 6;
const MAX_PRIOR_CONTEXT_CHARS = 2200;
const MAX_CARD_STEPS = 4;
const MAX_CARD_EVIDENCE = 6;
const MAX_CARD_UNCERTAINTY = 3;

const CORE_SYSTEM = [
    'You are a model inside AI Collab, a multi-model verification pipeline.',
    'Use only evidence from the prompt, chat history, page text, screenshots, and visual packets.',
    'Prefer exact answers, exact symbols, and exact numeric values with units when available.',
    'Do not invent missing graph values or hidden page content.',
    'For graph, table, and diagram tasks, ground reasoning in VISUAL_PACKET_JSON.spatial, element_inventory, equations, and chart_table_analysis before doing math.',
    'Treat chart_table_analysis.flags and uncertainty as mandatory validation targets, not optional notes.',
    'Keep outputs compact, concrete, and solver-friendly.',
    'If evidence is insufficient, say so plainly and mark uncertainty.',
    'When answering math, use standard symbols such as π rather than spelling them out.'
].join('\n');

const CARD_SCHEMA_TEXT = `Return exactly one JSON object with this schema:
{
  "answer": "short direct answer",
  "key_steps": ["<= ${MAX_CARD_STEPS} compact bullets"],
  "evidence_refs": ["<= ${MAX_CARD_EVIDENCE} refs such as current:text, current:packet:chart:c1, prior:2:text, history:4"],
  "uncertainty": ["<= ${MAX_CARD_UNCERTAINTY} compact risks or missing evidence"],
  "confidence": 0,
  "needs_escalation": false,
  "follow_up_classification": "related|new_question"
}`;

function trimBlock(text, limit) {
    return String(text || '').trim().slice(0, limit);
}

function formatHistory(history = []) {
    if (!Array.isArray(history) || history.length === 0) return 'none';

    const lines = history.map((item, index) => {
        const role = item?.role === 'assistant' ? 'assistant' : 'user';
        const content = trimBlock(item?.content || '', 1200).replace(/\s+/g, ' ');
        return `${index + 1}. ${role}: ${content}`;
    }).join('\n');

    return trimBlock(lines, MAX_HISTORY_CHARS) || 'none';
}

function formatFocus(focus) {
    if (!focus || typeof focus !== 'object') return 'none';
    const top = Number.isFinite(Number(focus.top)) ? Number(focus.top) : 0;
    const height = Number.isFinite(Number(focus.height)) ? Number(focus.height) : 0;
    const score = Number.isFinite(Number(focus.score)) ? Number(focus.score).toFixed(2) : 'n/a';
    const source = focus.source || 'unknown';
    return `source=${source}; top=${top}; height=${height}; score=${score}`;
}

function formatContext(context) {
    if (!context) return 'none';

    const parts = [
        `title: ${context.title || 'Unknown'}`,
        `url: ${context.url || 'Unknown'}`,
        `type: ${context.type || 'page'}`,
        `captured_at: ${context.capturedAt || 'unknown'}`,
        `focus: ${formatFocus(context.focus)}`,
        'page_text:',
        trimBlock(context.content || 'none', MAX_CONTEXT_CHARS) || 'none'
    ];

    if (context.screenSummary) {
        parts.push('visual_packet:');
        parts.push(trimBlock(context.screenSummary, MAX_CONTEXT_CHARS));
    }

    return parts.join('\n');
}

function formatPriorContexts(priorContexts = []) {
    if (!Array.isArray(priorContexts) || priorContexts.length === 0) return 'none';

    return priorContexts
        .slice(-MAX_PRIOR_CONTEXTS)
        .map((ctx, index) => {
            const body = [
                `prior_index: ${index + 1}`,
                `title: ${ctx?.title || 'Unknown'}`,
                `url: ${ctx?.url || 'Unknown'}`,
                `captured_at: ${ctx?.capturedAt || 'unknown'}`,
                `focus: ${formatFocus(ctx?.focus)}`,
                'page_text:',
                trimBlock(ctx?.content || 'none', MAX_PRIOR_CONTEXT_CHARS) || 'none'
            ];

            if (ctx?.screenSummary) {
                body.push('visual_packet:');
                body.push(trimBlock(ctx.screenSummary, MAX_PRIOR_CONTEXT_CHARS));
            }

            return body.join('\n');
        })
        .join('\n\n---\n\n');
}

function formatCards(cards = []) {
    if (!Array.isArray(cards) || cards.length === 0) return 'none';

    return JSON.stringify(cards.map((card) => ({
        model: card.model,
        stage: card.stage,
        answer: card.answer,
        key_steps: Array.isArray(card.key_steps) ? card.key_steps.slice(0, MAX_CARD_STEPS) : [],
        evidence_refs: Array.isArray(card.evidence_refs) ? card.evidence_refs.slice(0, MAX_CARD_EVIDENCE) : [],
        uncertainty: Array.isArray(card.uncertainty) ? card.uncertainty.slice(0, MAX_CARD_UNCERTAINTY) : [],
        confidence: card.confidence,
        needs_escalation: !!card.needs_escalation,
        follow_up_classification: card.follow_up_classification || 'related'
    })), null, 2);
}

function buildUserSections(sections) {
    return sections.map(([title, value]) => `### ${title}\n${value}`).join('\n\n');
}

function router(message, context, priorContexts, history, modelRoster = []) {
    const roster = modelRoster.length > 0 ? modelRoster.join(', ') : 'unknown';

    return {
        system: `${CORE_SYSTEM}\n\nYou are the routing classifier. Minimize cost while preserving answer quality.`,
        cacheKey: 'ai-collab-router-v1',
        jsonMode: true,
        maxTokens: 500,
        temperature: 0,
        user: buildUserSections([
            ['Task', 'Classify the request and recommend the cheapest safe orchestration path.'],
            ['Available Models', roster],
            ['Return Format', `Return exactly one JSON object with keys: difficulty, visual_complexity, need_multi_model, expected_value_of_debate, recommended_path, reason, primary_focus.\nAllowed values: difficulty=easy|medium|hard; visual_complexity=none|low|medium|high; expected_value_of_debate=low|medium|high; recommended_path=single|dual|full.`],
            ['User Message', trimBlock(message, 4000)],
            ['Current Page Context', formatContext(context)],
            ['Prior Page Contexts', formatPriorContexts(priorContexts)],
            ['Session History', formatHistory(history)]
        ])
    };
}

function round1(message, context, priorContexts, history, routeDecision, selectedModels = []) {
    const modelLine = selectedModels.length > 0 ? selectedModels.join(', ') : 'unknown';
    const routeSummary = JSON.stringify(routeDecision || {}, null, 2);

    return {
        system: `${CORE_SYSTEM}\n\nYou are solving the task independently. ${CARD_SCHEMA_TEXT}`,
        cacheKey: 'ai-collab-r1-card-v1',
        jsonMode: true,
        maxTokens: 700,
        temperature: 0.1,
        user: buildUserSections([
            ['Task', 'Produce one compact ReasoningCard. Answer independently before seeing peer cards.'],
            ['Selected Models', modelLine],
            ['Routing Decision', routeSummary],
            ['User Message', trimBlock(message, 4000)],
            ['Current Page Context', formatContext(context)],
            ['Prior Page Contexts', formatPriorContexts(priorContexts)],
            ['Session History', formatHistory(history)]
        ])
    };
}

function round2(message, round1Cards, context, priorContexts, history, routeDecision) {
    return {
        system: `${CORE_SYSTEM}\n\nYou are reviewing peer cards and must update your answer if peer evidence is stronger. ${CARD_SCHEMA_TEXT}`,
        cacheKey: 'ai-collab-r2-review-v1',
        jsonMode: true,
        maxTokens: 700,
        temperature: 0.1,
        user: buildUserSections([
            ['Task', 'Review the Round 1 cards. Keep only evidence-backed steps. If another model is more convincing, adopt that answer.'],
            ['Routing Decision', JSON.stringify(routeDecision || {}, null, 2)],
            ['Round 1 Cards', formatCards(round1Cards)],
            ['User Message', trimBlock(message, 4000)],
            ['Current Page Context', formatContext(context)],
            ['Prior Page Contexts', formatPriorContexts(priorContexts)],
            ['Session History', formatHistory(history)]
        ])
    };
}

function round3(message, round1Cards, round2Cards, context, priorContexts, history, routeDecision) {
    return {
        system: `${CORE_SYSTEM}\n\nYou are in the consensus round. Resolve disagreements using only evidence. ${CARD_SCHEMA_TEXT}`,
        cacheKey: 'ai-collab-r3-consensus-v1',
        jsonMode: true,
        maxTokens: 650,
        temperature: 0.1,
        user: buildUserSections([
            ['Task', 'Produce the strongest final card for consensus. Focus on conflicts that remain after review.'],
            ['Routing Decision', JSON.stringify(routeDecision || {}, null, 2)],
            ['Round 1 Cards', formatCards(round1Cards)],
            ['Round 2 Cards', formatCards(round2Cards)],
            ['User Message', trimBlock(message, 4000)],
            ['Current Page Context', formatContext(context)],
            ['Prior Page Contexts', formatPriorContexts(priorContexts)],
            ['Session History', formatHistory(history)]
        ])
    };
}

function singleFinal(message, primaryCard, context, priorContexts, history, routeDecision) {
    return {
        system: `${CORE_SYSTEM}\n\nYou are the final answer writer. Use the provided card and evidence to answer the user directly.`,
        cacheKey: 'ai-collab-single-final-v1',
        jsonMode: false,
        maxTokens: 700,
        temperature: 0.1,
        user: buildUserSections([
            ['Task', 'Write the final answer for the user. Start with the direct answer. Keep explanation short and concrete. Mention uncertainty only if it affects correctness.'],
            ['Routing Decision', JSON.stringify(routeDecision || {}, null, 2)],
            ['Primary Card', formatCards([primaryCard])],
            ['User Message', trimBlock(message, 4000)],
            ['Current Page Context', formatContext(context)],
            ['Prior Page Contexts', formatPriorContexts(priorContexts)],
            ['Session History', formatHistory(history)]
        ])
    };
}

function round4(message, round1Cards, round2Cards, round3Cards, context, priorContexts, history, routeDecision) {
    return {
        system: `${CORE_SYSTEM}\n\nYou are the final synthesizer. Produce one user-facing answer from the structured cards only.`,
        cacheKey: 'ai-collab-r4-synthesis-v1',
        jsonMode: false,
        maxTokens: 900,
        temperature: 0.1,
        user: buildUserSections([
            ['Task', 'Write the final answer for the user. Start with the answer itself, then include the shortest evidence-backed explanation needed for confidence. If the cards disagree materially, say what remains uncertain instead of fabricating certainty.'],
            ['Routing Decision', JSON.stringify(routeDecision || {}, null, 2)],
            ['Round 1 Cards', formatCards(round1Cards)],
            ['Round 2 Cards', formatCards(round2Cards)],
            ['Consensus Cards', formatCards(round3Cards)],
            ['User Message', trimBlock(message, 4000)],
            ['Current Page Context', formatContext(context)],
            ['Prior Page Contexts', formatPriorContexts(priorContexts)],
            ['Session History', formatHistory(history)]
        ])
    };
}

module.exports = {
    router,
    round1,
    round2,
    round3,
    round4,
    singleFinal
};
