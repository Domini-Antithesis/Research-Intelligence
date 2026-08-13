# Research Intelligence — Research Paper Digest & Q&A Bot

Capstone project **#19 "Research Paper Digest & Q&A Bot"** (Academia / Research domain, Intermediate difficulty) from the *Generative AI Foundations & No-Code Agentic AI with n8n* capstone compendium. Phase 1 implementation — built strictly with the tools the brief specifies: **n8n, the arXiv API, Ollama, ChromaDB, and Telegram**. No other services are used.

## Problem statement

Researchers and students struggle to keep up with 100+ new papers published daily in their field. Reading abstracts alone takes 2–3 hours a day, and deep Q&A over papers otherwise requires full manual reading.

## Proposed solution

n8n fetches daily arXiv papers by category, downloads the PDFs, extracts and chunks the text, and embeds the chunks into ChromaDB. A Telegram bot lets any user ask questions; n8n retrieves the relevant chunks and Ollama generates a grounded answer with citations. A daily digest of newly indexed papers is also pushed to every subscribed Telegram user each morning.

**Target users:** researchers, students, academics following a fast-moving field.
**Business value:** near-total reduction in manual literature triage; grounded answers with citations reduce the risk of hallucinated claims.

## Architecture

Two n8n workflows, sharing the same Ollama and ChromaDB services.

### 1. `Daily arXiv Ingestion` (workflows/arxiv-daily-ingestion.json)

Runs on a schedule (default `0 8 * * *`, daily 8am):

```text
Daily arXiv schedule
  → Fetch arXiv feed              (arXiv API, cat:cs.AI, 5 most recent)
  → Normalise papers               (parse Atom feed → title/abstract/arXiv ID/PDF URL)
  → Download paper PDF
  → Extract PDF text
  → Chunk paper text               (~1200 chars, 180 overlap, per paper)
  → Embed chunk with Ollama        (nomic-embed-text)
  → Combine chunk and embedding
  → Create research collection     (ChromaDB get_or_create: research_papers)
  → Upsert chunk to ChromaDB
  → Build daily digest             (deterministic text: title + arXiv ID + link + truncated abstract per paper)
  → Get subscribers collection     (ChromaDB get_or_create: digest_subscribers)
  → List subscribers
  → Expand subscribers             (fan out: one item per subscribed chat ID)
  → Send daily digest              (Telegram, one message per subscriber)
```

### 2. `Telegram Cited Q&A` (workflows/telegram-cited-qa.json)

Triggered by any incoming Telegram message:

```text
TelegramTrigger
  → Normalise question             (extract chatId + question text)
  → Is subscribe command?     ──true──→ Get subscribers collection → Add subscriber   → Reply subscribed
  → Is unsubscribe command?   ──true──→ Get subscribers collection → Remove subscriber → Reply unsubscribed
  → (else, a normal question)
  → Create research collection
  → Embed question with Ollama     (nomic-embed-text)
  → Retrieve relevant chunks       (ChromaDB query, top 4)
  → Build grounded prompt          (numbered citation context)
  → Generate cited answer          (Ollama, llama3.2 — instructed to never invent citations)
  → Reply with cited answer
```

`/subscribe` and `/unsubscribe` work for **any** Telegram user, not just one account — each chat ID is stored/removed independently in the `digest_subscribers` ChromaDB collection, and the ingestion workflow's digest step fans out to everyone subscribed at run time. The Q&A path is likewise per-sender: `chatId` is read from each incoming message, so multiple people can use the bot concurrently and each gets their own reply.

## Tools & compliance

| Tool | Role |
|---|---|
| n8n | Orchestration (both workflows) |
| arXiv API | Open-access paper metadata + PDFs |
| Ollama (`nomic-embed-text`, `llama3.2`) | Local embeddings + local LLM — nothing leaves the machine |
| ChromaDB | Vector store for paper chunks (`research_papers`) and subscriber list (`digest_subscribers`) |
| Telegram | Bot interface (Q&A + digest delivery) |

Matches the brief's compliance note: *"ArXiv papers are open access | Local Ollama + ChromaDB: fully on-prem RAG."*

## KPIs

