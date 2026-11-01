/**
 * Lógica de encuestas sobre Firestore.
 *
 * Modelo de datos:
 *
 *   polls/{pollId}
 *     question: string
 *     options:  [{ id: "o1", text: "..." }, ...]
 *     counts:   { o1: 3, o2: 5 }     <- mapa anidado, se lee junto con la encuesta
 *     totalVotes: number
 *     status: "open" | "closed"
 *     adminTokenHash: string         <- nunca sale del servidor
 *     createdAt: Timestamp
 *
 *   polls/{pollId}/votes/{voterId}   <- subcolección: un documento por votante
 *     optionId: string
 *     votedAt: Timestamp
 *
 * Los contadores se desnormalizan en el documento de la encuesta: mostrar los
 * resultados cuesta una sola lectura, sin recorrer los votos.
 */
const crypto = require('node:crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const MAX_QUESTION = 200;
const MAX_OPTION = 80;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const LIST_LIMIT = 20;
const POLL_ID = /^[A-Za-z0-9]{1,40}$/;
const VOTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function tokensMatch(token, expectedHash) {
  const actual = Buffer.from(hashToken(String(token)), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Convierte un documento en la forma pública: sin el hash del token de administración. */
function toPublicPoll(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    question: data.question,
    options: data.options.map((option) => ({ ...option, votes: data.counts[option.id] ?? 0 })),
    totalVotes: data.totalVotes,
    status: data.status,
    createdAt: data.createdAt.toDate().toISOString(),
  };
}

function validateNewPoll(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION) {
    throw new HttpError(400, `La pregunta es obligatoria (máximo ${MAX_QUESTION} caracteres).`);
  }

  if (!Array.isArray(body.options) || body.options.some((option) => typeof option !== 'string')) {
    throw new HttpError(400, 'Las opciones deben ser una lista de textos.');
  }
  const options = body.options.map((option) => option.trim()).filter(Boolean);
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new HttpError(400, `Una encuesta necesita entre ${MIN_OPTIONS} y ${MAX_OPTIONS} opciones.`);
  }
  if (options.some((option) => option.length > MAX_OPTION)) {
    throw new HttpError(400, `Cada opción admite como máximo ${MAX_OPTION} caracteres.`);
  }
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
    throw new HttpError(400, 'Las opciones no pueden repetirse.');
  }
  return { question, options };
}

function createPollService(db) {
  const pollsRef = db.collection('polls');

  function pollRef(pollId) {
    if (!POLL_ID.test(pollId)) throw new HttpError(404, 'Encuesta no encontrada.');
    return pollsRef.doc(pollId);
  }

  async function requireAdmin(ref, adminToken) {
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new HttpError(404, 'Encuesta no encontrada.');
    if (!adminToken || !tokensMatch(adminToken, snapshot.data().adminTokenHash)) {
      throw new HttpError(403, 'Token de administración incorrecto.');
    }
  }

  return {
    async create(body) {
      const { question, options } = validateNewPoll(body);
      const adminToken = crypto.randomBytes(24).toString('base64url');
      const withIds = options.map((text, index) => ({ id: `o${index + 1}`, text }));
      const ref = pollsRef.doc();

      await ref.create({
        question,
        options: withIds,
        counts: Object.fromEntries(withIds.map((option) => [option.id, 0])),
        totalVotes: 0,
        status: 'open',
        adminTokenHash: hashToken(adminToken),
        createdAt: Timestamp.now(),
      });

      const poll = toPublicPoll(await ref.get());
      return { poll, adminToken };
    },

    async list() {
      const snapshot = await pollsRef.orderBy('createdAt', 'desc').limit(LIST_LIMIT).get();
      return snapshot.docs.map(toPublicPoll);
    },

    async get(pollId) {
      const snapshot = await pollRef(pollId).get();
      if (!snapshot.exists) throw new HttpError(404, 'Encuesta no encontrada.');
      return toPublicPoll(snapshot);
    },

    /**
     * Registra un voto con un batch atómico: crear el documento del votante y sumar
     * al contador ocurren juntos o no ocurren. create() falla si el votante ya
     * existe, así que un voto repetido no infla el contador ni con peticiones
     * simultáneas. Es un batch y no una transacción porque increment() no necesita
     * leer el valor anterior: sin lecturas no hay bloqueos, y 10 votos a la vez
     * bajan de ~11 s a una fracción de segundo.
     *
     * La comprobación de estado queda fuera del batch: un voto que coincida con el
     * cierre de la encuesta aún puede contar, lo cual es aceptable aquí.
     */
    async vote(pollId, body) {
      const { optionId, voterId } = body ?? {};
      if (typeof voterId !== 'string' || !VOTER_ID.test(voterId)) {
        throw new HttpError(400, 'Identificador de votante inválido.');
      }

      const ref = pollRef(pollId);
      const poll = await ref.get();
      if (!poll.exists) throw new HttpError(404, 'Encuesta no encontrada.');

      const data = poll.data();
      if (data.status !== 'open') throw new HttpError(409, 'La encuesta está cerrada.');
      if (!data.options.some((option) => option.id === optionId)) {
        throw new HttpError(400, 'Esa opción no pertenece a la encuesta.');
      }

      const batch = db.batch();
      batch.create(ref.collection('votes').doc(voterId.toLowerCase()), {
        optionId,
        votedAt: FieldValue.serverTimestamp(),
      });
      batch.update(ref, {
        [`counts.${optionId}`]: FieldValue.increment(1),
        totalVotes: FieldValue.increment(1),
      });

      try {
        await batch.commit();
      } catch (error) {
        if (error.code === GRPC_ALREADY_EXISTS) throw new HttpError(409, 'Ya votaste en esta encuesta.');
        if (error.code === GRPC_NOT_FOUND) throw new HttpError(404, 'Encuesta no encontrada.');
        throw error;
      }

      return toPublicPoll(await ref.get());
    },

    async close(pollId, adminToken) {
      const ref = pollRef(pollId);
      await requireAdmin(ref, adminToken);
      await ref.update({ status: 'closed' });
      return toPublicPoll(await ref.get());
    },

    /** Borra la encuesta y su subcolección: en Firestore borrar un documento no borra sus hijos. */
    async remove(pollId, adminToken) {
      const ref = pollRef(pollId);
      await requireAdmin(ref, adminToken);
      await db.recursiveDelete(ref);
    },

    pollRef,
  };
}

module.exports = { createPollService, toPublicPoll, HttpError };
