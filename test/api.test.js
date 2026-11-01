/**
 * Pruebas de integración contra el emulador de Firestore (npm test).
 * Ejercitan la API real por HTTP, sin simular la base de datos.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFirestore } = require('../src/firestore');
const { createApp } = require('../src/app');

let db, server, hub, base;

async function request(path, { method = 'GET', body, adminToken } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: typeof body === 'string' ? body : body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const newPoll = (options = ['Rojo', 'Azul']) =>
  request('/api/polls', { method: 'POST', body: { question: '¿Color favorito?', options } });

const vote = (id, optionId, voterId = crypto.randomUUID()) =>
  request(`/api/polls/${id}/votes`, { method: 'POST', body: { optionId, voterId } });

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Las pruebas deben correr contra el emulador');
  db = createFirestore();
  ({ app: server, hub } = createApp(db, { limits: { create: 10_000, vote: 10_000 } }));
  server = await new Promise((resolve) => {
    const listening = server.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  hub.closeAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.terminate();
});

test('health responde sin tocar la base y ready comprueba Firestore', async () => {
  assert.equal((await request('/api/health')).status, 200);
  const ready = await request('/api/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.database, 'up');
});

test('crear encuesta devuelve token de administración y nunca expone su hash', async () => {
  const { status, data } = await newPoll();
  assert.equal(status, 201);
  assert.ok(data.adminToken);
  assert.equal(data.poll.status, 'open');
  assert.deepEqual(data.poll.options.map((o) => o.votes), [0, 0]);

  const fetched = await request(`/api/polls/${data.poll.id}`);
  assert.equal(fetched.data.adminTokenHash, undefined);
  assert.equal(fetched.data.counts, undefined);
});

test('rechaza encuestas inválidas', async () => {
  const cases = [
    { question: '', options: ['a', 'b'] },
    { question: 'x', options: ['solo una'] },
    { question: 'x', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    { question: 'x', options: ['Igual', 'igual'] },
    { question: 'x', options: 'no es lista' },
    { question: 'x', options: [1, 2] },
    { question: 'y'.repeat(201), options: ['a', 'b'] },
  ];
  for (const body of cases) {
    assert.equal((await request('/api/polls', { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await request('/api/polls', { method: 'POST', body: '{roto' })).status, 400);
});

test('lista las encuestas más recientes primero', async () => {
  const first = await newPoll();
  const second = await newPoll();
  const { data } = await request('/api/polls');
  const ids = data.map((poll) => poll.id);
  assert.ok(ids.indexOf(second.data.poll.id) < ids.indexOf(first.data.poll.id));
});

test('un voto incrementa el contador correcto', async () => {
  const { data } = await newPoll();
  const res = await vote(data.poll.id, 'o2');
  assert.equal(res.status, 201);
  assert.equal(res.data.totalVotes, 1);
  assert.deepEqual(res.data.options.map((o) => o.votes), [0, 1]);
});

test('el mismo votante no puede votar dos veces', async () => {
  const { data } = await newPoll();
  const voterId = crypto.randomUUID();
  assert.equal((await vote(data.poll.id, 'o1', voterId)).status, 201);
  assert.equal((await vote(data.poll.id, 'o2', voterId)).status, 409);
  assert.equal((await vote(data.poll.id, 'o1', voterId.toUpperCase())).status, 409);

  const { data: poll } = await request(`/api/polls/${data.poll.id}`);
  assert.equal(poll.totalVotes, 1);
});

test('rechaza opciones ajenas, votantes inválidos y encuestas inexistentes', async () => {
  const { data } = await newPoll();
  assert.equal((await vote(data.poll.id, 'o99')).status, 400);
  assert.equal((await vote(data.poll.id, '__proto__')).status, 400);
  assert.equal((await vote(data.poll.id, 'o1', 'no-es-uuid')).status, 400);
  assert.equal((await vote('noExiste', 'o1')).status, 404);
  assert.equal((await request('/api/polls/con%2Fbarra')).status, 404);
});

test('votos simultáneos: no se pierde ninguno y el total coincide con la subcolección', async () => {
  const { data } = await newPoll();
  const id = data.poll.id;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => vote(id, i % 2 ? 'o1' : 'o2'))
  );
  assert.deepEqual(results.map((r) => r.status), Array(10).fill(201));

  const { data: poll } = await request(`/api/polls/${id}`);
  assert.equal(poll.totalVotes, 10);
  assert.deepEqual(poll.options.map((o) => o.votes), [5, 5]);

  const stored = await db.collection('polls').doc(id).collection('votes').count().get();
  assert.equal(stored.data().count, 10);
});

test('el mismo votante en paralelo solo cuenta una vez', async () => {
  const { data } = await newPoll();
  const voterId = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => vote(data.poll.id, 'o1', voterId))
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);

  const { data: poll } = await request(`/api/polls/${data.poll.id}`);
  assert.equal(poll.totalVotes, 1);
});

test('cerrar exige token y bloquea nuevos votos', async () => {
  const { data } = await newPoll();
  const path = `/api/polls/${data.poll.id}/close`;
  assert.equal((await request(path, { method: 'POST' })).status, 403);
  assert.equal((await request(path, { method: 'POST', adminToken: 'incorrecto' })).status, 403);

  const closed = await request(path, { method: 'POST', adminToken: data.adminToken });
  assert.equal(closed.data.status, 'closed');
  assert.equal((await vote(data.poll.id, 'o1')).status, 409);
});

test('eliminar exige token y borra también la subcolección de votos', async () => {
  const { data } = await newPoll();
  const id = data.poll.id;
  await vote(id, 'o1');

  assert.equal((await request(`/api/polls/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await request(`/api/polls/${id}`, { method: 'DELETE', adminToken: data.adminToken })).status, 204);
  assert.equal((await request(`/api/polls/${id}`)).status, 404);

  const stored = await db.collection('polls').doc(id).collection('votes').count().get();
  assert.equal(stored.data().count, 0);
});

test('los resultados en vivo llegan por SSE al votar y comparten un solo listener', async () => {
  const { data } = await newPoll();
  const id = data.poll.id;
  const controller = new AbortController();
  const res = await fetch(`${base}/api/polls/${id}/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const second = await fetch(`${base}/api/polls/${id}/events`, { signal: controller.signal });
  assert.equal(hub.stats().channels, 1);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const waitFor = async (predicate) => {
    while (!predicate(buffer)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('El stream se cerró antes de tiempo');
      buffer += decoder.decode(value);
    }
  };

  await waitFor((text) => text.includes('"totalVotes":0'));
  await vote(id, 'o1');
  await waitFor((text) => text.includes('"totalVotes":1'));

  controller.abort();
  await second.body?.cancel().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hub.stats().channels, 0);
});

test('SSE de una encuesta inexistente responde 404', async () => {
  assert.equal((await fetch(`${base}/api/polls/noExiste/events`)).status, 404);
});

test('el límite por IP responde 429', async () => {
  const limited = createApp(db, { limits: { create: 1, vote: 10 } });
  const listening = await new Promise((resolve) => {
    const s = limited.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${listening.address().port}/api/polls`;
  const send = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'x', options: ['a', 'b'] }),
  });
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 429);
  await new Promise((resolve) => listening.close(resolve));
});

test('sirve el frontend con cabeceras de seguridad', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /VotaYa/);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-powered-by'), null);
});
