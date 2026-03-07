// AI Collab — Prompt Templates
// Inspired by AI Hub's 3-round discussion system

const SYSTEM_IDENTITY = `You are a highly knowledgeable AI assistant participating in a collaborative problem-solving session. Your goal is to provide accurate, thorough, and well-reasoned answers.`;

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

const prompts = {
    /**
     * Round 1 — Independent Answer
     * Each model answers the question independently.
     */
    round1(userMessage, context, history) {
        let prompt = `${SYSTEM_IDENTITY}

Answer the following question accurately and thoroughly. Be precise and cite specific facts when possible. If you're uncertain about something, clearly state your level of confidence.`;

        // Include conversation history for context
        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        if (context) {
            prompt += `

The user is viewing the following webpage:
Title: ${context.title || 'Unknown'}
URL: ${context.url || 'Unknown'}

Page Content:
${context.content || '(no content extracted)'}

Use this page context to inform your answer when relevant.`;
        }

        prompt += `

User's current question: ${userMessage}

${history && history.length > 0 ? 'Consider the conversation history above when answering. The user may be referring to something discussed earlier.' : ''}
Provide a clear, well-structured answer.`;

        return prompt;
    },

    /**
     * Round 2 — Peer Critique
     * Each model receives all Round 1 answers and critiques them.
     */
    round2(userMessage, allR1Responses, history) {
        const responsesText = allR1Responses
            .map((r, i) => `--- Response from ${r.model} ---\n${r.text}`)
            .join('\n\n');

        let prompt = `${SYSTEM_IDENTITY}

You are reviewing multiple AI responses to the same question. Your job is to:
1. Identify any factual errors or inaccuracies in the responses
2. Note any important information that was missed
3. Highlight areas of agreement (these are likely correct)
4. Highlight areas of disagreement (these need closer scrutiny)
5. Provide your own improved answer that addresses the shortcomings`;

        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        prompt += `

Original Question: ${userMessage}

Here are the responses from other AI models:

${responsesText}

Provide your critique and an improved answer. Be specific about what was wrong and what was right.`;

        return prompt;
    },

    /**
     * Round 3 — Final Synthesis
     * One model (usually GPT-4o) synthesizes all critiques into a final answer.
     */
    round3(userMessage, allR1Responses, allR2Critiques, history) {
        const r1Text = allR1Responses
            .map((r) => `[${r.model}]: ${r.text}`)
            .join('\n\n');

        const r2Text = allR2Critiques
            .map((r) => `[${r.model} critique]: ${r.text}`)
            .join('\n\n');

        let prompt = `${SYSTEM_IDENTITY}

You are the final synthesizer in a collaborative AI problem-solving session. Multiple AI models have independently answered a question and then critiqued each other's responses.

Your task is to produce the FINAL, DEFINITIVE answer by:
1. Incorporating the strongest points from all responses
2. Resolving any disagreements by favoring the most well-supported position
3. Correcting any errors identified in the critique round
4. Ensuring the answer is complete, accurate, and clearly written`;

        if (history && history.length > 0) {
            prompt += formatHistory(history);
        }

        prompt += `

Original Question: ${userMessage}

=== ROUND 1: Independent Answers ===
${r1Text}

=== ROUND 2: Peer Critiques ===
${r2Text}

Now produce the final, synthesized answer. This should be the best possible answer, combining the strengths of all models while fixing any identified issues. Write it as a clear, direct response to the user — do NOT reference the rounds, the other models, or the collaboration process. Just give the best answer.`;

        return prompt;
    }
};

module.exports = prompts;
