#!/usr/bin/env node
/**
 * One-shot first-boot setup for Research Intelligence.
 *
 * Turns a bare n8n + ChromaDB + Ollama stack into a running pipeline:
 *   1. waits for n8n and Chroma to answer
 *   2. creates the n8n owner account (if this is a fresh instance)
 *   3. provisions the four Chroma collections and seeds the arXiv category
 *      watchlist
 *   4. creates the Telegram credential inside n8n
 *   5. imports both workflows, wires the Telegram credential in, and
 *      activates them
 *
 * Every step is idempotent -- re-running it on an already-configured stack
 * is a no-op rather than a duplicate. Runs on Node's built-in fetch; no
 * dependencies.
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://n8n:5678';
const CHROMA_BASE_URL = process.env.CHROMA_BASE_URL || 'http://chroma:8000';

const OWNER_EMAIL = process.env.N8N_OWNER_EMAIL || '';
const OWNER_PASSWORD = process.env.N8N_OWNER_PASSWORD || '';
const OWNER_FIRST = process.env.N8N_OWNER_FIRST_NAME || 'Research';
const OWNER_LAST = process.env.N8N_OWNER_LAST_NAME || 'Intelligence';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CREDENTIAL_NAME = 'Research Intelligence Telegram Bot';

const ARXIV_CATEGORIES = (process.env.ARXIV_CATEGORIES || 'cs.AI')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
const ARXIV_MAX_RESULTS = Number(process.env.ARXIV_MAX_RESULTS || 5);

const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || '/workflows';

const PLACEHOLDER = /^replace-with-/i;
const isSet = (v) => Boolean(v) && !PLACEHOLDER.test(v);

const log = (msg) => console.log(`[bootstrap] ${msg}`);
const warn = (msg) => console.log(`[bootstrap] WARNING: ${msg}`);

let authCookie = '';

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${N8N_BASE_URL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authCookie ? { Cookie: authCookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed, raw: res };
}

async function chroma(pathname, { method = 'GET', body } = {}) {
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
  return { ok: res.ok, status: res.status, body: parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the REST API specifically, not just /healthz -- n8n answers
 * /healthz a few seconds before /rest/settings is actually serving, and a
 * settings call made in that window comes back unusable.
 */
async function waitForN8n() {
  const deadline = Date.now() + 180000;
  let lastSeen = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await api('/rest/settings');
      if (res.ok && res.body?.data?.userManagement) {
        log('n8n is up and its REST API is serving.');
        return res.body.data.userManagement;
      }
      lastSeen = `HTTP ${res.status}`;
    } catch (e) {
      lastSeen = e.message;
    }
    await sleep(3000);
  }
  throw new Error(`n8n REST API never became ready at ${N8N_BASE_URL} within 3 minutes (last saw: ${lastSeen}).`);
}

async function waitForChroma() {
  const deadline = Date.now() + 120000;
  let lastSeen = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await chroma('/api/v1/heartbeat');
      if (res.ok) {
        log('ChromaDB is up.');
        return;
      }
      lastSeen = `HTTP ${res.status}`;
    } catch (e) {
      lastSeen = e.message;
    }
    await sleep(2000);
  }
  throw new Error(`ChromaDB never became ready at ${CHROMA_BASE_URL} within 2 minutes (last saw: ${lastSeen}).`);
}

async function ensureOwner(userManagement) {
  const needsSetup = userManagement?.showSetupOnFirstLoad;

  if (needsSetup === undefined) {
    throw new Error('Could not determine whether n8n has an owner account yet -- refusing to guess.');
  }

  if (needsSetup) {
    if (!isSet(OWNER_EMAIL) || !isSet(OWNER_PASSWORD)) {
      throw new Error(
        'This is a fresh n8n instance but N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD are not set in .env. ' +
          'Set them (password needs 8+ characters, one uppercase letter and one number) and re-run.'
      );
    }
    const res = await api('/rest/owner/setup', {
      method: 'POST',
      body: {
        email: OWNER_EMAIL,
        firstName: OWNER_FIRST,
        lastName: OWNER_LAST,
        password: OWNER_PASSWORD,
      },
    });
    if (!res.ok) {
      throw new Error(`Could not create the n8n owner account: ${JSON.stringify(res.body)}`);
    }
    // Owner setup already returns a session, so a separate login is unnecessary.
    const setCookie = res.raw.headers.get('set-cookie');
    if (setCookie) authCookie = setCookie.split(';')[0];
    log(`Created n8n owner account for ${OWNER_EMAIL}.`);
  } else {
    log('n8n owner account already exists -- skipping.');
  }
}

