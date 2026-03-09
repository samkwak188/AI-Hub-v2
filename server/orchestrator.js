const OpenAI = require('openai');
const prompts = require('./prompts');

const MAX_DIRECT_VISION_IMAGES = 2;
const MAX_VISION_PACKET_CONTEXTS = 3;
const MAX_VISION_CACHE_ENTRIES = 120;
const MAX_EMBEDDED_PAGE_TEXT = 6000;
const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o';
const DEFAULT_OPENAI_VISION_MODEL = 'gpt-4o';
const DEFAULT_ENABLE_COST_OPTIMIZED_MODE = true;
const PROMPT_CACHE_RETENTION = 'in_memory';
const VISION_PACKET_VERSION = 'VISPKT-3';
const MASTER_VISUAL_ANALYSIS_WORKFLOW = `
TIER 1 — Spatial & Structural Parsing
Before extracting ANY values or solving anything, first:
1. AXIS ANALYSIS:
   - Identify every axis (x, y, or other)
   - State the LABEL of each axis
   - State the DIRECTION
   - Identify where the ORIGIN (0,0) is located
   - Note which regions are POSITIVE vs NEGATIVE
2. ELEMENT INVENTORY:
   - Count every arrow, bar, point, or line in the diagram
   - For each element, state its LABEL, POSITION relative to origin, and approximate magnitude
3. SYMMETRY CHECK:
   - Is the diagram symmetric about the origin?
   - Are there elements on BOTH sides of zero?
   - List all elements on the LEFT of origin separately from elements on the RIGHT of origin

TIER 2 — Mathematical Extraction
4. EQUATION PARSING (if present):
   - Write out every term in the equation separately
   - For each term, extract coefficient, frequency (ω or f), and phase
   - Convert angular frequencies (ω) to Hz using f = ω / 2π
   - Show every arithmetic step explicitly
5. CROSS-REFERENCE diagram vs equation:
   - Map each frequency you calculated to a specific element in the diagram
   - Flag ANY mismatch between equation and diagram
   - Do NOT assume the diagram is wrong — re-examine your calculation first

TIER 3 — Structured Output (Agent-Ready Format)
6. OUTPUT FORMAT:
   DIAGRAM_STRUCTURE:
   - Origin location
   - Negative axis elements
   - Zero/DC elements
   - Positive axis elements
   CALCULATED_VALUES:
   - label, value with sign, derived source
   CONFIDENCE_PER_ELEMENT:
   - label, HIGH/MEDIUM/LOW, reason
   FLAGS:
   - Any ambiguity, occlusion, or inconsistency found
7. NEVER assign a positive value to an element LEFT of the origin.
   NEVER assign a negative value to an element RIGHT of the origin.
   SIGN IS DETERMINED BY DIAGRAM POSITION, NOT CALCULATION ORDER.

This output will be consumed by multiple specialized agents. Treat every ambiguity as a FLAG, not an assumption. A wrong sign or position will corrupt ALL downstream reasoning. Precision > Speed.
`.trim();

const OPENAI_PRICING_PER_1M = {
    'gpt-4o': { input: 2.5, cached_input: 1.25, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, cached_input: 0.075, output: 0.6 },
    'gpt-4.1': { input: 2.0, cached_input: 0.5, output: 8.0 },
    'gpt-4.1-mini': { input: 0.4, cached_input: 0.1, output: 1.6 },
    'gpt-5': { input: 1.25, cached_input: 0.125, output: 10.0 },
    'gpt-5-chat-latest': { input: 1.25, cached_input: 0.125, output: 10.0 },
    'gpt-5-mini': { input: 0.25, cached_input: 0.025, output: 2.0 }
};

const CLOUDFLARE_COST_PER_1K_NEURONS = {
    '@cf/mistralai/mistral-small-3.1-24b-instruct': 0.011,
    '@cf/google/gemma-3-12b-it': 0.011
};

const visionPacketCache = new Map();

function errorToMessage(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    if (typeof err.error === 'string' && err.error.trim()) return err.error;
    if (typeof err.error?.message === 'string' && err.error.message.trim()) return err.error.message;

    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

function hashString(value = '') {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function estimateTokenCount(text = '') {
    return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function normalizePromptSpec(promptInput) {
    if (typeof promptInput === 'string') {
        return {
            system: '',
            user: promptInput,
            cacheKey: null,
            jsonMode: false,
            maxTokens: 2048,
            temperature: 0.15
        };
    }

    return {
        system: promptInput?.system || '',
        user: promptInput?.user || '',
        cacheKey: promptInput?.cacheKey || null,
        jsonMode: !!promptInput?.jsonMode,
        maxTokens: promptInput?.maxTokens || 2048,
        temperature: typeof promptInput?.temperature === 'number' ? promptInput.temperature : 0.15
    };
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('Empty JSON payload');

    try {
        return JSON.parse(raw);
    } catch {
        const first = raw.indexOf('{');
        const last = raw.lastIndexOf('}');
        if (first >= 0 && last > first) {
            return JSON.parse(raw.slice(first, last + 1));
        }
        throw new Error('Response was not valid JSON');
    }
}

function extractTextFromMessageContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            if (typeof part?.text === 'string') return part.text;
            return '';
        })
        .join('');
}

function clampBBoxValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1000, Math.round(numeric)));
}

function normalizeBBox(value) {
    if (!Array.isArray(value) || value.length < 4) return [];
    return value.slice(0, 4).map(clampBBoxValue);
}

function normalizeStringList(value, maxItems = 12, maxLength = 200) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, maxItems)
        .map((item) => item.slice(0, maxLength));
}

function normalizeConfidenceLabel(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return ['HIGH', 'MEDIUM', 'LOW'].includes(normalized) ? normalized : 'LOW';
}

function normalizeSignLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['negative', 'zero', 'positive', 'unknown'].includes(normalized) ? normalized : 'unknown';
}

function normalizeSideLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['left', 'right', 'above', 'below', 'at_origin', 'center', 'unknown'].includes(normalized)
        ? normalized
        : 'unknown';
}

function normalizeAxis(axis = {}, fallbackId) {
    return {
        id: String(axis.id || fallbackId || '').trim() || 'axis',
        label: String(axis.label || '').trim(),
        orientation: String(axis.orientation || 'unknown').trim(),
        direction: String(axis.direction || 'unknown').trim(),
        origin_location: String(axis.origin_location || '').trim(),
        positive_region: String(axis.positive_region || '').trim(),
        negative_region: String(axis.negative_region || '').trim(),
        unit: String(axis.unit || '').trim(),
        scale: String(axis.scale || 'unknown').trim(),
        ticks: Array.isArray(axis.ticks)
            ? axis.ticks.slice(0, 14).map((tick) => {
                if (!Array.isArray(tick)) return [String(tick || '').trim(), null];
                const raw = String(tick[0] || '').trim();
                const numeric = Number(tick[1]);
                return [raw, Number.isFinite(numeric) ? numeric : null];
            })
            : []
    };
}

