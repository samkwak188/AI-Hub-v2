// AI Collab — Prompt Templates
// Inspired by AI Hub's 3-round discussion system

const SYSTEM_IDENTITY = `You are a highly rigorous AI assistant in a multi-model verification workflow.

Core rules:
- Prioritize correctness over fluency.
- Do NOT hallucinate. Never invent facts, citations, values, formulas, or context.
- If information is missing or uncertain, say exactly what is unknown.
- If the question is ambiguous, state the ambiguity and resolve it with explicit assumptions.
- If screenshot attachments are provided, treat them as primary visual evidence and cross-check against extracted text.
- Keep equations human-readable (example: A = sqrt(a^2 + b^2)); avoid raw LaTeX wrappers when possible.
- Show concise but explicit logic for non-trivial conclusions.`;

/**
 * Format conversation history into a readable string
 */
function formatHistory(history) {
    if (!history || history.length === 0) return '';

    const historyText = history
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n\n');

    return `\n\n=== CONVERSATION HISTORY ===
The following is the previous conversation between the user and the AI assistant. Use this context to understand follow-up questions and maintain continuity.

${historyText}

=== END OF HISTORY ===\n`;
}

/**
 * Format screen/page context for prompts.
 */
function formatPageContext(context) {
    if (!context) return '';

    let contextText = `

=== CURRENT SCREEN CONTEXT ===
Title: ${context.title || 'Unknown'}
URL: ${context.url || 'Unknown'}
Context Type: ${context.type || 'unknown'}
Captured At: ${context.capturedAt || 'Unknown'}
`;

    if (context.content) {
        contextText += `

Extracted Page Text:
${context.content}`;
    }

    if (context.screenSummary) {
        contextText += `

Screenshot Analysis:
${context.screenSummary}`;
    } else if (context.screenshot) {
        contextText += `

Screenshot Analysis:
(Screenshot was captured but analysis was unavailable.)`;
    }

    contextText += `

=== END SCREEN CONTEXT ===
`;

    return contextText;
}

function formatPriorScreenContexts(priorContexts) {
    if (!Array.isArray(priorContexts) || priorContexts.length === 0) return '';

    const tail = priorContexts.slice(-5);
    const blocks = tail.map((ctx, index) => {
        let text = `
--- PRIOR SCREEN ${index + 1} ---
Title: ${ctx.title || 'Unknown'}
URL: ${ctx.url || 'Unknown'}
Context Type: ${ctx.type || 'unknown'}
Captured At: ${ctx.capturedAt || 'Unknown'}`;

        if (ctx.content) {
            text += `
Extracted Page Text:
${ctx.content}`;
        }

        if (ctx.screenSummary) {
            text += `
Screenshot Analysis:
${ctx.screenSummary}`;
        } else if (ctx.screenshot) {
            text += `
Screenshot Analysis:
(Screenshot was provided for this prior screen.)`;
        }

        return text;
    }).join('\n\n');

    return `

=== PREVIOUSLY CAPTURED SCREENS ===
The user captured these earlier screens in this conversation. They may or may not be relevant to the current question.
Use them when helpful, ignore them when not relevant.

${blocks}

=== END PREVIOUSLY CAPTURED SCREENS ===
`;
}

function formatResponses(sectionTitle, responses, labelSuffix = '') {
    const body = (responses || [])
        .map((r) => `--- ${r.model || 'Unknown'}${labelSuffix} ---\n${r.text || ''}`)
        .join('\n\n');

    return `
${sectionTitle}
${body || '(no responses)'}
`;
}

