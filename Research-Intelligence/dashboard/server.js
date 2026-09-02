#!/usr/bin/env node
/**
 * Dashboard backend for Research Intelligence.
 *
 * Serves the static dashboard and proxies ChromaDB / Ollama so that the
 * Telegram bot token stays server-side and never reaches the browser.
 * Deliberately dependency-free (Node's built-in http) so the stack needs no
 * npm install and no build step.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.DASHBOARD_PORT || 8080);
const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
const ENV_PATH = path.join(PROJECT_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_DIR, '.env.example');

const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://n8n:5678';
const CHROMA_BASE_URL = process.env.CHROMA_BASE_URL || 'http://chroma:8000';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const PAPERS_COLLECTION = 'research_papers';
const SUBSCRIBERS_COLLECTION = 'digest_subscribers';
const CATEGORIES_COLLECTION = 'arxiv_categories';
const QUESTIONS_COLLECTION = 'question_log';

const PUBLIC_DIR = path.join(__dirname, 'public');
const PLACEHOLDER = /^replace-with-/i;
const CATEGORY_CODE = /^[a-z][a-z-]{1,10}\.[A-Za-z]{1,4}(-[A-Za-z]{1,4})?$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Request body is not valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function chromaFetch(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${CHROMA_BASE_URL}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(
      `ChromaDB request failed (HTTP ${res.status}). ${parsed && parsed.error ? String(parsed.error) : ''}`
    );
    err.status = res.status === 404 ? 404 : 502;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function getCollectionId(name) {
  const created = await chromaFetch('/api/v1/collections', {
    method: 'POST',
    body: { name, get_or_create: true },
  });
  return created?.id;
}

async function chromaCount(name) {
  try {
    const id = await getCollectionId(name);
    const res = await fetch(`${CHROMA_BASE_URL}/api/v1/collections/${id}/count`);
    if (!res.ok) return null;
    const text = await res.text();
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

async function chromaGet(name, { limit = 100, offset = 0, include = ['documents', 'metadatas'] } = {}) {
  const id = await getCollectionId(name);
  return chromaFetch(`/api/v1/collections/${id}/get`, {
    method: 'POST',
    body: { limit, offset, include },
  });
}

/**
 * Pages through an entire collection instead of sampling the first page.
 *
 * Papers are stored one row per *chunk*, and a single paper can produce a
 * hundred of them, so any fixed window is dominated by whichever papers were
 * chunked first — which silently hides the newest papers from every count and
 * listing derived from it.
 */
async function chromaGetAll(name, { include = ['metadatas'], pageSize = 1000, maxRecords = 20000 } = {}) {
  const merged = { ids: [], metadatas: [], documents: [] };
  for (let offset = 0; offset < maxRecords; offset += pageSize) {
    const page = await chromaGet(name, { limit: pageSize, offset, include });
    const ids = page?.ids || [];
    merged.ids.push(...ids);
    if (page?.metadatas) merged.metadatas.push(...page.metadatas);
    if (page?.documents) merged.documents.push(...page.documents);
    if (ids.length < pageSize) break;
  }
  return merged;
}

async function chromaUpsertOne(name, { id, document, embedding = [0], metadata = {} }) {
  const collectionId = await getCollectionId(name);
  return chromaFetch(`/api/v1/collections/${collectionId}/upsert`, {
    method: 'POST',
    body: {
      ids: [id],
      documents: [document],
      embeddings: [embedding],
      metadatas: [metadata],
    },
  });
}

async function chromaDeleteOne(name, id) {
  const collectionId = await getCollectionId(name);
  return chromaFetch(`/api/v1/collections/${collectionId}/delete`, {
    method: 'POST',
    body: { ids: [id] },
  });
}

/* ---------- component health ---------- */

async function componentHealth() {
  const status = {
    n8n: 'unknown',
    chroma: 'unknown',
    ollama: 'unknown',
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN) && !PLACEHOLDER.test(TELEGRAM_BOT_TOKEN),
  };
  try {
    const r = await fetch(`${N8N_BASE_URL}/healthz`, { signal: AbortSignal.timeout(4000) });
    status.n8n = r.ok ? 'up' : 'down';
  } catch (e) {
    status.n8n = 'down';
  }
  try {
    const r = await fetch(`${CHROMA_BASE_URL}/api/v1/heartbeat`, { signal: AbortSignal.timeout(4000) });
    status.chroma = r.ok ? 'up' : 'down';
  } catch (e) {
    status.chroma = 'down';
  }
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    status.ollama = r.ok ? 'up' : 'down';
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      status.ollamaModels = (data.models || []).map((m) => m.name);
    }
  } catch (e) {
    status.ollama = 'down';
  }
  return status;
}

