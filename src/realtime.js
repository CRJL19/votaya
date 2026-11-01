/**
 * Resultados en vivo: un listener de Firestore por encuesta, repartido a todos
 * los navegadores conectados por Server-Sent Events.
 *
 * Compartir el listener importa porque Firestore cobra cada documento entregado
 * a cada listener: con uno por navegador, 50 personas mirando la misma encuesta
 * gastarían 50 lecturas por voto en lugar de una.
 */
const { toPublicPoll } = require('./polls');

const HEARTBEAT_MS = 25_000;

function createRealtimeHub(polls, { maxClients = 200 } = {}) {
  const channels = new Map();
  let clientCount = 0;

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function closeChannel(pollId) {
    const channel = channels.get(pollId);
    if (!channel) return;
    channels.delete(pollId);
    channel.unsubscribe();
    for (const res of channel.clients) res.end();
  }

  function openChannel(pollId) {
    const channel = { clients: new Set(), last: null, unsubscribe: () => {} };
    channels.set(pollId, channel);

    channel.unsubscribe = polls.pollRef(pollId).onSnapshot(
      (snapshot) => {
        if (!snapshot.exists) {
          for (const res of channel.clients) send(res, 'deleted', {});
          closeChannel(pollId);
          return;
        }
        channel.last = toPublicPoll(snapshot);
        for (const res of channel.clients) send(res, 'poll', channel.last);
      },
      (error) => {
        // Al cerrar la respuesta, EventSource se reconecta solo y se abre un canal nuevo.
        console.error(`[realtime] Listener de ${pollId} interrumpido: ${error.message}`);
        closeChannel(pollId);
      }
    );
    return channel;
  }

  return {
    subscribe(pollId, req, res) {
      if (clientCount >= maxClients) {
        res.status(503).json({ error: 'Demasiadas conexiones en vivo. Intenta en un momento.' });
        return;
      }

      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      const channel = channels.get(pollId) ?? openChannel(pollId);
      channel.clients.add(res);
      clientCount += 1;
      if (channel.last) send(res, 'poll', channel.last);

      const heartbeat = setInterval(() => res.write(': latido\n\n'), HEARTBEAT_MS);

      req.on('close', () => {
        clearInterval(heartbeat);
        clientCount -= 1;
        channel.clients.delete(res);
        if (channel.clients.size === 0 && channels.get(pollId) === channel) closeChannel(pollId);
      });
    },

    closeAll() {
      for (const pollId of [...channels.keys()]) closeChannel(pollId);
    },

    stats: () => ({ channels: channels.size, clients: clientCount }),
  };
}

module.exports = { createRealtimeHub };