function normalizeElementInventory(items = []) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 24).map((item, index) => ({
        id: String(item?.id || `el_${index + 1}`).trim(),
        kind: String(item?.kind || 'unknown').trim(),
        label: String(item?.label || '').trim(),
        position: {
            side_of_origin: normalizeSideLabel(item?.position?.side_of_origin),
            quadrant: String(item?.position?.quadrant || 'unknown').trim(),
            axis: String(item?.position?.axis || 'unknown').trim()
        },
        approximate_magnitude: String(item?.approximate_magnitude || '').trim(),
        sign: normalizeSignLabel(item?.sign),
        linked_question: String(item?.linked_question || '').trim(),
        bbox: normalizeBBox(item?.bbox || item?.b),
        confidence: normalizeConfidenceLabel(item?.confidence)
    }));
}

function normalizeEquationTerm(term = {}) {
    return {
        raw: String(term.raw || '').trim(),
        coefficient: String(term.coefficient || '').trim(),
        frequency_raw: String(term.frequency_raw || '').trim(),
        frequency_hz: String(term.frequency_hz || '').trim(),
        phase: String(term.phase || '').trim(),
        sign: normalizeSignLabel(term.sign),
        mapped_element_labels: normalizeStringList(term.mapped_element_labels, 8, 120),
        arithmetic_steps: normalizeStringList(term.arithmetic_steps, 8, 180)
    };
}

function normalizeEquations(items = []) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 8).map((eq, index) => ({
        id: String(eq?.id || `eq_${index + 1}`).trim(),
        raw: String(eq?.raw || '').trim(),
        terms: Array.isArray(eq?.terms) ? eq.terms.slice(0, 10).map(normalizeEquationTerm) : [],
        mismatch_flags: normalizeStringList(eq?.mismatch_flags, 8, 180)
    }));
}

function normalizeSpatial(packet = {}) {
    return {
        axes: Array.isArray(packet.axes)
            ? packet.axes.slice(0, 4).map((axis, index) => normalizeAxis(axis, `axis_${index + 1}`))
            : [],
        origin_location: String(packet.origin_location || '').trim(),
        symmetry: {
            about_origin: Boolean(packet.symmetry?.about_origin),
            about_vertical_axis: Boolean(packet.symmetry?.about_vertical_axis),
            about_horizontal_axis: Boolean(packet.symmetry?.about_horizontal_axis),
            has_left_and_right_of_zero: Boolean(packet.symmetry?.has_left_and_right_of_zero),
            notes: normalizeStringList(packet.symmetry?.notes, 8, 160)
        },
        negative_axis_elements: normalizeStringList(packet.negative_axis_elements, 16, 180),
        zero_axis_elements: normalizeStringList(packet.zero_axis_elements, 16, 180),
        positive_axis_elements: normalizeStringList(packet.positive_axis_elements, 16, 180)
    };
}

function normalizeTables(items = []) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 4).map((table, index) => ({
        id: String(table?.id || `tb_${index + 1}`).trim(),
        title: String(table?.title || '').trim(),
        headers: normalizeStringList(table?.headers, 20, 120),
        rows: Array.isArray(table?.rows)
            ? table.rows.slice(0, 20).map((row) => Array.isArray(row)
                ? row.slice(0, 12).map((cell) => String(cell || '').trim().slice(0, 120))
                : [])
            : [],
        key_cells: Array.isArray(table?.key_cells)
            ? table.key_cells.slice(0, 20).map((cell) => ({
                row: Number.isFinite(Number(cell?.row)) ? Number(cell.row) : null,
                col: Number.isFinite(Number(cell?.col)) ? Number(cell.col) : null,
                text: String(cell?.text || '').trim().slice(0, 160),
                role: String(cell?.role || 'unknown').trim()
            }))
            : []
    }));
}

function normalizeCharts(items = []) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 6).map((chart, index) => ({
        id: String(chart?.id || `c_${index + 1}`).trim(),
        type: String(chart?.type || 'unknown').trim(),
        title: String(chart?.title || '').trim(),
        x: normalizeAxis(chart?.x || {}, 'x'),
        y: normalizeAxis(chart?.y || {}, 'y'),
        series: Array.isArray(chart?.series)
            ? chart.series.slice(0, 8).map((series) => ({
                name: String(series?.name || '').trim(),
                points: Array.isArray(series?.points)
                    ? series.points.slice(0, 24).map((point) => Array.isArray(point) ? [point[0], point[1]] : point)
                    : [],
                fit: String(series?.fit || 'none').trim(),
                equation: String(series?.equation || '').trim()
            }))
            : [],
        key_values: Array.isArray(chart?.key_values)
            ? chart.key_values.slice(0, 16).map((entry) => Array.isArray(entry)
                ? [String(entry[0] || '').trim(), String(entry[1] || '').trim()]
                : [String(entry || '').trim(), ''])
            : [],
        targets: normalizeStringList(chart?.targets, 8, 160)
    }));
}

function normalizeChartTableAnalysis(packet = {}) {
    return {
        diagram_structure: {
            origin_location: String(packet.diagram_structure?.origin_location || '').trim(),
            negative_axis_elements: normalizeStringList(packet.diagram_structure?.negative_axis_elements, 16, 180),
            zero_dc_elements: normalizeStringList(packet.diagram_structure?.zero_dc_elements, 16, 180),
            positive_axis_elements: normalizeStringList(packet.diagram_structure?.positive_axis_elements, 16, 180)
        },
        calculated_values: Array.isArray(packet.calculated_values)
            ? packet.calculated_values.slice(0, 16).map((item) => ({
                label: String(item?.label || '').trim(),
                value: String(item?.value || '').trim(),
                sign: normalizeSignLabel(item?.sign),
                derived_from: String(item?.derived_from || '').trim()
            }))
            : [],
        confidence_per_element: Array.isArray(packet.confidence_per_element)
            ? packet.confidence_per_element.slice(0, 20).map((item) => ({
                label: String(item?.label || '').trim(),
                level: normalizeConfidenceLabel(item?.level),
                reason: String(item?.reason || '').trim().slice(0, 220)
            }))
            : [],
        flags: normalizeStringList(packet.flags, 20, 220)
    };
}

function normalizeVisionPacket(packet, sourceLabel) {
    const safe = (packet && typeof packet === 'object') ? packet : {};

    return {
        v: VISION_PACKET_VERSION,
        source: sourceLabel,
        doc_type: safe.doc_type || 'unknown',
        problem: {
            question_lines: Array.isArray(safe.problem?.question_lines) ? safe.problem.question_lines : [],
            task_type: Array.isArray(safe.problem?.task_type) ? safe.problem.task_type : []
        },
        spatial: normalizeSpatial(safe.spatial || {}),
        element_inventory: normalizeElementInventory(safe.element_inventory),
        equations: normalizeEquations(safe.equations),
        ocr: Array.isArray(safe.ocr) ? safe.ocr : [],
        math: Array.isArray(safe.math) ? safe.math : [],
        charts: normalizeCharts(safe.charts),
        tables: normalizeTables(safe.tables),
        chart_table_analysis: normalizeChartTableAnalysis(safe.chart_table_analysis || {}),
        facts: Array.isArray(safe.facts) ? safe.facts : [],
        uncertainty: Array.isArray(safe.uncertainty) ? safe.uncertainty : []
    };
}