| KPI (from brief) | How it's met |
|---|---|
| 100% of daily papers indexed | Ingestion chunks and embeds every fetched paper, not just the first — verified live: 5/5 papers, 381 chunks in one run |
| Q&A answer with citations in < 15 sec | Retrieval + prompt build is sub-second; the bottleneck is `llama3.2` generation itself, which depends on host hardware (CPU-only can take 1–2 min per answer — see Limitations) |
| Daily digest summary auto-sent each morning | Added in this phase: `Build daily digest` → subscriber fan-out → Telegram send, chained after indexing completes |

## Prerequisites

See `requirements.txt` for the full list. In short: Docker Desktop (or Docker Engine + Compose v2), a Telegram account, ~6 GB free disk, 8 GB+ RAM recommended.

## Setup — step by step

All commands below assume you're in `Agent/Research-Intelligence/`.

### 1. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set a real `N8N_ENCRYPTION_KEY` (any long random string — this encrypts credentials n8n stores, so keep it safe). Example way to generate one:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Leave `WEBHOOK_URL` as the default (`http://localhost:5678/`) for now — it only needs to change if you want the Telegram bot to receive live messages (see step 6).

### 2. Start the stack

```bash
docker compose up -d
```

This starts four containers: `n8n`, `chroma`, `ollama`, and a one-shot `ollama-init` that runs `ollama pull nomic-embed-text && ollama pull llama3.2` (a few GB download, only needed once — the models persist in the `ollama_data` volume). Check everything is healthy:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
curl -s http://localhost:5678/healthz          # n8n
curl -s http://localhost:8000/api/v1/heartbeat # ChromaDB
curl -s http://localhost:11434/api/tags        # Ollama, lists pulled models
```

### 3. Create the n8n owner account

Open `http://localhost:5678` in a browser and follow the first-run setup screen (any email/password — this is a local account, not shared anywhere).

### 4. Import both workflows

In the n8n UI: **Workflows → Import from File**, and pick each of:

- `workflows/arxiv-daily-ingestion.json`
- `workflows/telegram-cited-qa.json`

(Or via the n8n CLI inside the container, if you prefer scripting it:)

```bash
docker cp workflows/arxiv-daily-ingestion.json research-intelligence-n8n:/tmp/
docker cp workflows/telegram-cited-qa.json research-intelligence-n8n:/tmp/
docker exec research-intelligence-n8n n8n import:workflow --input=/tmp/arxiv-daily-ingestion.json
docker exec research-intelligence-n8n n8n import:workflow --input=/tmp/telegram-cited-qa.json
```

### 5. Create your Telegram bot and wire up the credential

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. It replies with a token like `123456789:AAH...`.
2. In n8n: **Credentials → New → Telegram API**, paste the token, save. Name it something like "Research Intelligence Telegram Bot".
3. Open each workflow and, on every Telegram node (`TelegramTrigger`, `Reply subscribed`, `Reply unsubscribed`, `Reply with cited answer`, `Send daily digest`), select this credential — they ship with a `REPLACE_WITH_TELEGRAM_CREDENTIAL_ID` placeholder by design (credentials are secrets and are never committed to the repo).
4. In `arxiv-daily-ingestion`, the `Send daily digest` node's `chatId` field can stay as-is — the workflow now fans out to every subscriber automatically, it doesn't need a hardcoded chat ID.

### 6. Make the Telegram trigger reachable (local dev only)

Telegram delivers messages by calling n8n's webhook over the public internet — `localhost` isn't reachable from there. This step is **only needed for local development**; skip it entirely if you deploy n8n somewhere with a real public domain (or use n8n.cloud).

