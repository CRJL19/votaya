/* Frontend sin frameworks: rutas por hash, fetch para la API y EventSource para los resultados en vivo. */
'use strict';

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
let stream = null; // conexión en vivo de la encuesta abierta

const store = {
  read(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  write(key, value) {
    try { localStorage.setItem(key, value); } catch { /* modo privado: se pierde al cerrar */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* sin almacenamiento */ }
  },
};

function voterId() {
  let id = store.read('votaya.voter');
  if (!id) {
    id = crypto.randomUUID();
    store.write('votaya.voter', id);
  }
  return id;
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'toast error' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

async function api(path, { method = 'GET', body, adminToken } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (adminToken) headers['X-Admin-Token'] = adminToken;

  const res = await fetch(`/api${path}`, { method, headers, body: body && JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

function mount(templateId) {
  view.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
}

/* ---------- Inicio: crear y listar ---------- */

function addOptionRow(value = '') {
  const container = document.getElementById('options');
  if (container.children.length >= 6) return toast('Máximo 6 opciones.', true);

  const row = document.createElement('div');
  row.className = 'option-row';

  const input = document.createElement('input');
  input.maxLength = 80;
  input.value = value;
  input.placeholder = `Opción ${container.children.length + 1}`;
  input.setAttribute('aria-label', input.placeholder);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Quitar opción');
  remove.addEventListener('click', () => {
    if (container.children.length > 2) row.remove();
    else toast('Se necesitan al menos 2 opciones.', true);
  });

  row.append(input, remove);
  container.append(row);
}

async function renderHome() {
  mount('home-view');
  addOptionRow();
  addOptionRow();
  document.getElementById('add-option').addEventListener('click', () => addOptionRow());

  document.getElementById('poll-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('create-btn');
    button.disabled = true;
    try {
      const { poll, adminToken } = await api('/polls', {
        method: 'POST',
        body: {
          question: document.getElementById('question').value,
          options: [...document.querySelectorAll('#options input')].map((input) => input.value),
        },
      });
      store.write(`votaya.admin.${poll.id}`, adminToken);
      location.hash = `#/p/${poll.id}`;
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  });

  const list = document.getElementById('poll-list');
  try {
    const polls = await api('/polls');
    if (!polls.length) {
      list.innerHTML = '<li class="muted">Todavía no hay encuestas. Crea la primera.</li>';
      return;
    }
    list.replaceChildren(...polls.map((poll) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#/p/${poll.id}`;
      link.textContent = poll.question;
      const meta = document.createElement('small');
      meta.textContent = `${votesLabel(poll.totalVotes)} · ${poll.status === 'open' ? 'abierta' : 'cerrada'}`;
      item.append(link, meta);
      return item;
    }));
  } catch (error) {
    list.innerHTML = '';
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = `No se pudieron cargar las encuestas: ${error.message}`;
    list.append(item);
  }
}

const votesLabel = (n) => `${n} ${n === 1 ? 'voto' : 'votos'}`;

/* ---------- Encuesta: votar y ver resultados en vivo ---------- */

function renderOptions(poll) {
  const mine = store.read(`votaya.vote.${poll.id}`);
  const canVote = poll.status === 'open' && !mine;
  const list = document.getElementById('poll-options');

  list.replaceChildren(...poll.options.map((option) => {
    const percent = poll.totalVotes ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
    const item = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = option.id === mine ? 'result mine' : 'result';
    button.disabled = !canVote;

    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.style.width = `${percent}%`;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = option.text;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${percent}% · ${option.votes}`;

    button.append(fill, label, count);
    button.addEventListener('click', () => castVote(poll.id, option.id));
    item.append(button);
    return item;
  }));

  document.getElementById('poll-question').textContent = poll.question;
  document.title = `${poll.question} · VotaYa`;

  let summary = votesLabel(poll.totalVotes);
  if (poll.status !== 'open') summary += ' · Votación cerrada';
  else if (mine) summary += ' · Ya votaste';
  else summary += ' · Elige una opción';
  document.getElementById('poll-summary').textContent = summary;

  const closeBtn = document.getElementById('close-poll');
  if (closeBtn) closeBtn.hidden = poll.status !== 'open';
}

async function castVote(pollId, optionId) {
  document.querySelectorAll('.result').forEach((button) => { button.disabled = true; });
  try {
    const poll = await api(`/polls/${pollId}/votes`, {
      method: 'POST',
      body: { optionId, voterId: voterId() },
    });
    store.write(`votaya.vote.${pollId}`, optionId);
    renderOptions(poll);
    toast('Voto registrado.');
  } catch (error) {
    toast(error.message, true);
    renderOptions(await api(`/polls/${pollId}`));
  }
}

function connectLive(pollId) {
  const live = document.getElementById('live');
  stream = new EventSource(`/api/polls/${pollId}/events`);
  stream.onopen = () => { live.hidden = false; };
  stream.onerror = () => { live.hidden = true; }; // EventSource reintenta por su cuenta
  stream.addEventListener('poll', (event) => renderOptions(JSON.parse(event.data)));
  stream.addEventListener('deleted', () => {
    toast('Esta encuesta fue eliminada.', true);
    location.hash = '#/';
  });
}

async function renderPoll(pollId) {
  mount('poll-view');

  let poll;
  try {
    poll = await api(`/polls/${pollId}`);
  } catch (error) {
    view.textContent = '';
    const message = document.createElement('p');
    message.textContent = `${error.message} `;
    const back = document.createElement('a');
    back.href = '#/';
    back.textContent = 'Volver al inicio';
    message.append(back);
    view.append(message);
    return;
  }

  const adminToken = store.read(`votaya.admin.${pollId}`);
  if (adminToken) {
    document.getElementById('admin').hidden = false;

    document.getElementById('close-poll').addEventListener('click', async () => {
      try {
        renderOptions(await api(`/polls/${pollId}/close`, { method: 'POST', adminToken }));
        toast('Votación cerrada.');
      } catch (error) {
        toast(error.message, true);
      }
    });

    document.getElementById('delete-poll').addEventListener('click', async () => {
      if (!confirm('¿Eliminar la encuesta y todos sus votos? No se puede deshacer.')) return;
      try {
        await api(`/polls/${pollId}`, { method: 'DELETE', adminToken });
        store.remove(`votaya.admin.${pollId}`);
        store.remove(`votaya.vote.${pollId}`);
        location.hash = '#/';
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  document.getElementById('share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Enlace copiado.');
    } catch {
      toast('No se pudo copiar. Copia la dirección del navegador.', true);
    }
  });

  renderOptions(poll);
  connectLive(pollId);
}

/* ---------- Rutas ---------- */

function route() {
  if (stream) {
    stream.close();
    stream = null;
  }
  document.title = 'VotaYa · Encuestas en vivo';
  const match = location.hash.match(/^#\/p\/([A-Za-z0-9]+)$/);
  if (match) renderPoll(match[1]);
  else renderHome();
}

window.addEventListener('hashchange', route);
route();