function buildVisionSummary(packet) {
    const compact = {
        v: packet.v,
        source: packet.source,
        doc_type: packet.doc_type,
        problem: packet.problem,
        spatial: packet.spatial,
        element_inventory: Array.isArray(packet.element_inventory) ? packet.element_inventory.slice(0, 16) : [],
        equations: Array.isArray(packet.equations) ? packet.equations.slice(0, 6) : [],
        charts: Array.isArray(packet.charts) ? packet.charts.slice(0, 4) : [],
        tables: Array.isArray(packet.tables) ? packet.tables.slice(0, 3) : [],
        chart_table_analysis: packet.chart_table_analysis,
        facts: Array.isArray(packet.facts) ? packet.facts.slice(0, 16) : [],
        uncertainty: Array.isArray(packet.uncertainty) ? packet.uncertainty.slice(0, 10) : [],
        ocr_excerpt: Array.isArray(packet.ocr) ? packet.ocr.slice(0, 18) : [],
        math_excerpt: Array.isArray(packet.math) ? packet.math.slice(0, 18) : []
    };

    return `VISUAL_PACKET_JSON=${JSON.stringify(compact)}`;
}

function cacheVisionPacket(cacheKey, packet) {
    visionPacketCache.set(cacheKey, packet);
    if (visionPacketCache.size > MAX_VISION_CACHE_ENTRIES) {
        const oldestKey = visionPacketCache.keys().next().value;
        visionPacketCache.delete(oldestKey);
    }
}

function getCachedVisionPacket(cacheKey) {
    if (!visionPacketCache.has(cacheKey)) return null;
    const value = visionPacketCache.get(cacheKey);
    visionPacketCache.delete(cacheKey);
    visionPacketCache.set(cacheKey, value);
    return value;
}

function buildImageNotes(images = []) {
    return images.map((img, index) => {
        const defaultLabel = index === 0 ? 'Current screen' : `Previous screen ${index}`;
        return `${index + 1}. ${img.label || defaultLabel} (${img.detail || 'auto'} detail)`;
    }).join('\n');
}

function getOpenAIPricing(model) {
    const direct = OPENAI_PRICING_PER_1M[model];
    if (direct) return direct;

    const normalized = Object.keys(OPENAI_PRICING_PER_1M).find((key) => model.startsWith(key));
    return normalized ? OPENAI_PRICING_PER_1M[normalized] : OPENAI_PRICING_PER_1M['gpt-4o'];
}

function estimateOpenAICost(model, usage) {
    if (!usage) return 0;
    const pricing = getOpenAIPricing(model);
    const promptTokens = Number(usage.prompt_tokens || 0);
    const cachedTokens = Number(usage.prompt_tokens_details?.cached_tokens || 0);
    const uncachedTokens = Math.max(0, promptTokens - cachedTokens);
    const completionTokens = Number(usage.completion_tokens || 0);

    return (
        (uncachedTokens * pricing.input) +
        (cachedTokens * pricing.cached_input) +
        (completionTokens * pricing.output)
    ) / 1000000;
}

function estimateCloudflareCost(model, promptTokens, completionTokens) {
    const rate = CLOUDFLARE_COST_PER_1K_NEURONS[model] || 0.011;
    const estimatedNeurons = Math.max(1, Number(promptTokens || 0) + Number(completionTokens || 0));
    return (estimatedNeurons / 1000) * rate;
}

function createTelemetry(costOptimizedMode) {
    return {
        costOptimizedMode,
        routeDecision: null,
        rounds_run: 0,
        early_exit: { triggered: false, stage: null },
        vision_packet_targets: 0,
        used_vision_packet: false,
        selected_models: [],
        calls: [],
        totals: {
            tokens_in: 0,
            tokens_out: 0,
            cached_prompt_tokens: 0,
            estimated_cost_usd: 0
        }
    };
}

function recordTelemetryCall(telemetry, callRecord) {
    if (!telemetry) return;
    telemetry.calls.push(callRecord);
    telemetry.totals.tokens_in += Number(callRecord.tokens_in || 0);
    telemetry.totals.tokens_out += Number(callRecord.tokens_out || 0);
    telemetry.totals.cached_prompt_tokens += Number(callRecord.cached_prompt_tokens || 0);
    telemetry.totals.estimated_cost_usd += Number(callRecord.estimated_cost_usd || 0);
}

function finalizeTelemetry(telemetry) {
    const promptTokens = Number(telemetry?.totals?.tokens_in || 0);
    const cachedTokens = Number(telemetry?.totals?.cached_prompt_tokens || 0);
    const cacheHitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;

    return {
        ...telemetry,
        cache_hit_rate: Number(cacheHitRate.toFixed(4)),
        totals: {
            ...telemetry.totals,
            estimated_cost_usd: Number(telemetry.totals.estimated_cost_usd.toFixed(6))
        }
    };
}

async function callOpenAI(promptInput, apiKey, model = DEFAULT_OPENAI_CHAT_MODEL, options = {}) {
    const prompt = normalizePromptSpec(promptInput);
    const client = new OpenAI({ apiKey });
    const safeImages = Array.isArray(options.images)
        ? options.images.filter((img) => img?.url).slice(0, MAX_DIRECT_VISION_IMAGES)
        : [];

    const imageNotes = buildImageNotes(safeImages);
    const userText = safeImages.length > 0
        ? `${prompt.user}\n\nAttached screenshot inputs (ordered):\n${imageNotes}\nUse screenshot evidence jointly with page text and any VISUAL_PACKET_JSON.`
        : prompt.user;

    const userContent = safeImages.length > 0
        ? [
            { type: 'text', text: userText },
            ...safeImages.map((img) => ({
                type: 'image_url',
                image_url: {
                    url: img.url,
                    detail: img.detail || 'auto'
                }
            }))
        ]
        : userText;

    const request = {
        model,
        messages: [
            ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
            { role: 'user', content: userContent }
        ],
        temperature: prompt.temperature,
        max_tokens: prompt.maxTokens,
        prompt_cache_retention: PROMPT_CACHE_RETENTION
    };

    if (prompt.cacheKey) {
        request.prompt_cache_key = prompt.cacheKey;
    }
    if (prompt.jsonMode) {
        request.response_format = { type: 'json_object' };
    }

    const response = await client.chat.completions.create(request);
    const firstChoice = response.choices[0];
    const text = extractTextFromMessageContent(firstChoice?.message?.content).trim();

    return {
        text,
        usage: response.usage || null,
        estimatedPromptTokens: Number(response.usage?.prompt_tokens || estimateTokenCount(`${prompt.system}\n${prompt.user}`)),
        estimatedCompletionTokens: Number(response.usage?.completion_tokens || estimateTokenCount(text)),
        cachedPromptTokens: Number(response.usage?.prompt_tokens_details?.cached_tokens || 0),
        estimatedCostUsd: estimateOpenAICost(model, response.usage)
    };
}