async function login() {
  if (authCookie) {
    log('Already authenticated from owner setup.');
    return;
  }
  if (!isSet(OWNER_EMAIL) || !isSet(OWNER_PASSWORD)) {
    warn('N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD are not set, cannot log in to attach credentials or import workflows. Setup finishes here.');
    return false;
  }
  // n8n has used different field names for this across versions; try both.
  const attempts = [
    { emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD },
    { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  ];
  for (const body of attempts) {
    const res = await api('/rest/login', { method: 'POST', body });
    if (res.ok) {
      const setCookie = res.raw.headers.get('set-cookie');
      if (setCookie) {
        authCookie = setCookie.split(';')[0];
        log('Authenticated against n8n.');
        return true;
      }
    }
  }
  // Reaching here almost always means one specific thing: n8n's volume already
  // holds an owner account created with a different password, so the account
  // was skipped rather than created, and the password now in .env was never
  // applied to anything. Say that plainly instead of "wrong credentials",
  // which sends people hunting for a typo that isn't there.
  throw new Error(
    `Could not log in to n8n as ${OWNER_EMAIL}.\n` +
      '         n8n already has an owner account, so the password in .env was never applied to it —\n' +
      '         setup only ever creates that account, it cannot change an existing one.\n' +
      '         Fix it either way:\n' +
      '           - put the ORIGINAL password back in .env, or\n' +
      '           - reset n8n only:  docker compose down\n' +
      '                              docker volume rm ' +
      `${process.env.COMPOSE_PROJECT_NAME || 'research-intelligence'}_n8n_data\n` +
      '                              docker compose up -d\n' +
      '         Resetting affects n8n alone (account, credentials, execution history), all of which\n' +
      '         are rebuilt automatically. Papers, chunks and subscribers live in ChromaDB and survive.'
  );
}

/**
 * Ensures a Chroma collection exists. Returns its ID. Idempotent thanks to
 * `get_or_create`.
 */
async function ensureCollection(name) {
  const res = await chroma('/api/v1/collections', {
    method: 'POST',
    body: { name, get_or_create: true },
  });
  if (!res.ok) {
    throw new Error(`Could not create Chroma collection "${name}" (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body?.id;
}

async function ensureChromaCollections() {
  // research_papers holds chunked paper text + embeddings.
  await ensureCollection('research_papers');
  log('Chroma collection "research_papers" ready.');

  // digest_subscribers holds Telegram chat IDs that opted in to the daily digest.
  await ensureCollection('digest_subscribers');
  log('Chroma collection "digest_subscribers" ready.');

  // arxiv_categories holds the watchlist -- which arXiv categories to fetch
  // each day, how many results per category, and whether each is active.
  // We store settings in metadata, using a dummy zero embedding.
  const categoriesId = await ensureCollection('arxiv_categories');
  log('Chroma collection "arxiv_categories" ready.');

  // question_log holds a rolling record of Telegram questions and whether
  // they were answered. Used by the dashboard for the "questions asked"
  // KPI and recent activity view.
  await ensureCollection('question_log');
  log('Chroma collection "question_log" ready.');

  await seedCategories(categoriesId);
}

async function seedCategories(collectionId) {
  const existing = await chroma(`/api/v1/collections/${collectionId}/get`, {
    method: 'POST',
    body: { limit: 100 },
  });
  if (existing.ok && (existing.body?.ids?.length || 0) > 0) {
    log(`arXiv category watchlist already has ${existing.body.ids.length} entr${existing.body.ids.length === 1 ? 'y' : 'ies'} -- skipping seed.`);
    return;
  }

  const ids = [];
  const documents = [];
  const embeddings = [];
  const metadatas = [];

  for (const code of ARXIV_CATEGORIES) {
    ids.push(code);
    documents.push(code);
    embeddings.push([0]);
    metadatas.push({
      code,
      maxResults: ARXIV_MAX_RESULTS,
      active: true,
      addedAt: new Date().toISOString(),
    });
  }

  if (ids.length === 0) return;

  const res = await chroma(`/api/v1/collections/${collectionId}/upsert`, {
    method: 'POST',
    body: { ids, documents, embeddings, metadatas },
  });
  if (res.ok) {
    log(`Seeded arXiv watchlist with: ${ARXIV_CATEGORIES.join(', ')}.`);
  } else {
    warn(`Could not seed the arXiv watchlist (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
}

async function ensureTelegramCredential() {
  if (!isSet(TELEGRAM_BOT_TOKEN)) {
    warn('TELEGRAM_BOT_TOKEN not set -- skipping the Telegram credential. The bot will not respond to messages until this is fixed.');
    return null;
  }
  if (!authCookie) {
    warn('Not authenticated to n8n -- skipping Telegram credential creation.');
    return null;
  }

  const existing = await api('/rest/credentials');
  const list = existing.body?.data || [];
  const found = list.find((c) => c.name === TELEGRAM_CREDENTIAL_NAME);
  if (found) {
    log(`Telegram credential "${TELEGRAM_CREDENTIAL_NAME}" already exists -- skipping creation.`);
    return found.id;
  }

  const res = await api('/rest/credentials', {
    method: 'POST',
    body: {
      name: TELEGRAM_CREDENTIAL_NAME,
      type: 'telegramApi',
      data: { accessToken: TELEGRAM_BOT_TOKEN, baseUrl: 'https://api.telegram.org' },
    },
  });

  if (!res.ok) {
    warn(`Could not create the Telegram credential: ${JSON.stringify(res.body)}`);
    return null;
  }
  const id = res.body?.data?.id;
  log(`Created Telegram credential "${TELEGRAM_CREDENTIAL_NAME}".`);
  return id;
}

/**
 * Rewrites every Telegram node in a workflow to point at the given credential
 * ID, so the imported workflow doesn't ship with the placeholder ID from the
 * JSON template.
 */
function applyTelegramCredential(workflow, credentialId) {
  if (!credentialId) return workflow;
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.telegram' || node.type === 'n8n-nodes-base.telegramTrigger') {
      node.credentials = { telegramApi: { id: credentialId, name: TELEGRAM_CREDENTIAL_NAME } };
    }
  }
  return workflow;
}

async function activateWorkflow(id, name) {
  // n8n exposes activation slightly differently across versions; try both shapes.
  let res = await api(`/rest/workflows/${id}`, { method: 'PATCH', body: { active: true } });
  if (!res.ok) {
    res = await api(`/rest/workflows/${id}/activate`, { method: 'POST', body: {} });
  }
  if (res.ok) {
    log(`Activated "${name}".`);
  } else {
    warn(`Imported "${name}" but could not activate it automatically: ${JSON.stringify(res.body)}. Toggle it Active in the n8n UI.`);
  }
}

/**
 * Patches an already-imported workflow's Telegram node(s) to point at the
 * current credential if they aren't already. No-op when there's nothing to
 * attach or nothing has changed, so this is safe to call every run.
 */
async function ensureTelegramCredentialAttached(workflowId, name, telegramCredentialId) {
  if (!telegramCredentialId) return;

  const full = await api(`/rest/workflows/${workflowId}`);
  const workflow = full.body?.data;
  if (!workflow || !Array.isArray(workflow.nodes)) return;

  let changed = false;
  for (const node of workflow.nodes) {
    const isTelegram = node.type === 'n8n-nodes-base.telegram' || node.type === 'n8n-nodes-base.telegramTrigger';
    if (isTelegram && node.credentials?.telegramApi?.id !== telegramCredentialId) {
      node.credentials = { telegramApi: { id: telegramCredentialId, name: TELEGRAM_CREDENTIAL_NAME } };
      changed = true;
    }
  }
  if (!changed) return;

  const res = await api(`/rest/workflows/${workflowId}`, {
    method: 'PATCH',
    body: { nodes: workflow.nodes },
  });
  if (res.ok) {
    log(`Attached Telegram credential to "${name}".`);
  } else {
    warn(`Could not attach Telegram credential to "${name}": ${JSON.stringify(res.body)}`);
  }
}

async function importWorkflows(telegramCredentialId) {
  if (!authCookie) {
    warn('Not authenticated to n8n -- skipping workflow import.');
    return;
  }
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    throw new Error(`Workflow directory not found: ${WORKFLOWS_DIR}`);
  }
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    warn(`No workflow JSON files found in ${WORKFLOWS_DIR}.`);
    return;
  }

  const existing = await api('/rest/workflows');
  const existingList = existing.body?.data || [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8'));
    const prepared = applyTelegramCredential(raw, telegramCredentialId);

    const already = existingList.find((w) => w.name === prepared.name);
    if (already) {
      log(`Workflow "${prepared.name}" already imported.`);
      // An already-imported workflow is skipped past the code below that
      // attaches the Telegram credential to a brand-new import -- so on
      // every later run (e.g. after the user fixes TELEGRAM_BOT_TOKEN and
      // re-runs bootstrap) this is the only place that credential ever
      // gets attached.
      await ensureTelegramCredentialAttached(already.id, prepared.name, telegramCredentialId);
      await activateWorkflow(already.id, prepared.name);
      continue;
    }

    const res = await api('/rest/workflows', {
      method: 'POST',
      body: {
        name: prepared.name,
        nodes: prepared.nodes,
        connections: prepared.connections,
        settings: prepared.settings || { executionOrder: 'v1' },
        active: false,
      },
    });

    if (!res.ok) {
      warn(`Could not import "${prepared.name}": ${JSON.stringify(res.body)}`);
      continue;
    }
    const id = res.body?.data?.id;
    log(`Imported "${prepared.name}".`);
    await activateWorkflow(id, prepared.name);
  }
}

async function main() {
  log('Starting first-boot setup...');
  const userManagement = await waitForN8n();
  await waitForChroma();
  await ensureOwner(userManagement);
  const loggedIn = await login();
  await ensureChromaCollections();
  if (loggedIn !== false) {
    const telegramCredentialId = await ensureTelegramCredential();
    await importWorkflows(telegramCredentialId);
  }
  log('Setup complete.');
  log(`n8n UI:     ${N8N_BASE_URL.replace('//n8n:', '//localhost:')}`);
  log('Dashboard:  http://localhost:8080');
}

main().catch((err) => {
  console.error(`[bootstrap] FAILED: ${err.message}`);
  process.exit(1);
});
