# Claude Code Handoff — Brandon AI Video Command Center

## Project Overview
A dashboard + n8n workflow system that auto-generates AI video content (viking warrior character) and posts to social media. The pipeline: Creative Director Agent (Claude) generates scene ideas → Photo Prompt Generator → Kie.ai image generation → Wan 2.6 video generation → Telegram approval → social media upload.

## File Locations

### Dashboard
- **Dashboard root:** `/Users/loki/.gemini/antigravity/scratch/n8n-dashboard/`
- `index.html` — Main dashboard HTML
- `app.js` — Dashboard controller (pipeline monitor, social media, prompt editor, agent panel)
- `styles.css` — All styles
- `server.js` — Node.js backend (serves static files, proxies to n8n API, OAuth, event log reader)
- `config.json` — Stored OAuth tokens and platform connections
- `data.json` — Local data store (replaces Google Sheets)

### n8n
- **Workflow ID:** `72EXSrxJ5IckthuP`
- **Workflow name:** "Client # 1 Brandon | Video Creation One character"
- **n8n URL:** http://localhost:5678
- **n8n login:** `loki@local.dev` / `n8nAdmin2026!`
- **Event log:** `/Users/loki/.n8n/n8nEventLog.log`

### Frog Water App (separate project)
- `/Users/loki/frog-water/index.html` — Animated frog water reminder app
- `/Users/loki/frog-water/server.js` — Telegram bot + WebSocket bridge (port 3456)
- **Telegram bot token:** Set via `TELEGRAM_BOT_TOKEN` environment variable

## Running the Dashboard
```bash
cd /Users/loki/.gemini/antigravity/scratch/n8n-dashboard
node server.js
# Runs on http://localhost:3333
# Proxies n8n API from localhost:5678
```

## Credentials

### Kie.ai (Image Generation)
- **API Key:** Set via `KIE_API_KEY` environment variable
- **n8n credential ID:** `ym3AaxDoep9wbxAT` (Header Auth)
- **Whitelisted IP:** `66.68.32.100`
- **API endpoint:** `https://api.kie.ai/api/v1/jobs/createTask`
- **Model:** `nano-banana-pro`

### Claude (Creative Director)
- **n8n credential ID:** `mYXoswfq7a60eKFo`
- **Model in workflow:** `claude-sonnet-4-20250514`

### Telegram
- **n8n credential ID:** `ITUv2dmAK5CrcRTW`
- **Chat ID:** `7700134015`

### Google Sheets
- **n8n credential ID:** `7luyuGegsUxcpRy6`
- **Sheet ID:** `1FBQG3i-u4eyC43FraWw4wqpp_eWUrV5L-JQYHRh_Cfg`

### Google OAuth (YouTube)
- **Client ID:** Set via `GOOGLE_CLIENT_ID` environment variable
- **Client Secret:** Set via `GOOGLE_CLIENT_SECRET` environment variable

## What Was Done (Session Summary)

### Workflow Fixes
1. **Creative Director Agent wasn't firing** — chainLlm v1.7 silently skips on empty `{}` input from trigger nodes. Fixed by adding a "Kickstart Input" Set node between triggers and the agent that provides `{"input": "Generate a new unique creative direction for this run."}`.

2. **Image gen infinite retry loop** — Image Creation Checker Switch node fallback was routing to output 0 ("Failed" → Edit Prompt → retry). Changed fallback to output 1 ("Polling" → Wait for image).

3. **Kie.ai 401 errors** — API key had wrong prefix (`c7351360e` → `7351360e`). Corrected and IP `66.68.32.100` whitelisted.

4. **Kie.ai 422 content rejection** — Original NSFW prompt triggered content filter. Toned down base prompt twice:
   - Final working prompt: "eastern European woman, fit viking shield-maiden, young athletic model, toned and strong, ornate shoulder armor with gold armlets and leather detailing, warrior crop top and fitted skirt with metal accents, sun-kissed skin with natural imperfections for realism, varied outfits and hairstyles each time, confident powerful pose, iphone candid quality rather than overly polished."
   - **Tested directly against Kie.ai — returns 200 success.**

5. **Removed `batching: {}`** from Creative Director Agent and Photo Prompt Generator nodes.

### Dashboard Fixes
1. **Pipeline monitor showed 0%** — n8n doesn't expose intermediate node data via REST API for running executions (returns `[]`). Fixed by adding a `/pipeline/events/{execId}` endpoint on the dashboard server that reads n8n's event log file (`n8nEventLog.log`) for real-time node-by-node progress.

2. **Flatted parsing** — Added `flatted` CDN library for parsing completed execution data (n8n uses circular-JSON-safe serialization).

3. **Stop button** — Added a stop button to the pipeline monitor header. Calls `POST /api/executions/{id}/stop`. Previous version failed because `apiFetch()` couldn't parse the response; fixed to use raw `fetch()`.

4. **18+ Content Alert** — Added an alert banner in the pipeline monitor that:
   - Appears (amber/red) when "Edit Prompt" node runs (= content was rejected by Kie.ai)
   - Shows retry count and elapsed timer
   - Turns **green** ("Resolved") when pipeline moves past image gen successfully
   - Resets on new pipeline runs

### Key Architecture Notes
- n8n execution data uses **Flatted** serialization (handles circular JSON references). Must use `Flatted.parse()` not `JSON.parse()`.
- n8n `chainLlm v1.7` nodes silently skip when input is empty `{}` — always ensure non-empty input.
- Running executions return `data: "[]"` via API — must use event log for real-time monitoring.
- Dashboard server proxies `/api/*` → n8n `/rest/*` with auto-login on 401.
- The workflow has 44 nodes total.

## Pipeline Stages (in app.js)
```
creative-director: Kickstart Input → Creative Director Agent → Claude Creative Brain → Creative Director Parser → Edit Fields
photo-prompt:      Photo Prompt Generator → Claude Opus Chat Model1 → Structured Output Parser2
image-gen:         Nano Banana Image Generation → Wait for image → Check if the image is ready → Image Creation Checker → Image URL Cleaner → Edit Prompt → Claude Opus Chat Model
video-gen:         Wan 2.6 Video Generator → Wait for Video → Check on Video Generation → Video Generation Check → Clean Video URL → Video Prompt Generator → Structured Output Parser
review:            Analyze video → "Content Prohibited" Check → Policy Checking Validator → Ask For Approval → Approval Switch → Upload Video → YouTube Upload (Draft)
```

## Execution History
- **#22** — error (Claude model error in Edit Prompt)
- **#23** — canceled (manually stopped)
- **#24** — canceled (manually stopped, stop button was broken at the time but actually worked)
- **#25** — error (Kie.ai 422 content rejection, then image poll timeout after 30 cycles)
- **Next run** should work with the updated clean prompt (tested successfully against Kie.ai API)

## Known Issues / TODO
- YouTube is connected via OAuth; Instagram, Facebook, X, TikTok are not yet connected
- The "Test Generate" button in the Creative Director Agent panel uses mock data (no `/api/test-agent` endpoint on server)
- Video prompt suffix and schedule save buttons work locally but may need workflow sync verification
- If Kie.ai changes their content policy, the prompt may need further adjustment
- Consider adding a max retry limit for the image polling loop (currently polls indefinitely until n8n times out)