async function callCloudflare(promptInput, accountId, apiToken, model, options = {}) {
    const prompt = normalizePromptSpec(promptInput);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const safeImages = Array.isArray(options.images)
        ? options.images.filter((img) => img?.url).slice(0, MAX_DIRECT_VISION_IMAGES)
        : [];

    const content = safeImages.length > 0
        ? [
            {
                type: 'text',
                text: `${prompt.system ? `${prompt.system}\n\n` : ''}${prompt.user}\n\nAttached screenshot inputs (ordered):\n${buildImageNotes(safeImages)}`
            },
            ...safeImages.map((img) => ({
                type: 'image_url',
                image_url: { url: img.url }
            }))
        ]
        : `${prompt.system ? `${prompt.system}\n\n` : ''}${prompt.user}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messages: [{ role: 'user', content }],
            temperature: prompt.temperature,
            max_tokens: prompt.maxTokens
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Cloudflare Workers AI error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    const text = data.result?.response || data.result?.choices?.[0]?.message?.content || '';
    if (!String(text || '').trim()) {
        throw new Error(`Unexpected Cloudflare response format: ${JSON.stringify(data)}`);
    }

    const usage = data.result?.usage || null;
    const estimatedPromptTokens = Number(usage?.prompt_tokens || estimateTokenCount(`${prompt.system}\n${prompt.user}`));
    const estimatedCompletionTokens = Number(usage?.completion_tokens || estimateTokenCount(text));

    return {
        text: String(text).trim(),
        usage,
        estimatedPromptTokens,
        estimatedCompletionTokens,
        cachedPromptTokens: 0,
        estimatedCostUsd: estimateCloudflareCost(model, estimatedPromptTokens, estimatedCompletionTokens)
    };
}

async function compileVisionPacket(image, sourceLabel, userMessage, context, envKeys) {
    if (!image?.url) throw new Error('Missing screenshot input for vision compiler');
    if (!envKeys.openai) throw new Error('OPENAI_API_KEY missing for vision packet compiler');

    const visionModel = envKeys.openai_vision_model || DEFAULT_OPENAI_VISION_MODEL;
    const cacheKey = `${visionModel}:${sourceLabel}:${hashString(image.url)}`;
    const cached = getCachedVisionPacket(cacheKey);
    if (cached) return cached;

    const client = new OpenAI({ apiKey: envKeys.openai });
    const pageText = String(context?.content || '').slice(0, MAX_EMBEDDED_PAGE_TEXT);

    const instruction = `You are a vision-to-structure compiler.
Return exactly one JSON object. No markdown, no commentary.
Use the following workflow exactly:
${MASTER_VISUAL_ANALYSIS_WORKFLOW}

Schema:
{
  "v": "${VISION_PACKET_VERSION}",
  "doc_type": "worksheet|chart|ui|table|mixed|other",
  "problem": {"question_lines": ["..."], "task_type": ["graph-reading|algebra|geometry|statistics|word-problem|other"]},
  "spatial": {
    "axes": [{
      "id": "x",
      "label": "",
      "orientation": "horizontal|vertical|radial|other|unknown",
      "direction": "left_to_right|right_to_left|bottom_to_top|top_to_bottom|clockwise|counterclockwise|unknown",
      "origin_location": "",
      "positive_region": "",
      "negative_region": "",
      "unit": "",
      "scale": "linear|log|category|unknown",
      "ticks": [["raw", null]]
    }],
    "origin_location": "",
    "symmetry": {
      "about_origin": false,
      "about_vertical_axis": false,
      "about_horizontal_axis": false,
      "has_left_and_right_of_zero": false,
      "notes": ["..."]
    },
    "negative_axis_elements": ["label | signed value | why"],
    "zero_axis_elements": ["label | value | why"],
    "positive_axis_elements": ["label | signed value | why"]
  },
  "element_inventory": [{
    "id": "el1",
    "kind": "arrow|bar|point|line|curve|label|table-cell|region|other",
    "label": "",
    "position": {"side_of_origin": "left|right|above|below|at_origin|center|unknown", "quadrant": "I|II|III|IV|axis|unknown", "axis": "x|y|both|none|unknown"},
    "approximate_magnitude": "",
    "sign": "negative|zero|positive|unknown",
    "linked_question": "",
    "bbox": [0,0,0,0],
    "confidence": "HIGH|MEDIUM|LOW"
  }],
  "equations": [{
    "id": "eq1",
    "raw": "",
    "terms": [{
      "raw": "",
      "coefficient": "",
      "frequency_raw": "",
      "frequency_hz": "",
      "phase": "",
      "sign": "negative|zero|positive|unknown",
      "mapped_element_labels": [""],
      "arithmetic_steps": [""]
    }],
    "mismatch_flags": [""]
  }],
  "ocr": [{"id":"t1","txt":"exact text","b":[x1,y1,x2,y2]}],
  "math": [{"id":"m1","expr":"normalized","kind":"equation|inequality|function|value","b":[x1,y1,x2,y2]}],
  "charts": [{
    "id":"c1",
    "type":"line|bar|scatter|histogram|pie|unknown",
    "title":"",
    "x":{"label":"","unit":"","scale":"linear|log|category|unknown","ticks":[["raw", null]]},
    "y":{"label":"","unit":"","scale":"linear|log|category|unknown","ticks":[["raw", null]]},
    "series":[{"name":"","points":[[0,0]],"fit":"linear|quadratic|exponential|none","equation":""}],
    "key_values":[["metric","value"]],
    "targets":["linked question"]
  }],
  "tables": [{
    "id":"tb1",
    "title":"",
    "headers":[""],
    "rows":[[""]],
    "key_cells":[{"row":0,"col":0,"text":"","role":"header|value|label|other"}]
  }],
  "chart_table_analysis": {
    "diagram_structure": {
      "origin_location": "",
      "negative_axis_elements": ["label | signed value"],
      "zero_dc_elements": ["label | value"],
      "positive_axis_elements": ["label | signed value"]
    },
    "calculated_values": [{"label":"","value":"","sign":"negative|zero|positive|unknown","derived_from":""}],
    "confidence_per_element": [{"label":"","level":"HIGH|MEDIUM|LOW","reason":""}],
    "flags": ["ambiguity, occlusion, inconsistency, missing legend, unreadable tick, sign mismatch"]
  },
  "facts": [["key","value"]],
  "uncertainty": ["..."]
}

Rules:
- Prioritize exact numeric extraction for charts and graphs.
- Prioritize spatial grounding before arithmetic.
- Use bbox coordinates in integer 0..1000 space.
- Prefix estimated numeric values with "~".
- Preserve row and column relationships for tables.
- For graphs and diagrams, left-of-origin implies negative x-side; right-of-origin implies positive x-side unless the image explicitly indicates otherwise.
- If there is ambiguity, put it in chart_table_analysis.flags and uncertainty.
- Keep packet dense and solver-friendly.`;

    const response = await client.chat.completions.create({
        model: visionModel,
        temperature: 0,
        max_tokens: 3600,
        response_format: { type: 'json_object' },
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: `${instruction}\n\nUser question:\n${userMessage || ''}\n\nPage title: ${context?.title || 'Unknown'}\nURL: ${context?.url || 'Unknown'}\n\nExtracted page text:\n${pageText || '(none)'}`
                },
                {
                    type: 'image_url',
                    image_url: {
                        url: image.url,
                        detail: image.detail || 'high'
                    }
                }
            ]
        }]
    });

    const firstChoice = response.choices[0];
    const raw = extractTextFromMessageContent(firstChoice?.message?.content).trim();
    if (!raw) {
        throw new Error(`Vision compiler returned empty content (finish_reason=${firstChoice?.finish_reason || 'unknown'})`);
    }

    const packet = normalizeVisionPacket(extractJsonObject(raw), sourceLabel);
    cacheVisionPacket(cacheKey, packet);
    return packet;
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

    const priorWithScreens = (priorContexts || []).filter((ctx) => ctx?.screenshot);
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

function getDirectVisionImagesForStage(baseImages, stageName, routeDecision) {
    if (!Array.isArray(baseImages) || baseImages.length === 0) return [];

    if (stageName === 'round1' || stageName === 'final') {
        return baseImages.map((img, index) => ({
            ...img,
            detail: index === 0 ? 'high' : 'low'
        }));
    }

    if (stageName === 'round3' && routeDecision?.visual_complexity === 'high') {
        return [{ ...baseImages[0], detail: 'high' }].filter((img) => img?.url);
    }

    return [];
}

async function enrichContextsWithVisionPacket(userMessage, context, priorContexts, envKeys, onProgress = () => { }, options = {}) {
    const enabled = String(envKeys.enable_openai_vision_packet ?? 'true').toLowerCase() !== 'false';
    const force = Boolean(options.force);
    const maxTargets = Math.max(0, Number(options.maxTargets || 0));

    const enrichedContext = context ? { ...context } : null;
    const enrichedPriorContexts = (priorContexts || []).map((ctx) => ({ ...ctx }));

    if ((!enabled && !force) || !envKeys.openai || maxTargets === 0) {
        return {
            context: enrichedContext,
            priorContexts: enrichedPriorContexts,
            usedVisionPacket: false,
            targetCount: 0
        };
    }

    const targets = [];
    if (enrichedContext?.screenshot) {
        targets.push({
            target: enrichedContext,
            sourceLabel: 'current',
            image: { url: enrichedContext.screenshot, detail: 'high' }
        });
    }

    const priorWithScreens = enrichedPriorContexts
        .map((ctx, idx) => ({ ctx, idx }))
        .filter((item) => item.ctx?.screenshot)
        .slice(-Math.max(0, maxTargets - targets.length));

    for (const item of priorWithScreens) {
        targets.push({
            target: item.ctx,
            sourceLabel: `prior_${item.idx + 1}`,
            image: { url: item.ctx.screenshot, detail: 'low' }
        });
    }

    for (let i = 0; i < targets.length; i += 1) {
        const job = targets[i];
        onProgress(1, `Compiling visual packet ${i + 1}/${targets.length}...`);
        try {
            const packet = await compileVisionPacket(job.image, job.sourceLabel, userMessage, job.target, envKeys);
            job.target.screenPacket = packet;
            job.target.screenSummary = buildVisionSummary(packet);
        } catch (err) {
            const msg = errorToMessage(err);
            console.error(`[VisionPacket] ${job.sourceLabel} failed:`, msg);
            job.target.screenSummary = `VISUAL_PACKET_ERROR=${msg}`;
        }
    }

    return {
        context: enrichedContext,
        priorContexts: enrichedPriorContexts,
        usedVisionPacket: targets.length > 0,
        targetCount: targets.length
    };
}

function getAvailableModels(envKeys) {
    const models = [];

    if (envKeys.openai) {
        const modelId = envKeys.openai_chat_model || DEFAULT_OPENAI_CHAT_MODEL;
        models.push({
            name: `GPT-4o (${modelId})`,
            provider: 'openai',
            modelId,
            supportsDirectVision: true,
            qualityRank: 100,
            costRank: 30,
            routerRank: 30,
            shortLabel: 'GPT-4o',
            call: (prompt, options = {}) => callOpenAI(prompt, envKeys.openai, modelId, options)
        });
    }

    if (envKeys.cf_accountId && envKeys.cf_apiToken) {
        models.push({
            name: 'Mistral 24B',
            provider: 'cloudflare',
            modelId: '@cf/mistralai/mistral-small-3.1-24b-instruct',
            supportsDirectVision: false,
            qualityRank: 88,
            costRank: 18,
            routerRank: 18,
            shortLabel: 'Mistral',
            call: (prompt, options = {}) => callCloudflare(prompt, envKeys.cf_accountId, envKeys.cf_apiToken, '@cf/mistralai/mistral-small-3.1-24b-instruct', options)
        });

        models.push({
            name: 'Gemma 12B',
            provider: 'cloudflare',
            modelId: '@cf/google/gemma-3-12b-it',
            supportsDirectVision: false,
            qualityRank: 79,
            costRank: 12,
            routerRank: 12,
            shortLabel: 'Gemma',
            call: (prompt, options = {}) => callCloudflare(prompt, envKeys.cf_accountId, envKeys.cf_apiToken, '@cf/google/gemma-3-12b-it', options)
        });
    }

    return models;
}

function normalizeStringArray(value, maxItems) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, maxItems);
}

function clampConfidence(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 50;
    return Math.max(0, Math.min(100, Math.round(numeric)));
}

function parseReasoningCard(text, modelName, stage) {
    let parsed = {};

    try {
        parsed = extractJsonObject(text);
    } catch {
        parsed = {};
    }

    const fallbackAnswer = String(text || '').trim().split('\n').find(Boolean) || 'No answer produced.';

    return {
        model: modelName,
        stage,
        answer: String(parsed.answer || parsed.final_answer || fallbackAnswer).trim().slice(0, 1000),
        key_steps: normalizeStringArray(parsed.key_steps, 4),
        evidence_refs: normalizeStringArray(parsed.evidence_refs, 6),
        uncertainty: normalizeStringArray(parsed.uncertainty, 3),
        confidence: clampConfidence(parsed.confidence),
        needs_escalation: Boolean(parsed.needs_escalation),
        follow_up_classification: parsed.follow_up_classification === 'new_question' ? 'new_question' : 'related',
        raw: String(text || '').trim()
    };
}

function cardToDisplayText(card) {
    const parts = [
        `Answer: ${card.answer}`,
        `Confidence: ${card.confidence}`,
        `Follow-up classification: ${card.follow_up_classification}`
    ];

    if (card.key_steps.length > 0) {
        parts.push('Key steps:');
        card.key_steps.forEach((step) => parts.push(`- ${step}`));
    }
    if (card.evidence_refs.length > 0) {
        parts.push('Evidence refs:');
        card.evidence_refs.forEach((ref) => parts.push(`- ${ref}`));
    }
    if (card.uncertainty.length > 0) {
        parts.push('Uncertainty:');
        card.uncertainty.forEach((item) => parts.push(`- ${item}`));
    }

    return parts.join('\n');
}

function normalizeAnswer(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/π/g, 'pi')
        .replace(/[^a-z0-9.=+\-/*()]/g, '')
        .trim();
}

function evaluateConsensus(cards = []) {
    const valid = cards.filter((card) => String(card?.answer || '').trim());
    if (valid.length === 0) {
        return {
            total: 0,
            topAnswer: '',
            topCount: 0,
            supportRatio: 0,
            avgConfidence: 0,
            dissentHighestConfidence: 0,
            groupCards: []
        };
    }

    const groups = new Map();
    for (const card of valid) {
        const key = normalizeAnswer(card.answer);
        const list = groups.get(key) || [];
        list.push(card);
        groups.set(key, list);
    }

    const rankedGroups = Array.from(groups.entries())
        .map(([key, items]) => ({
            key,
            items,
            count: items.length,
            avgConfidence: items.reduce((sum, item) => sum + item.confidence, 0) / items.length
        }))
        .sort((a, b) => (b.count - a.count) || (b.avgConfidence - a.avgConfidence));

    const top = rankedGroups[0];
    const dissentHighestConfidence = rankedGroups.slice(1)
        .flatMap((group) => group.items)
        .reduce((max, item) => Math.max(max, item.confidence), 0);

    return {
        total: valid.length,
        topAnswer: top.items[0].answer,
        topCount: top.count,
        supportRatio: top.count / valid.length,
        avgConfidence: Math.round(top.avgConfidence),
        dissentHighestConfidence,
        groupCards: top.items
    };
}

function shouldEarlyExit(stage, cards, routeDecision, costOptimizedMode) {
    if (!costOptimizedMode) return false;
    const consensus = evaluateConsensus(cards);
    if (consensus.total < 2) return false;

    const hasBlockingUncertainty = consensus.groupCards.some((card) => card.needs_escalation || card.uncertainty.length > 1);
    const visualHigh = routeDecision?.visual_complexity === 'high';
    const expectedDebateValue = routeDecision?.expected_value_of_debate;

    if (stage === 'round1') {
        return (
            consensus.topCount === consensus.total &&
            consensus.avgConfidence >= 84 &&
            !visualHigh &&
            expectedDebateValue !== 'high' &&
            !hasBlockingUncertainty
        );
    }

    if (stage === 'round2') {
        const majoritySatisfied = consensus.total === 2
            ? consensus.topCount === 2
            : consensus.topCount >= 2;

        return (
            majoritySatisfied &&
            consensus.avgConfidence >= 78 &&
            consensus.dissentHighestConfidence < 76 &&
            !hasBlockingUncertainty
        );
    }

    return false;
}

function inferVisualComplexity(message, context, priorContexts) {
    const joined = [message, context?.content, ...(priorContexts || []).map((ctx) => ctx?.content)].join(' ').toLowerCase();
    if (!joined.trim()) return 'none';
    if (/(graph|chart|table|diagram|figure|plot|image|screenshot|geometry|triangle|circle|canvas|pdf)/.test(joined)) return 'high';
    if (/(question|worksheet|problem|equation|function|matrix|table)/.test(joined)) return 'medium';
    return 'low';
}

function estimateQuestionLoad(message, context, priorContexts) {
    const text = [message, context?.content, ...(priorContexts || []).map((ctx) => ctx?.content)].join('\n');
    const matches = text.match(/(^|\n)\s*(question\s*\d+|\d+[.)]|[a-d][.)])/gim);
    return matches ? matches.length : 0;
}

function buildHeuristicRoute(message, context, priorContexts, availableModels) {
    const exhaustiveGoal = /\b(all questions|every question|entire page|whole page|all tasks|solve all|complete all|answer all)\b/i.test(message || '');
    const visualComplexity = inferVisualComplexity(message, context, priorContexts);
    const questionLoad = estimateQuestionLoad(message, context, priorContexts);
    const longContext = Number((context?.content || '').length) > 4500 || (priorContexts || []).length >= 4;

    let difficulty = 'easy';
    if (visualComplexity === 'high' || exhaustiveGoal || questionLoad >= 4 || longContext) {
        difficulty = 'hard';
    } else if (visualComplexity === 'medium' || questionLoad >= 2) {
        difficulty = 'medium';
    }

    let recommendedPath = 'single';
    if (availableModels.length <= 1) {
        recommendedPath = 'single';
    } else if (difficulty === 'hard') {
        recommendedPath = 'full';
    } else if (difficulty === 'medium') {
        recommendedPath = 'dual';
    }

    return {
        difficulty,
        visual_complexity: visualComplexity,
        need_multi_model: recommendedPath !== 'single',
        expected_value_of_debate: difficulty === 'hard' ? 'high' : (difficulty === 'medium' ? 'medium' : 'low'),
        recommended_path: recommendedPath,
        reason: exhaustiveGoal
            ? 'User requested exhaustive page coverage.'
            : (longContext ? 'Large or multi-part context detected.' : 'Heuristic route.'),
        primary_focus: exhaustiveGoal ? ['full-page coverage', 'multi-question extraction'] : ['answer correctness']
    };
}

function normalizeRouterValue(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function mergeRouteDecision(candidate, fallback, availableModels, costOptimizedMode) {
    const merged = {
        difficulty: normalizeRouterValue(candidate?.difficulty, ['easy', 'medium', 'hard'], fallback.difficulty),
        visual_complexity: normalizeRouterValue(candidate?.visual_complexity, ['none', 'low', 'medium', 'high'], fallback.visual_complexity),
        need_multi_model: typeof candidate?.need_multi_model === 'boolean' ? candidate.need_multi_model : fallback.need_multi_model,
        expected_value_of_debate: normalizeRouterValue(candidate?.expected_value_of_debate, ['low', 'medium', 'high'], fallback.expected_value_of_debate),
        recommended_path: normalizeRouterValue(candidate?.recommended_path, ['single', 'dual', 'full'], fallback.recommended_path),
        reason: String(candidate?.reason || fallback.reason || 'Heuristic route.').slice(0, 300),
        primary_focus: normalizeStringArray(candidate?.primary_focus, 4)
    };

    if (!costOptimizedMode) {
        merged.recommended_path = availableModels.length > 1 ? 'full' : 'single';
        merged.reason = 'Cost Optimized Mode disabled; forcing full debate path.';
    }

    if (availableModels.length <= 1) {
        merged.recommended_path = 'single';
        merged.need_multi_model = false;
    }

    if (merged.recommended_path === 'single' && (merged.visual_complexity === 'high' || merged.difficulty === 'hard')) {
        merged.recommended_path = availableModels.length >= 3 ? 'full' : 'dual';
        merged.need_multi_model = availableModels.length > 1;
    }

    if (merged.recommended_path === 'dual' && merged.difficulty === 'hard' && availableModels.length >= 3) {
        merged.recommended_path = 'full';
        merged.need_multi_model = true;
    }

    if (merged.recommended_path === 'dual' && availableModels.length < 2) {
        merged.recommended_path = 'single';
        merged.need_multi_model = false;
    }

    if (merged.recommended_path === 'full' && availableModels.length < 3) {
        merged.recommended_path = availableModels.length >= 2 ? 'dual' : 'single';
        merged.need_multi_model = availableModels.length > 1;
    }

    return merged;
}

function chooseRouterModel(availableModels) {
    return [...availableModels].sort((a, b) => (a.routerRank - b.routerRank) || (b.qualityRank - a.qualityRank))[0];
}

function choosePrimaryModel(availableModels) {
    return [...availableModels].sort((a, b) => b.qualityRank - a.qualityRank)[0];
}

function chooseComplementModel(availableModels, primaryModel) {
    return [...availableModels]
        .filter((model) => model.name !== primaryModel.name)
        .sort((a, b) => b.qualityRank - a.qualityRank)[0] || null;
}

function chooseSynthesizer(availableModels) {
    return availableModels.find((model) => model.provider === 'openai') || choosePrimaryModel(availableModels);
}

function selectModelsForPath(path, availableModels) {
    const primary = choosePrimaryModel(availableModels);
    if (!primary) return [];

    if (path === 'single') return [primary];
    if (path === 'dual') {
        const complement = chooseComplementModel(availableModels, primary);
        return complement ? [primary, complement] : [primary];
    }

    return [...availableModels].sort((a, b) => b.qualityRank - a.qualityRank);
}

async function invokeModel(stageName, model, promptSpec, options, telemetry) {
    const result = await model.call(promptSpec, {
        ...options,
        images: model.supportsDirectVision ? (options?.images || []) : []
    });
    const callRecord = {
        stage: stageName,
        model: model.name,
        provider: model.provider,
        model_id: model.modelId,
        tokens_in: result.estimatedPromptTokens,
        tokens_out: result.estimatedCompletionTokens,
        cached_prompt_tokens: result.cachedPromptTokens,
        estimated_cost_usd: result.estimatedCostUsd,
        actual_usage_available: Boolean(result.usage)
    };

    recordTelemetryCall(telemetry, callRecord);

    return {
        model: model.name,
        text: result.text,
        usage: result.usage || null
    };
}

async function runCardStage(stageName, models, promptBuilder, promptArgs, visionImages, telemetry, logPrefix) {
    const promptSpec = promptBuilder(...promptArgs);

    const settled = await Promise.allSettled(models.map(async (model) => {
        try {
            const result = await invokeModel(stageName, model, promptSpec, { images: visionImages }, telemetry);
            return {
                model: model.name,
                text: result.text,
                error: null,
                card: parseReasoningCard(result.text, model.name, stageName)
            };
        } catch (err) {
            const msg = errorToMessage(err);
            console.error(`${logPrefix} ${model.name} failed:`, msg);
            return {
                model: model.name,
                text: null,
                error: msg,
                card: null
            };
        }
    }));

    return settled.map((item) => item.status === 'fulfilled'
        ? item.value
        : { model: 'Unknown', text: null, error: errorToMessage(item.reason), card: null });
}

async function determineRoute(message, context, priorContexts, history, availableModels, envKeys, telemetry, onProgress, costOptimizedMode) {
    const heuristic = buildHeuristicRoute(message, context, priorContexts, availableModels);
    const routerModel = chooseRouterModel(availableModels);

    if (!costOptimizedMode || !routerModel || availableModels.length <= 1) {
        const forced = mergeRouteDecision({}, heuristic, availableModels, costOptimizedMode);
        telemetry.routeDecision = { ...forced, source: 'heuristic' };
        return forced;
    }

    onProgress(1, `Routing task with ${routerModel.shortLabel}...`);

    try {
        const roster = availableModels.map((model) => `${model.name} [quality=${model.qualityRank}, cost_rank=${model.costRank}]`);
        const promptSpec = prompts.router(message, context, priorContexts, history, roster);
        const result = await invokeModel('router', routerModel, promptSpec, { images: [] }, telemetry);
        const parsed = extractJsonObject(result.text);
        const merged = mergeRouteDecision(parsed, heuristic, availableModels, costOptimizedMode);
        telemetry.routeDecision = { ...merged, source: 'router' };
        return merged;
    } catch (err) {
        console.error('[Router] failed:', errorToMessage(err));
        const fallback = mergeRouteDecision({}, heuristic, availableModels, costOptimizedMode);
        telemetry.routeDecision = { ...fallback, source: 'heuristic-fallback' };
        return fallback;
    }
}

function getVisionPacketTargetLimit(routeDecision, costOptimizedMode, context, priorContexts) {
    const totalAvailable = [context, ...(priorContexts || [])].filter((ctx) => ctx?.screenshot).length;
    if (totalAvailable === 0) return 0;
    if (!costOptimizedMode) return Math.min(MAX_VISION_PACKET_CONTEXTS, totalAvailable);
    if (routeDecision?.recommended_path === 'single' && routeDecision?.visual_complexity !== 'high') return 1;
    if (routeDecision?.recommended_path === 'dual') return Math.min(2, totalAvailable);
    return Math.min(MAX_VISION_PACKET_CONTEXTS, totalAvailable);
}

function buildRoundResponses(cards) {
    return cards.map((card) => ({ model: card.model, text: cardToDisplayText(card) }));
}

async function synthesizeFinal(message, round1Cards, round2Cards, round3Cards, context, priorContexts, history, routeDecision, synthesizer, baseDirectVisionImages, telemetry, onProgress) {
    onProgress(4, `Synthesizing final answer with ${synthesizer.shortLabel}...`);
    const promptSpec = prompts.round4(message, round1Cards, round2Cards, round3Cards, context, priorContexts, history, routeDecision);
    const result = await invokeModel('final', synthesizer, promptSpec, {
        images: getDirectVisionImagesForStage(baseDirectVisionImages, 'final', routeDecision)
    }, telemetry);
    return result.text;
}

async function runCollaboration(message, context, priorContexts, envKeys, history = [], onProgress = () => { }) {
    const availableModels = getAvailableModels(envKeys);
    if (availableModels.length === 0) {
        throw new Error('No AI providers configured. Add OPENAI_API_KEY and/or Cloudflare keys to server/.env.');
    }

    const costOptimizedMode = String(envKeys.enable_cost_optimized_mode ?? String(DEFAULT_ENABLE_COST_OPTIMIZED_MODE)).toLowerCase() !== 'false';
    const telemetry = createTelemetry(costOptimizedMode);
    const safePriorContexts = Array.isArray(priorContexts) ? priorContexts : [];
    const rounds = [];

    const routeDecision = await determineRoute(
        message,
        context,
        safePriorContexts,
        history,
        availableModels,
        envKeys,
        telemetry,
        onProgress,
        costOptimizedMode
    );

    const selectedModels = selectModelsForPath(routeDecision.recommended_path, availableModels);
    telemetry.selected_models = selectedModels.map((model) => model.name);

    const hasAnyScreenshot = [context, ...safePriorContexts].some((ctx) => ctx?.screenshot);
    const mustBridgeVision = hasAnyScreenshot && selectedModels.some((model) => !model.supportsDirectVision);
    const baseVisionTargetLimit = getVisionPacketTargetLimit(routeDecision, costOptimizedMode, context, safePriorContexts);
    const visionTargetLimit = mustBridgeVision ? Math.max(1, baseVisionTargetLimit) : baseVisionTargetLimit;
    const enriched = await enrichContextsWithVisionPacket(
        message,
        context,
        safePriorContexts,
        envKeys,
        onProgress,
        { maxTargets: visionTargetLimit, force: mustBridgeVision }
    );

    telemetry.used_vision_packet = enriched.usedVisionPacket;
    telemetry.vision_packet_targets = enriched.targetCount;

    const enrichedContext = enriched.context;
    const enrichedPriorContexts = enriched.priorContexts;
    const baseDirectVisionImages = buildDirectVisionImages(enrichedContext, enrichedPriorContexts);
    const synthesizer = chooseSynthesizer(selectedModels);

    if (selectedModels.length === 1) {
        const primary = selectedModels[0];
        onProgress(1, `${primary.shortLabel} generating structured answer...`);
        const r1StageResults = await runCardStage(
            'round1',
            [primary],
            prompts.round1,
            [message, enrichedContext, enrichedPriorContexts, history, routeDecision, selectedModels.map((model) => model.name)],
            getDirectVisionImagesForStage(baseDirectVisionImages, 'round1', routeDecision),
            telemetry,
            '[R1]'
        );

        const round1Cards = r1StageResults.map((item) => item.card).filter(Boolean);
        if (round1Cards.length === 0) {
            throw new Error(`Primary model failed in Round 1: ${r1StageResults.map((item) => `${item.model}: ${item.error}`).join('; ')}`);
        }

        rounds.push({
            round: 1,
            name: 'Structured Independent Answer',
            responses: buildRoundResponses(round1Cards)
        });

        onProgress(2, `${primary.shortLabel} self-checking final answer...`);
        const finalSpec = prompts.singleFinal(message, round1Cards[0], enrichedContext, enrichedPriorContexts, history, routeDecision);
        const finalResult = await invokeModel('final-single', primary, finalSpec, {
            images: getDirectVisionImagesForStage(baseDirectVisionImages, 'final', routeDecision)
        }, telemetry);

        rounds.push({
            round: 2,
            name: 'Final Answer',
            responses: [{ model: `${primary.name} (Self-Check)`, text: finalResult.text }]
        });

        telemetry.rounds_run = rounds.length;
        return {
            finalAnswer: finalResult.text,
            rounds,
            meta: finalizeTelemetry(telemetry)
        };
    }

    onProgress(1, `Running ${routeDecision.recommended_path} path across ${selectedModels.length} model(s)...`);
    const r1StageResults = await runCardStage(
        'round1',
        selectedModels,
        prompts.round1,
        [message, enrichedContext, enrichedPriorContexts, history, routeDecision, selectedModels.map((model) => model.name)],
        getDirectVisionImagesForStage(baseDirectVisionImages, 'round1', routeDecision),
        telemetry,
        '[R1]'
    );

    const round1Cards = r1StageResults.map((item) => item.card).filter(Boolean);
    if (round1Cards.length === 0) {
        throw new Error(`All models failed in Round 1: ${r1StageResults.map((item) => `${item.model}: ${item.error}`).join('; ')}`);
    }

    rounds.push({
        round: 1,
        name: 'Structured Independent Answer',
        responses: buildRoundResponses(round1Cards)
    });

    if (shouldEarlyExit('round1', round1Cards, routeDecision, costOptimizedMode)) {
        telemetry.early_exit = { triggered: true, stage: 'after_round1' };
        const finalAnswer = await synthesizeFinal(
            message,
            round1Cards,
            [],
            [],
            enrichedContext,
            enrichedPriorContexts,
            history,
            routeDecision,
            synthesizer,
            baseDirectVisionImages,
            telemetry,
            onProgress
        );
        rounds.push({
            round: 2,
            name: 'Early Exit Synthesis',
            responses: [{ model: `${synthesizer.name} (Synthesizer)`, text: finalAnswer }]
        });
        telemetry.rounds_run = rounds.length;
        return { finalAnswer, rounds, meta: finalizeTelemetry(telemetry) };
    }

    onProgress(2, 'Cross-reviewing compact reasoning cards...');
    const r2StageResults = await runCardStage(
        'round2',
        selectedModels,
        prompts.round2,
        [message, round1Cards, enrichedContext, enrichedPriorContexts, history, routeDecision],
        getDirectVisionImagesForStage(baseDirectVisionImages, 'round2', routeDecision),
        telemetry,
        '[R2]'
    );
    const round2Cards = r2StageResults.map((item) => item.card).filter(Boolean);

    if (round2Cards.length > 0) {
        rounds.push({
            round: 2,
            name: 'Peer Cross-Review',
            responses: buildRoundResponses(round2Cards)
        });
    }

    const cardsForEarlyExit = round2Cards.length > 0 ? round2Cards : round1Cards;
    if (shouldEarlyExit('round2', cardsForEarlyExit, routeDecision, costOptimizedMode)) {
        telemetry.early_exit = { triggered: true, stage: 'after_round2' };
        const finalAnswer = await synthesizeFinal(
            message,
            round1Cards,
            round2Cards,
            [],
            enrichedContext,
            enrichedPriorContexts,
            history,
            routeDecision,
            synthesizer,
            baseDirectVisionImages,
            telemetry,
            onProgress
        );
        rounds.push({
            round: 3,
            name: 'Early Exit Synthesis',
            responses: [{ model: `${synthesizer.name} (Synthesizer)`, text: finalAnswer }]
        });
        telemetry.rounds_run = rounds.length;
        return { finalAnswer, rounds, meta: finalizeTelemetry(telemetry) };
    }

    let round3Cards = [];
    if (routeDecision.recommended_path === 'full' && selectedModels.length > 2) {
        onProgress(3, 'Resolving remaining disagreements...');
        const r3StageResults = await runCardStage(
            'round3',
            selectedModels,
            prompts.round3,
            [message, round1Cards, round2Cards, enrichedContext, enrichedPriorContexts, history, routeDecision],
            getDirectVisionImagesForStage(baseDirectVisionImages, 'round3', routeDecision),
            telemetry,
            '[R3]'
        );
        round3Cards = r3StageResults.map((item) => item.card).filter(Boolean);

        if (round3Cards.length > 0) {
            rounds.push({
                round: 3,
                name: 'Consensus Compression',
                responses: buildRoundResponses(round3Cards)
            });
        }
    }

    const finalAnswer = await synthesizeFinal(
        message,
        round1Cards,
        round2Cards,
        round3Cards.length > 0 ? round3Cards : cardsForEarlyExit,
        enrichedContext,
        enrichedPriorContexts,
        history,
        routeDecision,
        synthesizer,
        baseDirectVisionImages,
        telemetry,
        onProgress
    );

    rounds.push({
        round: rounds.length + 1,
        name: 'Final Synthesis',
        responses: [{ model: `${synthesizer.name} (Synthesizer)`, text: finalAnswer }]
    });

    telemetry.rounds_run = rounds.length;
    return {
        finalAnswer,
        rounds,
        meta: finalizeTelemetry(telemetry)
    };
}

module.exports = { runCollaboration };