const prompts = {
    /**
     * Round 1 — Independent answer with strict self-checking.
     */
    round1(userMessage, context, priorContexts, history) {
        let prompt = `${SYSTEM_IDENTITY}

Role: Independent analyst (Round 1).
Goal: Produce the most accurate answer you can from the available context, with explicit logic and no unsupported claims.

Hard constraints:
1) Do not guess hidden facts.
2) If data is missing, say what is missing and what assumption (if any) you are using.
3) For calculations, show exact intermediate steps and verify arithmetic.
4) Prefer conservative claims over speculative claims.`;

        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        prompt += formatPageContext(context);
        prompt += formatPriorScreenContexts(priorContexts);

        prompt += `

User's current question: ${userMessage}

Return your answer in this structure:
1) Direct Answer
2) Reasoning Steps
3) Validation Checks (logic/arithmetic/consistency)
4) Assumptions and Uncertainty
5) Confidence (0-100)`;

        return prompt;
    },

    /**
     * Round 2 — Deep peer cross-validation.
     */
    round2(userMessage, allR1Responses, context, priorContexts, history) {
        let prompt = `${SYSTEM_IDENTITY}

Role: Critical reviewer (Round 2).
Goal: Rigorously audit all Round 1 answers and catch even subtle errors.

Audit requirements:
1) Check each claim for factual/logical/calculation errors.
2) Identify hallucinated or unsupported statements.
3) Mark what is definitely correct versus uncertain.
4) Resolve contradictions using evidence from context and sound reasoning.
5) Produce a corrected draft answer with only validated claims.`;

        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        prompt += formatPageContext(context);
        prompt += formatPriorScreenContexts(priorContexts);
        prompt += formatResponses('=== ROUND 1 ANSWERS TO AUDIT ===', allR1Responses);

        prompt += `
Original Question: ${userMessage}

Return in this exact structure:
1) Error Audit Per Model
2) Confirmed Correct Points
3) Disagreements and Resolution
4) Corrected Draft Answer
5) Remaining Risks / Unknowns
6) Confidence (0-100)`;

        return prompt;
    },

    /**
     * Round 3 — Consensus discussion.
     */
    round3(userMessage, allR1Responses, allR2Critiques, context, priorContexts, history) {
        let prompt = `${SYSTEM_IDENTITY}

Role: Consensus builder (Round 3).
Goal: Use Round 1 + Round 2 outputs to converge on a single answer that all models can agree is defensible.

Consensus rules:
1) Keep only claims that survived cross-validation.
2) Remove or rewrite any claim with unresolved uncertainty.
3) If there are multiple plausible outcomes, clearly state conditions for each.
4) Ensure final logic is internally consistent and context-aligned.`;

        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        prompt += formatPageContext(context);
        prompt += formatPriorScreenContexts(priorContexts);
        prompt += formatResponses('=== ROUND 1 INDEPENDENT ANSWERS ===', allR1Responses);
        prompt += formatResponses('=== ROUND 2 CROSS-VALIDATION REPORTS ===', allR2Critiques);

        prompt += `
Original Question: ${userMessage}

Return in this exact structure:
1) Consensus Candidate Answer
2) Evidence for Consensus
3) Rejected Claims (and why)
4) Unresolved Issues (if any)
5) Final Sign-off Checklist
6) Confidence (0-100)`;

        return prompt;
    },

    /**
     * Round 4 — Final synthesis from consensus.
     */
    round4(userMessage, allR1Responses, allR2Critiques, allR3Consensus, context, priorContexts, history) {
        let prompt = `${SYSTEM_IDENTITY}

Role: Final synthesizer (Round 4).
Goal: Produce the final user-facing answer that is maximally precise, correct, and aligned with multi-model consensus.

Non-negotiable rules:
1) Include only claims that are validated by prior rounds or explicit context.
2) If certainty is not possible, state the uncertainty clearly instead of guessing.
3) Do a final internal consistency pass before responding.
4) Keep wording direct and clear for a human user.`;

        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        prompt += formatPageContext(context);
        prompt += formatPriorScreenContexts(priorContexts);
        prompt += formatResponses('=== ROUND 1 INDEPENDENT ANSWERS ===', allR1Responses);
        prompt += formatResponses('=== ROUND 2 CROSS-VALIDATION REPORTS ===', allR2Critiques);
        prompt += formatResponses('=== ROUND 3 CONSENSUS DISCUSSIONS ===', allR3Consensus);

        prompt += `
Original Question: ${userMessage}

Produce only the final answer to the user.

Output requirements:
- Do NOT mention rounds or model names.
- Be exact, concise, and complete.
- For math/logic problems, show enough steps to verify correctness.
- If something cannot be guaranteed from given information, state that explicitly.`;

        return prompt;
    }
};

module.exports = prompts;
