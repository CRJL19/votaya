# VotaYa: encuestas en vivo sobre Firestore

Crea una encuesta, comparte el enlace y mira los votos llegar en tiempo real. Es una aplicación construida sobre una base de datos NoSQL de documentos, **Google Cloud Firestore**, y desplegada de forma automática en la nube.

Proyecto de la **Actividad Grupal 01-U2: NoSQL App Development**, Base de Datos II, Universidad Privada de Tacna.

| Integrante |
|---|
| Carlos Jimenez Laura |
| Arturo Cutipa Flores |

| Recurso | Enlace |
|---|---|
| Aplicación | <https://votaya-firestore.onrender.com> |
| Repositorio | <https://github.com/CRJL19/votaya> |
| Video | <https://youtu.be/isFjASR8LGw> |
| Artículo Carlos | <https://dev.to/crjl11/modelar-para-nosql-como-construimos-encuestas-en-vivo-con-firestore-y-por-que-una-transaccion-nos-5gef> |
| Artículo Arturo | `[PENDIENTE]` |

## Stack

| Capa | Tecnología |
|---|---|
| Base de datos | Google Cloud Firestore (plan gratuito Spark) |
| Backend | Node.js 24, Express, Firebase Admin SDK |
| Tiempo real | Listeners de Firestore + Server-Sent Events |
| Frontend | HTML, CSS y JavaScript sin frameworks |
| Pruebas | `node:test` contra el emulador oficial de Firestore |
| CI/CD | GitHub Actions |
| Hosting | Render (contenedor Docker), definido en `render.yaml` |

## Arquitectura

```
                 push a main
 Desarrollador ─────────────► GitHub Actions
                              pruebas ► imagen Docker ► Deploy Hook
                                                            │
                                                            ▼
 Navegador ── HTTPS / SSE ──────────────────────────► Render (Express)
                                                            │ Admin SDK
                                                            ▼
                                                       Firestore
```

El navegador nunca habla directamente con Firestore: todo pasa por la API, y las reglas de `firestore.rules` deniegan cualquier acceso directo.

## Modelo de datos

```
polls/{pollId}
  question: "¿Qué base NoSQL usarías?"
  options:  [{ id: "o1", text: "Firestore" }, { id: "o2", text: "Cassandra" }]
  counts:   { o1: 3, o2: 5 }
  totalVotes: 8
  status: "open"
  adminTokenHash: "..."
  createdAt: Timestamp

polls/{pollId}/votes/{voterId}
  optionId: "o1"
  votedAt: Timestamp
```

Tres decisiones propias de una base NoSQL:

- **Desnormalizar los contadores.** Los resultados viven dentro del documento de la encuesta, así que mostrarlos cuesta una sola lectura. En SQL harías un `GROUP BY`; aquí el trabajo se paga al escribir.
- **El ID del votante es el ID del documento.** Como `create()` falla si el documento ya existe, la unicidad la garantiza la propia clave, sin consultas previas.
- **Un batch atómico en lugar de una transacción.** `increment()` no necesita leer el valor anterior, así que no hace falta bloquear nada. Con una transacción, 10 votos simultáneos tardaban 11,6 s en el emulador; con el batch, 89 ms.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Vivacidad, sin tocar la base |
| GET | `/api/health/ready` | Comprueba la conexión con Firestore |
| GET | `/api/polls` | Las 20 encuestas más recientes |
| POST | `/api/polls` | Crea `{ question, options[] }` y devuelve `adminToken` |
| GET | `/api/polls/:id` | Detalle y resultados |
| POST | `/api/polls/:id/votes` | Vota `{ optionId, voterId }` |
| GET | `/api/polls/:id/events` | Resultados en vivo (SSE) |
| POST | `/api/polls/:id/close` | Cierra la votación (`X-Admin-Token`) |
| DELETE | `/api/polls/:id` | Borra la encuesta y sus votos (`X-Admin-Token`) |

## Ejecución local

No necesitas cuenta de Google: el emulador oficial reemplaza a Firestore. Requiere Node.js 22 o superior y Java 17 o superior.

```bash
npm ci
npm run dev
```

La app queda en <http://localhost:3000>.

También puedes usar Docker, sin instalar Java:

```bash
docker compose up --build
```

## Pruebas

```bash
npm test
```

Son 15 pruebas de integración que usan la API real por HTTP contra el emulador, sin simular la base de datos. Incluyen votos simultáneos, voto duplicado en paralelo y resultados en vivo por SSE.

## Despliegue

Cada `push` a `main` ejecuta `.github/workflows/ci-cd.yml`:

1. Pruebas contra el emulador de Firestore.
2. Construcción de la imagen Docker.
3. Si todo pasa, `POST` al Deploy Hook de Render.

El despliegue automático propio de Render está desactivado, de modo que el único camino a producción pasa por las pruebas.

### Configurarlo desde cero

1. **Firebase:** en <https://console.firebase.google.com> crea un proyecto y una base Firestore en **modo de producción**.
2. **Credencial:** en Configuración del proyecto → Cuentas de servicio → **Generar nueva clave privada**. Nunca subas ese JSON al repositorio.
3. **Render:** New → Blueprint → elige este repositorio. Cuando pida `FIREBASE_SERVICE_ACCOUNT`, pega el contenido del JSON.
4. **Deploy Hook:** copia la URL desde Settings → Deploy Hook de Render.
5. **GitHub:** en Settings → Secrets and variables → Actions crea el secret `RENDER_DEPLOY_HOOK` con esa URL.

## Limitaciones conocidas

- **Un voto por navegador, no por persona.** El identificador se guarda en `localStorage`: quien borre sus datos puede volver a votar. Evitarlo exigiría iniciar sesión, algo fuera del alcance de esta demo.
- **Escrituras por documento.** Google recomienda no sostener más de una escritura por segundo sobre un mismo documento. Una encuesta masiva necesitaría contadores distribuidos en varios documentos.
- **Plan gratuito.** Firestore Spark permite 50 000 lecturas y 20 000 escrituras al día. La instancia gratuita de Render se duerme tras un rato sin tráfico y tarda cerca de un minuto en despertar.
- **Moderación.** Cualquiera puede crear encuestas. Hay límite por IP, pero no filtro de contenido.

## Licencia

MIT
