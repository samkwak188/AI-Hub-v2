# AI Hub V2

> Multiple AI models see your screen and debate to give you one precise, verified answer.

AI Hub V2 is a Chrome Extension (Manifest V3) that opens as a **side panel** alongside any webpage. When you ask a question, it dispatches your query to **four different AI models simultaneously**, runs a structured **4-round debate protocol**, and returns a single consensus answer — far more reliable than any single model alone.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How It Works — The 4-Round Debate](#how-it-works--the-4-round-debate)
- [Project Structure](#project-structure)
- [File-by-File Breakdown](#file-by-file-breakdown)
- [Screen Context System](#screen-context-system)
- [Models Used](#models-used)
- [Setup & Installation](#setup--installation)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)

---

## Architecture Overview

```
┌────────────────────────────────────────────────┐
│              Chrome Browser                    │
│                                                │
│  ┌──────────────┐      ┌────────────────────┐  │
│  │  Active Tab   │◄────│   background.js    │  │
│  │  (any page)   │     │  (service worker)  │  │
│  └──────────────┘      └─────────┬──────────┘  │
│                                  │              │
│                          ┌───────▼──────────┐   │
│                          │   Side Panel UI  │   │
│                          │  sidebar.html    │   │
│                          │  sidebar.js      │   │
│                          │  sidebar.css     │   │
│                          └───────┬──────────┘   │
└──────────────────────────────────┼──────────────┘
                                   │ HTTP + SSE
                          ┌────────▼──────────┐
                          │   Express Server  │
                          │   server/index.js │
                          └────────┬──────────┘
                                   │
                          ┌────────▼──────────┐
                          │   Orchestrator    │
                          │  orchestrator.js  │
                          └────────┬──────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
   ┌──────▼──────┐    ┌───────────▼──────────┐   ┌────────▼────────┐
   │   OpenAI    │    │  Cloudflare Workers   │   │  Cloudflare     │
   │  GPT-4o    │    │  Mistral · Gemma ·    │   │  DeepSeek R1    │
   │ (+ vision)  │    │  (text-only)          │   │  (text-only)    │
   └─────────────┘    └──────────────────────┘   └─────────────────┘
```

**Data flow in one sentence:** The sidebar captures the user's question (+ optional screenshot/page text), sends it to the Express backend via `POST /api/chat`, which orchestrates a 4-round multi-model debate via the orchestrator, streaming real time progress back to the sidebar over **Server-Sent Events (SSE)**.

---

## How It Works — The 4-Round Debate

Every user question triggers a structured deliberation pipeline. Each round serves a distinct purpose, and all models participate in parallel within each round.

### Round 1 — Independent Answers

Each model receives the user's question, page context, conversation history, and screenshot analysis. They answer **independently** without seeing each other's responses. This maximizes diversity of thought and prevents groupthink.

**Prompt role:** `Independent analyst`
**Output structure:** Direct Answer → Reasoning Steps → Validation Checks → Assumptions → Confidence (0–100)

### Round 2 — Peer Cross-Validation

Every model receives **all** Round 1 answers and is tasked with auditing them for factual, logical, and arithmetic errors. Models identify hallucinated or unsupported claims and produce a corrected draft.

**Prompt role:** `Critical reviewer`
**Output structure:** Error Audit Per Model → Confirmed Correct Points → Disagreements & Resolution → Corrected Draft → Remaining Risks → Confidence (0–100)

### Round 3 — Consensus Discussion

Models see both Round 1 and Round 2 outputs. Their job is to converge on a single defensible answer, keeping only claims that survived cross-validation and removing or rewriting anything with unresolved uncertainty.

**Prompt role:** `Consensus builder`
**Output structure:** Consensus Candidate Answer → Evidence for Consensus → Rejected Claims → Unresolved Issues → Sign-off Checklist → Confidence (0–100)

### Round 4 — Final Synthesis

A single synthesizer model (preferring GPT-4o) ingests outputs from all three prior rounds and produces the final user-facing answer. The output is clean — no mention of rounds, model names, or internal process.

**Prompt role:** `Final synthesizer`
**Output:** The polished, precise, final answer to the user.

> **Single-model fallback:** If only one model is configured, the system still runs a 2-step process: initial answer → self-validation using the Round 4 prompt.

---

## Project Structure

```
AI-HUB/
├── manifest.json          # Chrome Extension manifest (V3)
├── background.js          # Service worker: screenshot capture & page text extraction
├── content.js             # Content script injected into all pages (placeholder for future features)
├── sidebar.html           # Side panel UI markup
├── sidebar.js             # Sidebar logic: chat, context handling, API calls, markdown rendering
├── sidebar.css            # Full styling for the sidebar UI
├── icons/                 # Extension icons (16, 48, 128px)
└── server/
    ├── .env               # API keys (gitignored — you create this)
    ├── index.js            # Express server: CORS, health check, SSE chat endpoint
    ├── orchestrator.js     # 4-round multi-model debate engine
    ├── prompts.js          # Structured prompt templates for each round
    ├── package.json        # Node.js dependencies
    └── package-lock.json   # Dependency lock file
```

---

## File-by-File Breakdown

### `manifest.json`

Declares the extension as **Manifest V3** with these key permissions:

| Permission   | Purpose                                                |
|--------------|--------------------------------------------------------|
| `sidePanel`  | Opens the chat UI as a Chrome side panel               |
| `activeTab`  | Access to the currently active tab                     |
| `tabs`       | Query tab metadata (title, URL)                        |
| `scripting`  | Inject scripts into pages for content extraction       |
| `storage`    | Persist user settings (server URL) across sessions     |

Host permissions are set to `<all_urls>` to allow screenshot capture and content extraction on any page.

---

### `background.js` — Service Worker

Handles two message types from the sidebar:

1. **`CAPTURE_SCREENSHOT`** — Uses `chrome.tabs.captureVisibleTab()` to take a JPEG screenshot (quality 85) of the active tab. Returns the base64 data URL along with the tab's title and URL.

2. **`GET_PAGE_CONTENT`** — Uses `chrome.scripting.executeScript()` to inject a function into the active tab that:
   - Checks for user-selected text (>50 chars) and returns it as `type: 'selection'`
   - Otherwise extracts the main content by cloning the `<article>`, `<main>`, `[role="main"]`, or `<body>` element
   - Strips out `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, `<iframe>`, `<svg>`, and ARIA-hidden elements
   - Returns cleaned text (up to 10,000 chars) as `type: 'page'`

---

### `content.js` — Content Script

A lightweight placeholder injected into all pages at `document_idle`. Currently empty — exists for future extensibility (e.g., highlight-to-ask features).

---

### `sidebar.html` — Side Panel UI

The HTML structure for the sidebar, featuring:

- **Header** — Logo, extension title ("AI Collab"), New Chat button, Settings button
- **Chat container** — Welcome state showing participating model badges (GPT-4o, Mistral 24B, Gemma 12B, DeepSeek R1), and a scrollable message area
- **Input area** — Textarea with a "Screen" context toggle button, send button, and a context status indicator
- **Settings modal** — Backend URL configuration, server connection check, and a read-only list of active models (API keys are managed server-side)

---

### `sidebar.js` — Sidebar Logic (847 lines)

The core client-side logic, organized into these subsystems:

#### State Management
- `messages[]` — Full chat history (role, content, timestamp)
- `includePageContext` — Boolean toggle for screen context
- `cachedScreenContext` — Most recent captured context
- `screenContextHistory[]` — Up to 10 prior contexts for multi-turn reference
- `settings.serverUrl` — Configurable backend URL (default: `http://localhost:3001`)

#### Follow-Up Detection
The system intelligently detects whether a new message is a follow-up to avoid unnecessarily re-capturing screen context:

- **Cue regex** — Matches openers like "and", "also", "why", "how about", etc.
- **Reference regex** — Matches pronouns like "it", "this", "that", "them", etc.
- **Topic overlap** — Extracts topic words (filtering stop words), computes Jaccard overlap; ≥35% overlap → follow-up

If a question is a follow-up, the **cached** screen context is reused. Otherwise, a fresh capture is initiated.

#### Page Context Pipeline
1. `togglePageContext()` — Activates/deactivates the "Screen" button
2. `captureAndCacheScreenContext()` — Captures screenshot + page text in parallel
3. `resolveScreenContextForMessage()` — Decides whether to refresh or reuse context based on follow-up detection
4. `buildPriorContexts()` — Attaches up to 3 most recent prior screen contexts (excluding the current one) for multi-turn visual reasoning
5. `mapContextForModel()` — Normalizes a context object for the API payload, truncating text to configurable character limits

#### API Communication
- Sends `POST` to `{serverUrl}/api/chat` with JSON body: `{ message, context?, priorContexts?, history }`
- History includes the last 12 messages (excluding the current one)
- Handles **SSE streaming**: parses `data:` lines for `progress` events (updates the thinking UI) and `result` events (renders the final answer)

#### Rendering
- **Markdown renderer** — Converts bold, italic, headers, lists, blockquotes, links, horizontal rules, code blocks, and inline code
- **LaTeX math** — Converts `\[...\]`, `$$...$$`, and `\(...\)` notation into readable HTML with proper fractions, square roots, superscripts, subscripts, and Greek symbols
- **Collaboration details** — A toggle ("See how models collaborated") that expands to show all 4 rounds with per-model responses, color-coded by provider
- **Thinking indicator** — Animated progress bar showing which round is active (R1 Independent → R2 Validate → R3 Consensus → R4 Final)

---

### `server/index.js` — Express Backend

A lightweight Express server with:

- **Environment loading** — Reads `OPENAI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` from `server/.env`
- **`GET /health`** — Returns server status, active providers, and model count
- **`POST /api/chat`** — Main endpoint. Sets up SSE headers, passes the request to the orchestrator along with a progress callback that emits `data:` events in real time, then sends the final `result` event
- **CORS** enabled globally, JSON body limit set to 50MB (to support base64 screenshots)

---

### `server/orchestrator.js` — Multi-Model Debate Engine

The heart of the system. Key capabilities:

#### Model Registry
`getAvailableModels()` builds the model list from environment keys:

| Model               | Provider           | Vision Support |
|---------------------|--------------------|----------------|
| GPT-4o (mini)       | OpenAI             | ✅ Yes          |
| Mistral Small 3.1 24B | Cloudflare Workers AI | ❌ No        |
| Gemma 3 12B         | Cloudflare Workers AI | ❌ No        |
| DeepSeek R1 Distill 32B | Cloudflare Workers AI | ❌ No    |

#### Vision Pipeline
Since only GPT-4o supports multimodal inputs, the orchestrator:

1. **Pre-analyzes** each screenshot via `callOpenAIVision()` to produce a **textual summary** of on-screen content (UI layout, exact text, key entities, user intent, ambiguities)
2. **Caches** summaries using a hash-based cache (`visionSummaryCache`, max 100 entries) to avoid redundant API calls
3. **Injects the text summary** into prompts for text-only models (Cloudflare models) so they also understand what's on screen
4. **Sends raw screenshots** directly to vision-capable models (GPT-4o) as `image_url` content parts, alongside the text summary

This dual strategy ensures all models have access to visual context, regardless of whether they natively support images.

#### Round Execution
Each round (1–4) follows the same pattern:
1. Build the round-specific prompt via `prompts.js`
2. Call all available models in parallel via `Promise.allSettled()`
3. Collect successful responses, gracefully ignoring failures
4. Emit a progress event to the SSE stream
5. Pass responses to the next round's prompt builder

The final synthesis (Round 4) is handled by a **single designated model** (preferring GPT-4o), not all models in parallel.

---

### `server/prompts.js` — Prompt Templates

Structured prompt builder with a shared `SYSTEM_IDENTITY` preamble enforcing:
- Prioritize correctness over fluency
- Never hallucinate or invent facts
- Keep equations human-readable
- Show explicit logic for non-trivial conclusions

Each round function (`round1` through `round4`) assembles a prompt from:
- System identity + round-specific role
- Conversation history (formatted as `User:` / `Assistant:` pairs)
- Current screen context (title, URL, extracted text, screenshot analysis)
- Prior screen contexts (up to 5 most recent)
- Prior round responses (for rounds 2–4)
- Structured output requirements

---

## Screen Context System

The screen context feature is the main differentiator — models can "see" what you're looking at. Here's the full pipeline:

```
User clicks "Screen" button
        │
        ▼
captureAndCacheScreenContext()
        │
        ├──► getPageContent()      ──► background.js ──► executeScript in tab ──► extracted text
        │
        └──► getScreenshot()       ──► background.js ──► captureVisibleTab ──► JPEG base64
        │
        ▼
Context object: { title, url, type, content, screenshot, capturedAt }
        │
        ▼
├── Cached locally for follow-up reuse
├── Added to screenContextHistory[] for multi-turn reference
        │
        ▼
Sent to backend → enrichContextWithVision() → callOpenAIVision()
        │
        ├──► screenSummary text ──► injected into all model prompts
        └──► raw screenshot ──► sent directly to GPT-4o as image_url
```

**Context types:**
| Type        | Meaning                                     |
|-------------|---------------------------------------------|
| `selection` | User had text selected on the page (>50 chars) |
| `page`      | Main page content extracted successfully     |
| `empty`     | No extractable text found                    |
| `error`     | Extraction failed (restricted page, PDF, etc.) |
| `restricted`| Chrome internal page or otherwise blocked    |

---

## Models Used

| Model                    | Provider              | Endpoint / Model ID                              | Strengths                          |
|--------------------------|-----------------------|---------------------------------------------------|------------------------------------|
| GPT-4o (mini)            | OpenAI                | `gpt-4o-mini`                                     | Vision, synthesis, general purpose |
| Mistral Small 3.1 24B   | Cloudflare Workers AI | `@cf/mistralai/mistral-small-3.1-24b-instruct`   | Fast, strong general purpose       |
| Gemma 3 12B              | Cloudflare Workers AI | `@cf/google/gemma-3-12b-it`                       | Multi-capability, 128K context     |
| DeepSeek R1 Distill 32B  | Cloudflare Workers AI | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`   | Reasoning, outperforms o1-mini     |

---

## Setup & Installation 

### Prerequisites
- **API Keys:** OpenAI API key and/or Cloudflare Account ID + API Token

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/AI-Hub-v2.git
cd AI-Hub-v2
```

### 2. Configure API Keys

Create the server environment file:

```bash
cp server/.env.example server/.env 
```

Edit `server/.env`:

```env
OPENAI_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
```

> You need **at least one** provider configured. With only OpenAI, the system runs in single-model mode (answer + self-validation). With both, the full 4-round multi-model debate activates.

### 3. Install Server Dependencies

```bash
cd server
npm install
```

### 4. Start the Backend Server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

You should see:

```
╔══════════════════════════════════════════╗
║        AI Collab Server Running          ║
║                                          ║
║   URL:  http://localhost:3001            ║
║   API:  http://localhost:3001/api/chat   ║
║                                          ║
║   Ready for multi-AI collaboration! 🧠   ║
╚══════════════════════════════════════════╝
```

### 5. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the root project directory (`AI-Hub-v2/`)
5. The AI Collab icon will appear in your toolbar

### 6. Use

Click the extension icon to open the side panel. Type a question and press Enter. Toggle the **Screen** button to include your current page as context.

---

## Configuration

All configuration is done in two places:

| Setting          | Location         | Default                  |
|------------------|------------------|--------------------------|
| API keys         | `server/.env`    | (none — must be set)     |
| Server port      | `server/.env`    | `PORT=3001`              |
| Backend URL      | Sidebar Settings | `http://localhost:3001`  |

The sidebar settings modal allows you to change the backend URL and test the connection. API keys are **never** stored in the extension — they live server-side only.

---

## API Endpoints

### `GET /health`

Returns server status and configured providers.

```json
{
    "status": "ok",
    "timestamp": "2026-03-08T...",
    "providers": ["openai", "cloudflare"],
    "modelCount": 4
}
```

### `POST /api/chat`

Main chat endpoint. Accepts JSON, returns **Server-Sent Events (SSE)**.

**Request body:**

```json
{
    "message": "What is shown on this page?",
    "context": {
        "title": "Page Title",
        "url": "https://example.com",
        "type": "page",
        "content": "Extracted page text...",
        "screenshot": "data:image/jpeg;base64,...",
        "capturedAt": "2026-03-08T..."
    },
    "priorContexts": [],
    "history": [
        { "role": "user", "content": "previous question" },
        { "role": "assistant", "content": "previous answer" }
    ]
}
```

**SSE events:**

```
data: {"type":"progress","round":1,"status":"Models answering independently..."}
data: {"type":"progress","round":2,"status":"Models cross-checking answers..."}
data: {"type":"progress","round":3,"status":"Models discussing a consensus..."}
data: {"type":"progress","round":4,"status":"Producing final agreed answer..."}
data: {"type":"result","finalAnswer":"...","rounds":[...]}
```

