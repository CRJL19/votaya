/** Punto de entrada: conecta con Firestore, arranca HTTP y cierra de forma ordenada. */
const { createFirestore } = require('./firestore');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;

const db = createFirestore();
const { app, hub } = createApp(db);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[app] Escuchando en http://localhost:${PORT}`);
});

// Render y Docker envían SIGTERM antes de detener el contenedor.
function shutdown(signal) {
  console.log(`[app] ${signal} recibido, cerrando...`);
  setTimeout(() => process.exit(1), 10_000).unref();
  hub.closeAll(); // sin esto, las conexiones SSE abiertas impedirían cerrar el servidor
  server.close(() => db.terminate().finally(() => process.exit(0)));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
