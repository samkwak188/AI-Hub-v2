1. voice control
2. web page auto control - click, scroll

Puter js: https://docs.puter.com

---

# AI Collaboration Cost Optimization (Research-Backed)

## Objective
Reduce API cost as much as possible while maintaining high discussion quality in the multi-model collaboration pipeline.

## Proven Findings From Research and Official Docs
1. Model routing and cascades can cut cost heavily without quality collapse.
- RouteLLM (ICLR 2025) reports more than 2x cost reduction and large gains over random routing on benchmark quality/cost frontiers.
- FrugalGPT reports large cost savings (often substantial, dataset-dependent) with cascade and routing strategies while preserving or improving quality at fixed budget.

2. Debate quality depends on what models exchange.
- Multiagent Debate (ICML 2024) shows sharing concise reasoning traces is better than only sharing final answers.
- The same work also shows summarized debate context can reduce token usage and can improve outcomes by reducing noise.

3. Provider-native cost controls are meaningful.
- OpenAI prompt caching can reduce repeated input cost/latency when prompt prefixes are stable.
- OpenAI Batch API gives lower cost for asynchronous, non-real-time jobs.
- Cloudflare Workers AI has model-specific pricing and AI Gateway request caching for repeated identical calls.

## Practical Strategy For This App
1. Add Round-0 router before debate.
- Use a cheaper classifier model to output:
`difficulty`, `visual_complexity`, `need_multi_model`, `expected_value_of_debate`.

2. Switch from fixed 4-round/3-model orchestration to adaptive paths.
- Easy: single model + self-check.
- Medium: 2 models, reduced rounds.
- Hard: full debate.
- This is the main expected cost lever.

3. Replace verbose cross-round transcripts with compact structured exchange.
- Use a strict `ReasoningCard` JSON for each model:
`answer`, `key_steps`, `evidence_refs`, `uncertainty`, `confidence`.
- Apply hard token caps per field.

4. Keep direct image input, but compress visual handoff.
- Continue direct screenshot to vision-capable models.
- Continue optional OpenAI vision packet, but pass a compact normalized subset to later rounds.

5. Add early-exit gates.
- If model agreement and confidence pass thresholds in Round 1 or Round 2, skip later rounds.
- Trigger full rounds only on disagreement, low confidence, or high-ambiguity visual data.

6. Optimize prompt-cache compatibility.
- Keep system prompt and static instructions byte-stable.
- Keep section ordering stable.
- Reuse shared prefixes for round prompts to maximize cache hits.

7. Use Batch API only for offline tasks.
- Good fit: nightly evals, replay testing, quality regression checks.
- Not for interactive chat responses.

## Expected Impact (Directional)
1. Router + adaptive rounds: strongest savings lever.
2. Structured compact exchange: meaningful token reduction each turn.
3. Early exit: major savings on easy/medium queries.
4. Prompt caching: additional savings when prompt prefixes repeat.

Combined impact should materially lower average per-message cost while preserving quality on harder tasks.

## Implementation Plan In This Repo
1. `server/orchestrator.js`
- Add Round-0 router.
- Add policy engine for easy/medium/hard path selection.
- Add early-exit checks after each round.
- Add strict token budgets per round.

2. `server/prompts.js`
- Create compact `ReasoningCard` response schema for R1/R2/R3.
- Add concise synthesis prompt that consumes only structured cards.
- Keep static prompt prefixes stable for cache friendliness.

3. `server/index.js`
- Add debug telemetry flags for:
`route_decision`, `rounds_run`, `tokens_in/out`, `cache_hit_rate`, `estimated_cost`.

4. Frontend (`sidebar.js`, `sidebar.html`)
- Optional advanced toggle for `Cost Optimized Mode`.
- Keep existing Vision Packet toggle.

5. Evaluation loop
- Build a fixed eval set (math, graph, reading, follow-up scenarios).
- Compare baseline vs optimized pipeline on:
accuracy, agreement quality, latency, and cost per solved question.

## Metrics To Track
1. `avg_cost_per_user_turn`
2. `avg_tokens_per_turn` and by round
3. `rounds_executed_distribution`
4. `early_exit_rate`
5. `router_path_distribution`
6. `accuracy_on_eval_set`
7. `p95_latency`

## Sources
- RouteLLM paper: https://arxiv.org/pdf/2406.18665
- FrugalGPT paper: https://arxiv.org/pdf/2305.05176
- Multiagent Debate (ICML 2024): https://openreview.net/pdf?id=zj7YuTE4t8
- OpenAI prompt caching docs: https://platform.openai.com/docs/guides/prompt-caching/overview
- OpenAI cost optimization docs: https://platform.openai.com/docs/guides/cost-optimization
- OpenAI Batch API docs: https://platform.openai.com/docs/api-reference/batch/retrieve
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare AI Gateway caching: https://developers.cloudflare.com/ai-gateway/features/caching/
