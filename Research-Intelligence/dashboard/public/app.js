'use strict';

const $ = (id) => document.getElementById(id);

function text(el, value) {
  el.textContent = value === null || value === undefined || value === '' ? '\u2014' : String(value);
}

function formatDate(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function showError(message) {
  const el = $('error-notice');
  el.textContent = message;
  el.hidden = !message;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

/* ---------- rendering ---------- */

function renderComponents(health) {
  const container = $('components');
  container.innerHTML = '';

  const pills = [
    { name: 'n8n', state: health.n8n },
    { name: 'ChromaDB', state: health.chroma },
    { name: 'Ollama', state: health.ollama, extra: health.ollamaModels ? `${health.ollamaModels.length} model(s) loaded` : null },
    {
      name: 'Telegram bot',
      state: health.telegramConfigured ? 'up' : 'warn',
      extra: health.telegramConfigured ? 'token configured' : 'token missing',
    },
  ];

  for (const pill of pills) {
    const div = document.createElement('div');
    div.className = 'component-pill';
    const dot = document.createElement('span');
    const dotClass =
      pill.state === 'up' ? 'dot-up' : pill.state === 'down' ? 'dot-down' : pill.state === 'warn' ? 'dot-warn' : 'dot-unknown';
    dot.className = `component-dot ${dotClass}`;
    const info = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'component-name';
    name.textContent = pill.name;
    const state = document.createElement('p');
    state.className = 'component-state';
    state.textContent = pill.extra || (pill.state === 'up' ? 'reachable' : pill.state === 'down' ? 'unreachable' : pill.state === 'warn' ? 'needs attention' : 'unknown');
    info.append(name, state);
    div.append(dot, info);
    container.appendChild(div);
  }
}

function renderStats(stats) {
  text($('kpi-papers'), stats.papers);
  text($('kpi-chunks'), stats.chunks);
  text($('kpi-subs'), stats.subscribers);
  text($('kpi-questions'), stats.questionsAsked);
}

function emptyRow(tbody, colspan, message) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = 'empty';
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderPapers(papers) {
  const tbody = $('papers-body');
  tbody.innerHTML = '';
  if (!papers.length) {
    emptyRow(tbody, 3, 'No papers indexed yet. The ingestion workflow will populate this after its next run.');
    return;
  }
  for (const paper of papers) {
    const tr = document.createElement('tr');
    const published = document.createElement('td');
    published.textContent = formatDay(paper.published);
    const title = document.createElement('td');
    title.className = 'article-cell';
    if (paper.pdfUrl) {
      const link = document.createElement('a');
      link.href = paper.pdfUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = paper.title || paper.arxivId;
      title.appendChild(link);
    } else {
      title.textContent = paper.title || '\u2014';
    }
    const arxiv = document.createElement('td');
    arxiv.className = 'mono';
    arxiv.textContent = paper.arxivId || '\u2014';
    tr.append(published, title, arxiv);
    tbody.appendChild(tr);
  }
}

function renderCategories(entries) {
  const tbody = $('categories-body');
  tbody.innerHTML = '';
  if (!entries.length) {
    emptyRow(tbody, 4, 'No categories being monitored yet. Add one below.');
    return;
  }
  for (const entry of entries) {
    const tr = document.createElement('tr');

    const code = document.createElement('td');
    code.className = 'mono cell-strong';
    code.textContent = entry.code;

    const maxResults = document.createElement('td');
    maxResults.className = 'num';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '50';
    input.value = String(entry.maxResults);
    input.className = 'threshold-input';
    input.addEventListener('change', async () => {
      try {
        await api(`/api/categories/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ maxResults: Number(input.value) }),
        });
        showError('');
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
    maxResults.appendChild(input);

    const active = document.createElement('td');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = entry.active;
    toggle.addEventListener('change', async () => {
      try {
        await api(`/api/categories/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: toggle.checked }),
        });
        showError('');
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
    active.appendChild(toggle);

    const actions = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-link';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Stop monitoring ${entry.code}?`)) return;
      try {
        await api(`/api/categories/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
        showError('');
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
    actions.appendChild(remove);

    tr.append(code, maxResults, active, actions);
    tbody.appendChild(tr);
  }
}

function renderSubscribers(subs) {
  const tbody = $('subs-body');
  tbody.innerHTML = '';
  if (!subs.length) {
    emptyRow(tbody, 2, 'Nobody has subscribed yet. Send /subscribe to your bot to appear here.');
    return;
  }
  for (const sub of subs) {
    const tr = document.createElement('tr');
    const chatId = document.createElement('td');
    chatId.className = 'mono cell-strong';
    chatId.textContent = sub.chatId;
    const added = document.createElement('td');
    added.textContent = formatDate(sub.addedAt);
    tr.append(chatId, added);
    tbody.appendChild(tr);
  }
}

function renderQuestions(questions) {
  const tbody = $('questions-body');
  tbody.innerHTML = '';
  if (!questions.length) {
    emptyRow(tbody, 4, 'No questions logged yet. Anything the bot is asked will appear here.');
    return;
  }
  for (const q of questions) {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    when.textContent = formatDate(q.askedAt);
    const chatId = document.createElement('td');
    chatId.className = 'mono';
    chatId.textContent = q.chatId ? String(q.chatId) : '\u2014';
    const question = document.createElement('td');
    question.className = 'article-cell';
    question.textContent = q.question;
    const answered = document.createElement('td');
    answered.innerHTML = q.answered ? '<span class="tick">\u2713</span>' : '<span class="dash">\u2014</span>';
    tr.append(when, chatId, question, answered);
    tbody.appendChild(tr);
  }
}

/* ---------- data loading ---------- */

async function refresh() {
  try {
    const health = await api('/api/health');
    renderComponents(health);
    $('setup-notice').hidden = health.telegramConfigured;

    const chromaUp = health.chroma === 'up';
    if (!chromaUp) {
      renderStats({});
      renderPapers([]);
      renderCategories([]);
      renderSubscribers([]);
      renderQuestions([]);
      showError('ChromaDB is unreachable. The stack may still be starting up -- give it a minute and refresh.');
      return;
    }

    const [stats, papersData, categoriesData, subsData, questionsData] = await Promise.all([
      api('/api/stats'),
      api('/api/papers?limit=50'),
      api('/api/categories'),
      api('/api/subscribers'),
      api('/api/questions?limit=25'),
    ]);

    renderStats(stats);
    renderPapers(papersData.papers);
    renderCategories(categoriesData.categories);
    renderSubscribers(subsData.subscribers);
    renderQuestions(questionsData.questions);
    showError('');
    $('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    showError(err.message);
  }
}

$('refresh').addEventListener('click', refresh);

$('category-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = $('form-error');
  errorEl.hidden = true;

  try {
    await api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({
        code: data.get('code'),
        maxResults: Number(data.get('maxResults')),
        active: true,
      }),
    });
    form.reset();
    form.querySelector('[name="maxResults"]').value = '5';
    refresh();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

refresh();
setInterval(refresh, 60000);