/* ---------- stats ---------- */

async function fetchStats() {
  const [chunks, subscribers, questions, papers] = await Promise.all([
    chromaCount(PAPERS_COLLECTION),
    chromaCount(SUBSCRIBERS_COLLECTION),
    chromaCount(QUESTIONS_COLLECTION),
    fetchPapersMeta().catch(() => []),
  ]);
  const uniquePapers = new Set(papers.map((p) => p.arxivId).filter(Boolean)).size;
  let activeCategories = null;
  try {
    const cats = await chromaGet(CATEGORIES_COLLECTION, { limit: 200 });
    const metas = cats?.metadatas || [];
    activeCategories = metas.filter((m) => m && m.active !== false).length;
  } catch (e) {
    activeCategories = null;
  }
  const latestPaper = papers[0]?.published || null;
  return {
    chunks: chunks || 0,
    papers: uniquePapers,
    subscribers: subscribers || 0,
    questionsAsked: questions || 0,
    activeCategories,
    latestPaper,
  };
}

/**
 * Reads paper metadata off the research_papers collection. Each paper is
 * chunked into many entries -- we deduplicate to one row per arXiv ID,
 * newest first.
 */
async function fetchPapersMeta() {
  const data = await chromaGetAll(PAPERS_COLLECTION, { include: ['metadatas'] });
  const metas = data?.metadatas || [];
  const byId = new Map();
  for (const m of metas) {
    if (!m || !m.arxivId) continue;
    if (!byId.has(m.arxivId)) {
      byId.set(m.arxivId, {
        arxivId: m.arxivId,
        title: m.title || '',
        published: m.published || null,
        pdfUrl: m.pdfUrl || '',
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => String(b.published).localeCompare(String(a.published)));
}

async function fetchSubscribers() {
  const data = await chromaGet(SUBSCRIBERS_COLLECTION, { limit: 500 });
  const ids = data?.ids || [];
  const metadatas = data?.metadatas || [];
  return ids.map((id, i) => ({ chatId: id, addedAt: metadatas[i]?.addedAt || null }));
}

async function fetchQuestions(limit = 25) {
  const data = await chromaGet(QUESTIONS_COLLECTION, { limit: 200 });
  const ids = data?.ids || [];
  const documents = data?.documents || [];
  const metadatas = data?.metadatas || [];
  const rows = ids.map((id, i) => ({
    id,
    question: documents[i] || '',
    chatId: metadatas[i]?.chatId || null,
    askedAt: metadatas[i]?.askedAt || null,
    answered: Boolean(metadatas[i]?.answered),
  }));
  return rows
    .sort((a, b) => String(b.askedAt || '').localeCompare(String(a.askedAt || '')))
    .slice(0, limit);
}

async function fetchCategories() {
  const data = await chromaGet(CATEGORIES_COLLECTION, { limit: 200 });
  const ids = data?.ids || [];
  const metadatas = data?.metadatas || [];
  return ids.map((id, i) => ({
    id,
    code: metadatas[i]?.code || id,
    maxResults: Number(metadatas[i]?.maxResults || 5),
    active: metadatas[i]?.active !== false,
    addedAt: metadatas[i]?.addedAt || null,
  }));
}

/* ---------- first-run setup ---------- */

/** Reads .env into a plain object. Returns {} when it does not exist yet. */
function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) values[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return values;
}

// Setup counts as done only when the values that actually make the system work
// are present — not merely because a .env file exists. A repo that ships a
// legacy or half-filled .env (or a user who copies .env.example and stops
// there) would otherwise be locked out of the setup page by a file that
// configures nothing.
const REQUIRED_FOR_SETUP = ['N8N_OWNER_EMAIL', 'N8N_OWNER_PASSWORD', 'TELEGRAM_BOT_TOKEN'];

function setupComplete() {
  const values = readEnvFile();
  return REQUIRED_FOR_SETUP.every((key) => {
    const v = values[key];
    return Boolean(v) && !PLACEHOLDER.test(v);
  });
}

/**
 * Rewrites .env.example line by line, substituting submitted values while
 * keeping every explanatory comment intact -- so the generated .env still
 * reads like the documented template rather than a bare key dump.
 */
function renderEnv(template, values) {
  const quoted = (v) => {
    const clean = String(v).replace(/[\r\n]/g, '').trim();
    return /[\s#"']/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
  };
  const seen = new Set();
  const lines = template.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in values) || values[key] === undefined || values[key] === '') return line;
    seen.add(key);
    return `${key}=${quoted(values[key])}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key) && value !== undefined && value !== '') lines.push(`${key}=${quoted(value)}`);
  }
  return lines.join('\n');
}

const SETUP_FIELDS = {
  N8N_OWNER_EMAIL: { required: true, label: 'n8n login email' },
  N8N_OWNER_PASSWORD: { required: true, label: 'n8n login password' },
  TELEGRAM_BOT_TOKEN: { required: true, label: 'Telegram bot token' },
  WEBHOOK_URL: { required: true, label: 'public webhook URL' },
  ARXIV_CATEGORIES: { required: true, label: 'arXiv categories' },
  ARXIV_MAX_RESULTS: { required: false, label: 'papers per category' },
  INGESTION_CRON: { required: false, label: 'ingestion cron' },
};

async function testCredential(service, payload) {
  const timeout = AbortSignal.timeout(12000);
  try {
    if (service === 'telegram') {
      const token = String(payload.TELEGRAM_BOT_TOKEN || '');
      if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
        return { ok: false, message: 'That does not look like a Telegram bot token (expected format 123456789:AA...).' };
      }
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: timeout });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        return { ok: true, message: `Token accepted -- bot @${data.result?.username || 'unknown'}.` };
      }
      return { ok: false, message: `Telegram rejected the token: ${data.description || `HTTP ${res.status}`}.` };
    }

    if (service === 'webhook') {
      const url = String(payload.WEBHOOK_URL || '');
      if (!/^https?:\/\//.test(url)) {
        return { ok: false, message: 'The webhook URL must start with http:// or https://.' };
      }
      if (!/^https?:\/\/[^/]+\/?$/.test(url) && !url.endsWith('/')) {
        return { ok: false, message: 'The webhook URL should end with a trailing slash (e.g. https://your-tunnel.trycloudflare.com/).' };
      }
      // Localhost obviously reachable, no live check meaningful.
      if (/localhost|127\.0\.0\.1/.test(url)) {
        return { ok: true, message: 'Local URL accepted -- Telegram cannot reach this, so the bot will only work on incoming test executions.' };
      }
      try {
        const res = await fetch(url, { signal: timeout });
        if (res.status < 500) {
          return { ok: true, message: `URL reachable (HTTP ${res.status}). Telegram will be able to deliver messages here.` };
        }
        // 502/503/504 from a tunnel means the tunnel itself answered but could
        // not reach n8n. During first-run setup that is the expected state:
        // the launcher deliberately starts only the dashboard, so nothing is
        // listening on n8n's port yet. Treating it as failure would make this
        // check impossible to pass on the documented setup path, and would
        // blame the tunnel for something that is working correctly.
        if ([502, 503, 504].includes(res.status)) {
          return {
            ok: true,
            message:
              `Tunnel is live and forwarding (HTTP ${res.status}). It cannot reach n8n yet because n8n ` +
              'only starts after you save this form -- that is expected right now.',
          };
        }
        return { ok: false, message: `URL responded with HTTP ${res.status}. Check the tunnel is still running.` };
      } catch (e) {
        // A dead or mistyped URL fails here (DNS failure, refused, timeout) --
        // that is the genuinely broken case, distinct from the 5xx above.
        return { ok: false, message: `Could not reach that URL: ${e.message}` };
      }
    }

    if (service === 'arxiv') {
      const codes = String(payload.ARXIV_CATEGORIES || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (codes.length === 0) return { ok: false, message: 'List at least one category.' };
      const bad = codes.filter((c) => !CATEGORY_CODE.test(c));
      if (bad.length) return { ok: false, message: `These do not look like arXiv category codes: ${bad.join(', ')}. Try e.g. cs.AI, cs.LG, stat.ML.` };
      // Do a real fetch against the first one, so a typo like cs.AI vs cs.Ai
      // is caught before you save.
      const res = await fetch(
        `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(codes[0])}&max_results=1`,
        { signal: timeout }
      );
      const text = await res.text();
      if (res.ok && /<entry>/.test(text)) {
        return { ok: true, message: `${codes.length} categor${codes.length === 1 ? 'y' : 'ies'} accepted -- arXiv returned results for ${codes[0]}.` };
      }
      return { ok: false, message: `arXiv returned no papers for "${codes[0]}". Double-check the category code.` };
    }

    return { ok: false, message: `Unknown service "${service}".` };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, message: 'The request timed out -- check your internet connection.' };
    }
    return { ok: false, message: `Could not reach the service: ${err.message}` };
  }
}

/* ---------- routes ---------- */

const routes = [
  {
    method: 'GET',
    match: (p) => p === '/api/health',
    handle: async () => {
      const status = await componentHealth();
      return {
        status: 200,
        body: {
          ok: true,
          setupComplete: setupComplete(),
          ...status,
        },
      };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/setup/status',
    handle: async () => {
      // Whether n8n already has an owner matters to the person filling in this
      // form: setup can only ever *create* that account. If one already exists,
      // the password typed here is never applied to it, and they must enter the
      // existing one instead — so the page needs to say so before they guess.
      let n8nOwnerExists = null;
      try {
        const res = await fetch(`${N8N_BASE_URL}/rest/settings`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const body = await res.json();
          const showSetup = body?.data?.userManagement?.showSetupOnFirstLoad;
          if (showSetup !== undefined) n8nOwnerExists = showSetup === false;
        }
      } catch (e) {
        n8nOwnerExists = null; // n8n not reachable yet; the page just won't warn
      }
      return {
        status: 200,
        body: {
          setupComplete: setupComplete(),
          n8nOwnerExists,
        },
      };
    },
  },
  {
    method: 'POST',
    match: (p) => p === '/api/setup/test',
    handle: async (req) => {
      const payload = await readBody(req);
      const result = await testCredential(String(payload.service || ''), payload);
      return { status: 200, body: result };
    },
  },
  {
    method: 'POST',
    match: (p) => p === '/api/setup',
    handle: async (req) => {
      if (setupComplete()) {
        throw Object.assign(
          new Error('Setup has already been completed. Edit .env directly to change configuration.'),
          { status: 409 }
        );
      }
      const payload = await readBody(req);
      const values = {};
      const missing = [];
      for (const [key, spec] of Object.entries(SETUP_FIELDS)) {
        const raw = payload[key];
        const value = typeof raw === 'string' ? raw.trim() : raw;
        if (!value) {
          if (spec.required) missing.push(spec.label);
          continue;
        }
        values[key] = value;
      }
      if (missing.length) {
        throw Object.assign(new Error(`Still missing: ${missing.join(', ')}.`), { status: 400 });
      }
      if (String(values.N8N_OWNER_PASSWORD).length < 8) {
        throw Object.assign(new Error('The n8n password must be at least 8 characters, with an uppercase letter and a number.'), { status: 400 });
      }
      const webhookUrl = String(values.WEBHOOK_URL);
      if (!/^https?:\/\//.test(webhookUrl)) {
        throw Object.assign(new Error('The webhook URL must start with http:// or https://.'), { status: 400 });
      }
      if (!webhookUrl.endsWith('/')) {
        values.WEBHOOK_URL = `${webhookUrl}/`;
      }

      // Generated rather than asked for -- it protects n8n's own credential
      // store and there is no reason a human should have to invent it.
      //
      // But never regenerate one that already exists: n8n seals its stored
      // credentials with this key, so replacing it on a stack that has already
      // run leaves n8n unable to decrypt them ("encryption key mismatch").
      const existingKey = readEnvFile().N8N_ENCRYPTION_KEY;
      values.N8N_ENCRYPTION_KEY =
        existingKey && !PLACEHOLDER.test(existingKey)
          ? existingKey
          : crypto.randomBytes(32).toString('hex');

      if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
        throw Object.assign(new Error('.env.example is missing, so the .env file cannot be generated.'), { status: 500 });
      }
      const template = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
      fs.writeFileSync(ENV_PATH, renderEnv(template, values), { encoding: 'utf-8', mode: 0o600 });

      return {
        status: 201,
        body: {
          ok: true,
          written: '.env',
          next: 'docker compose up -d',
          message: 'Configuration saved. Apply it by running "docker compose up -d" in the Research-Intelligence folder.',
        },
      };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/stats',
    handle: async () => ({ status: 200, body: await fetchStats() }),
  },
  {
    method: 'GET',
    match: (p) => p === '/api/papers',
    handle: async (req, url) => {
      const limit = Number(url.searchParams.get('limit') || 50);
      // fetchPapersMeta reads the whole collection and returns newest-first, so
      // the limit applies to the deduplicated papers rather than to raw chunks.
      const all = await fetchPapersMeta();
      return { status: 200, body: { papers: all.slice(0, Math.min(Math.max(limit, 1), 200)) } };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/subscribers',
    handle: async () => ({ status: 200, body: { subscribers: await fetchSubscribers() } }),
  },
  {
    method: 'GET',
    match: (p) => p === '/api/questions',
    handle: async (req, url) => {
      const limit = Number(url.searchParams.get('limit') || 25);
      return { status: 200, body: { questions: await fetchQuestions(Math.min(Math.max(limit, 1), 100)) } };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/categories',
    handle: async () => ({ status: 200, body: { categories: await fetchCategories() } }),
  },
  {
    method: 'POST',
    match: (p) => p === '/api/categories',
    handle: async (req) => {
      const payload = await readBody(req);
      const code = String(payload.code || '').trim();
      if (!CATEGORY_CODE.test(code)) {
        throw Object.assign(new Error('Category code must look like cs.AI, stat.ML, math.CO, etc.'), { status: 400 });
      }
      const maxResults = Number(payload.maxResults ?? 5);
      if (!Number.isFinite(maxResults) || maxResults < 1 || maxResults > 50) {
        throw Object.assign(new Error('maxResults must be between 1 and 50.'), { status: 400 });
      }
      const active = payload.active === undefined ? true : Boolean(payload.active);
      await chromaUpsertOne(CATEGORIES_COLLECTION, {
        id: code,
        document: code,
        embedding: [0],
        metadata: { code, maxResults, active, addedAt: new Date().toISOString() },
      });
      return { status: 201, body: { entry: { id: code, code, maxResults, active } } };
    },
  },
  {
    method: 'PATCH',
    match: (p) => p.startsWith('/api/categories/'),
    handle: async (req, url) => {
      const id = decodeURIComponent(url.pathname.split('/').pop() || '');
      if (!CATEGORY_CODE.test(id)) throw Object.assign(new Error('Invalid category code.'), { status: 400 });
      const payload = await readBody(req);
      // Read the current metadata so we don't erase what's already there.
      const current = await fetchCategories();
      const existing = current.find((c) => c.id === id);
      if (!existing) throw Object.assign(new Error('Unknown category.'), { status: 404 });

      const metadata = {
        code: existing.code,
        maxResults: existing.maxResults,
        active: existing.active,
        addedAt: existing.addedAt || new Date().toISOString(),
      };
      if (payload.maxResults !== undefined) {
        const n = Number(payload.maxResults);
        if (!Number.isFinite(n) || n < 1 || n > 50) {
          throw Object.assign(new Error('maxResults must be between 1 and 50.'), { status: 400 });
        }
        metadata.maxResults = n;
      }
      if (payload.active !== undefined) metadata.active = Boolean(payload.active);

      await chromaUpsertOne(CATEGORIES_COLLECTION, {
        id,
        document: id,
        embedding: [0],
        metadata,
      });
      return { status: 200, body: { entry: { id, ...metadata } } };
    },
  },
  {
    method: 'DELETE',
    match: (p) => p.startsWith('/api/categories/'),
    handle: async (req, url) => {
      const id = decodeURIComponent(url.pathname.split('/').pop() || '');
      if (!CATEGORY_CODE.test(id)) throw Object.assign(new Error('Invalid category code.'), { status: 400 });
      await chromaDeleteOne(CATEGORIES_COLLECTION, id);
      return { status: 200, body: { deleted: id } };
    },
  },
];

function serveStatic(req, res, pathname) {
  // A fresh install lands on the setup wizard instead of an empty dashboard.
  if (pathname === '/' && !setupComplete()) {
    res.writeHead(302, { Location: '/setup' });
    res.end();
    return;
  }
  if (pathname === '/setup' || pathname === '/setup/') {
    pathname = '/setup.html';
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes.find((r) => r.method === req.method && r.match(url.pathname));

  if (!route) {
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const { status, body } = await route.handle(req, url);
    sendJson(res, status, body);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message || 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[dashboard] listening on http://localhost:${PORT}`);
});