Using [cloudflared](https://github.com/cloudflare/cloudflared) (free, no account needed for a quick tunnel):

```bash
# Download once (Windows example; see cloudflared releases for other platforms)
curl -sL -o cloudflared.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

# Start the tunnel (leave this running)
./cloudflared.exe tunnel --url http://localhost:5678
```

It prints a URL like `https://random-words.trycloudflare.com`. Put that in `.env`:

```text
WEBHOOK_URL=https://random-words.trycloudflare.com/
```

Then recreate the n8n container so it picks up the new value:

```bash
docker compose up -d n8n
```

### 7. Activate and test

1. In n8n, open `Telegram Cited Q&A` and toggle it **Active** (this registers the webhook with Telegram).
2. Open `Daily arXiv Ingestion` and click **Execute workflow** once to populate ChromaDB (a full run embeds ~300+ chunks one at a time via Ollama, so it can take several minutes — this is expected, not a hang).
3. In Telegram, message your bot:
   - `/subscribe` → confirms you'll get the daily digest
   - Any question about the papers just ingested → a cited answer (may take 1–2 minutes for `llama3.2` to generate on CPU-only hardware)
   - `/unsubscribe` → stops the digest

Once you're happy with a manual test run, you can leave `Daily arXiv Ingestion` on its default `0 8 * * *` schedule and activate it too, so ingestion + digest happen automatically every morning.

## Verifying data landed correctly (optional)

Useful for confirming ingestion actually populated ChromaDB, without needing the n8n UI:

```bash
# Get the research_papers collection ID and chunk count
COLL_ID=$(curl -s -X POST http://localhost:8000/api/v1/collections \
  -H "Content-Type: application/json" \
  -d '{"name":"research_papers","get_or_create":true}' | python -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -s "http://localhost:8000/api/v1/collections/$COLL_ID/count"

# Peek at a few stored chunks
curl -s -X POST "http://localhost:8000/api/v1/collections/$COLL_ID/get" \
  -H "Content-Type: application/json" \
  -d '{"limit":3,"include":["documents","metadatas"]}'
```

## Troubleshooting

- **`docker compose up` fails with an encryption key mismatch.** This happens if `.env`'s `N8N_ENCRYPTION_KEY` doesn't match what a previous run already stored in the `n8n_data` volume. Either reuse the original key, or wipe the volume for a clean start: `docker compose down && docker volume rm research-intelligence_n8n_data && docker compose up -d`. This forgets any workflows/credentials/executions in n8n — but not the data already indexed in ChromaDB (`chroma_data` is a separate volume) or the models Ollama already pulled (`ollama_data`).
- **`n8n import:workflow` logs `Active version not found for workflow` / `Could not remove webhooks`.** Harmless on first import into a workflow that's never been active; the import still succeeds ("Successfully imported 1 workflow"). If you see it repeatedly on an existing workflow along with the Telegram webhook actually not responding (a direct `curl` to the webhook URL returns 404 "not registered" instead of 403), n8n's internal trigger registration has gotten out of sync with its own database — a plain `docker restart research-intelligence-n8n` usually fixes it; if not, the clean-volume reset above will.
- **Telegram bot doesn't respond to messages.** Check `curl https://api.telegram.org/bot<token>/getWebhookInfo` — the `url` field should match your tunnel/public URL exactly, and `last_error_message` should be empty. A `403 Provided secret is not valid` on a manual test `curl` to that URL is *expected* (Telegram signs real requests, your test curl doesn't) — it actually confirms the webhook is registered. A `404` means it's not registered at all; reactivate the workflow.
- **Ollama requests suddenly take minutes instead of seconds.** Usually means many requests queued up faster than Ollama can process them (e.g. from testing a schedule trigger with a very short interval). `docker restart research-intelligence-ollama` clears the queue; the models stay cached in the volume so no re-download happens.
- **One ChromaDB upsert fails with "Bad request" out of hundreds of successful ones.** Rare transient hiccup, not a data problem — both `Embed chunk with Ollama` and `Upsert chunk to ChromaDB` are configured with `retryOnFail`, and `Upsert chunk to ChromaDB` additionally continues on failure so one bad chunk doesn't abort the whole run.

## Setup & run — quick summary

1. `cp .env.example .env`, set `N8N_ENCRYPTION_KEY`
2. `docker compose up -d`
3. Create n8n owner account at `localhost:5678`
4. Import both workflow JSON files
5. Create a Telegram bot via @BotFather, add its token as a Telegram API credential in n8n, attach it to every Telegram node
6. (Local dev only) run a tunnel, set `WEBHOOK_URL`, `docker compose up -d n8n`
7. Activate `Telegram Cited Q&A`, run `Daily arXiv Ingestion` once manually, then test via Telegram

## Known limitations (deferred to a later "complexity" phase, not built here)

- **Answer latency depends on hardware.** `llama3.2` on CPU-only machines can take well over the brief's 15-second target per answer; a GPU host or a smaller/faster model would close that gap.
- **Single arXiv category, fixed page size.** Currently hardcoded to `cat:cs.AI`, 5 papers/day — configurable by editing the HTTP node's query string, not yet a user-facing setting.
- **Digest content is deterministic, not LLM-narrated.** Keeps the digest reliable and fast; an Ollama-summarised version is a natural upgrade later.
- **No per-user preferences** (categories of interest, digest time, language) — every subscriber gets the same daily digest.
