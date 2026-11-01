/** Aplicación Express: API REST, resultados en vivo y frontend estático. */
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createPollService, HttpError } = require('./polls');
const { createRealtimeHub } = require('./realtime');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FIFTEEN_MINUTES = 15 * 60 * 1000;

function limiter(max, message) {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
  });
}

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp(db, { limits = { create: 20, vote: 120 } } = {}) {
  const app = express();
  const polls = createPollService(db);
  const hub = createRealtimeHub(polls);

  // Render pone un único proxy delante: sin esto, el límite por IP vería la IP del proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  const createLimit = limiter(limits.create, 'Creaste demasiadas encuestas. Intenta más tarde.');
  const voteLimit = limiter(limits.vote, 'Demasiados votos desde esta conexión. Intenta más tarde.');

  // Vivacidad: no toca la base. Render la consulta cada pocos segundos y, si leyera
  // Firestore, gastaría la cuota gratuita de lecturas solo en comprobaciones.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()), live: hub.stats() });
  });

  // Preparación: comprueba de verdad la conexión con Firestore.
  app.get('/api/health/ready', handle(async (req, res) => {
    await db.collection('polls').limit(1).get();
    res.json({ status: 'ok', database: 'up' });
  }));

  app.get('/api/polls', handle(async (req, res) => {
    res.json(await polls.list());
  }));

  app.post('/api/polls', createLimit, handle(async (req, res) => {
    res.status(201).json(await polls.create(req.body));
  }));

  app.get('/api/polls/:id', handle(async (req, res) => {
    res.json(await polls.get(req.params.id));
  }));

  app.post('/api/polls/:id/votes', voteLimit, handle(async (req, res) => {
    res.status(201).json(await polls.vote(req.params.id, req.body));
  }));

  app.post('/api/polls/:id/close', handle(async (req, res) => {
    res.json(await polls.close(req.params.id, req.get('x-admin-token')));
  }));

  app.delete('/api/polls/:id', handle(async (req, res) => {
    await polls.remove(req.params.id, req.get('x-admin-token'));
    res.status(204).end();
  }));

  app.get('/api/polls/:id/events', handle(async (req, res) => {
    await polls.get(req.params.id); // 404 normal antes de abrir el stream
    hub.subscribe(req.params.id, req, res);
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado.' });
  });

  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Petición demasiado grande.' });

    // 10 = ABORTED: demasiada contención en la transacción. El cliente puede reintentar.
    if (err.code === 10) return res.status(503).json({ error: 'Mucha actividad en esta encuesta. Intenta de nuevo.' });

    console.error('[error]', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });

  return { app, hub };
}

module.exports = { createApp };
