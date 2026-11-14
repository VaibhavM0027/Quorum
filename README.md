# Quorum — AI-powered Group Discussion platform

Quorum lets a host run an online group discussion (GD): create the discussion,
invite participants with a unique link and access code, run a live audio/video
room, transcribe each speaker automatically, have an AI assistant score and
moderate the discussion, and download individual and whole-room PDF evaluation
reports.

---

## 1. Features

| Area | What it does |
| --- | --- |
| Accounts | Email + password sign-up and sign-in. Host and Participant roles. Signed, httpOnly session cookies (JWT, HS256). |
| Hosting a GD | Create a discussion (title, topic, context, rules, duration, mode), get a human-friendly join code and an invite link. Start, end, cancel or reopen the room. |
| Joining | Participants join with a code or invite link, give transcription consent, and are admitted until the room is full. |
| Live media | Real audio/video via LiveKit (SFU). Hosts can lock a participant's mic or remove them mid-session. |
| Transcription | A server-side LiveKit agent joins every live room and transcribes each participant's microphone track independently, so every speaker's words are captured under their own name — not only the one whose laptop started the discussion. |
| AI assistant | A live relevance score per contribution, plus AI-generated silence prompts, quiet-participant nudges and off-topic reminders. Every assistant message is stored and auditable — nothing is faked. |
| Evaluation | Host-triggered evaluation scores six weighted rubric dimensions per participant, grounded in the transcript. The overall score is always computed server-side. |
| Reports | In-app report page plus downloadable PDFs: an individual report per participant and one whole-room (overall) report. |

---

## 2. Architecture

```
Browser (desktop & mobile)
 ├─ Next.js App Router UI (React 19, Tailwind)
 └─ LiveKit client  ──►  LiveKit SFU  (publishes its own microphone)

Transcription agent (separate Node process — `npm run agent`)
 └─ LiveKit Agents worker  ──►  subscribes to every participant's microphone
     └─ one transcriber per track  ──►  Gemini speech-to-text  ──►  Prisma

Next.js server (Node runtime)
 ├─ REST route handlers  (auth, discussions, transcript, AI, reports)
 ├─ Prisma  ──►  PostgreSQL
 ├─ Gemini client  (relevance scoring, moderation, evaluation)
 └─ PDFKit  (report rendering)
```

Key design decisions:

- **Speaker attribution is exact** because every microphone is transcribed from
  its own LiveKit track, so a stored segment is always attached to the
  participant the audio came from — there is no server-side diarisation to get
  wrong, and no shared stream to attribute by guesswork.
- **Scores are reproducible.** Statistics (speaking time, contributions, words,
  relevance verdicts) come from stored data; the AI only supplies rubric scores
  and rationale, and the weighted overall score is calculated on the server.
- **Quiet participants are reported as "not assessed"** rather than being given
  an invented score.
- **One read model for reports.** The HTML page and the PDF endpoints both read
  through `src/lib/reports.ts`, so a downloaded PDF can never disagree with the
  page. Visibility is applied once, at the source.

---

## 3. Technology stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript (strict)
- **Styling:** Tailwind CSS
- **Database:** PostgreSQL via Prisma ORM
- **Auth:** `jose` (HS256 JWT sessions) + `bcryptjs` password hashing
- **Real-time media:** LiveKit (`livekit-server-sdk` server-side, `livekit-client` in the browser)
- **AI:** Google Gemini (server-side only, key never reaches the browser)
- **Transcription:** LiveKit Agents worker (server-side) + Gemini speech-to-text
- **Reports:** PDFKit, Recharts (charts on the report page)
- **Tests:** Vitest

---

## 4. Requirements

- **Node.js 22+** (the Docker image uses Node 22)
- **PostgreSQL 14+**
- **A LiveKit server** — either the local dev server (`livekit-server --dev`)
  or LiveKit Cloud
- **A Gemini API key** (optional for AI features, but required for transcription —
  speech-to-text runs on the server)
- Any modern browser: the transcript is produced server-side, so it does not
  depend on a browser speech recogniser

---

## 5. Local setup

### 5.1 Install dependencies

```powershell
npm install
```

`npm install` also runs `prisma generate`.

### 5.2 Configure environment

```powershell
Copy-Item .env.example .env
```

Then edit `.env`. The essentials:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `JWT_SECRET` | Session signing secret. **At least 32 characters.** |
| `APP_URL` | Public URL of the app, used to build invite links. |
| `LIVEKIT_HOST` / `LIVEKIT_URL` | LiveKit server addresses (see 5.4). |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit credentials. |
| `GEMINI_API_KEY` / `GEMINI_FLASH_API_KEY` | Gemini API key(s). Leave blank to run without AI. |

No credential is ever hardcoded; everything is read through `src/lib/env.ts`,
which validates the environment at startup and fails loudly if something
required is missing.

### 5.3 Create the database schema

```powershell
npm run db:push      # applies prisma/schema.prisma to the database
```

### 5.4 Start LiveKit (local)

Two options:

- **Local dev server** — install `livekit-server` and run:

  ```powershell
  livekit-server --dev
  ```

  Dev mode listens on `http://127.0.0.1:7880` with API key `devkey` and secret
  `secret`. Copy those into `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
- **LiveKit Cloud** — set `LIVEKIT_HOST=https://<project>.livekit.cloud` and
  `LIVEKIT_URL=wss://<project>.livekit.cloud` with your project's key/secret.

### 5.5 Seed demo accounts (optional)

Set `SEED_PASSWORD` in `.env` (at least 8 characters), then:

```powershell
npm run seed
```

This creates `host@quorum.local` (HOST) and `participant@quorum.local`
(PARTICIPANT). Alternatively, the app's own first-run flow creates these
accounts, or you can just register normally.

### 5.6 Run

```powershell
npm run dev      # http://localhost:4000
```

Transcription is a separate process. Start the agent in a second terminal — a
room is perfectly audible without it, but no transcript is produced:

```powershell
npm run agent    # joins every live discussion room and transcribes each microphone
```

The agent reads `LIVEKIT_URL` (derived from `LIVEKIT_HOST` when blank),
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GEMINI_API_KEY` and `DATABASE_URL` from
the same `.env`, so it needs no configuration of its own. Set `TRANSCRIPT_DEBUG=1`
to trace participant connection, subscribed tracks, audio frames, every
speech-to-text call and every stored segment.

Production build:

```powershell
npm run build
npm run start    # the agent is not part of this process — see §9
```

Check `GET /api/health` to see whether the database, LiveKit and AI are
configured.

---

## 6. Using Quorum

1. **Host:** sign in, create a discussion, and share the invite link or join code.
2. **Participants:** open the link (or `/join`), enter the code, grant
   microphone/camera and transcription consent.
3. **Host:** start the discussion. Talk normally; the AI assistant observes.
4. **Evaluation:** the host runs the evaluation from the report page (or it can
   run once the discussion is live/finished).
5. **Reports:** open `/reports/<discussionId>` and download the overall PDF or a
   per-participant PDF.

---

## 7. Testing

```powershell
npm test           # run the suite once
npm run test:watch # watch mode
npm run typecheck  # TypeScript, no emit
```

The Vitest suite covers the building blocks that carry the most risk and run
without a database: rubric weighting and banding, transcript normalisation, the
rate limiter, request validation, session-token signing/verification, the report
read model, and PDF rendering for both report kinds.

---

## 8. Security

Implemented:

- **Sessions:** HS256 JWTs in httpOnly, SameSite=Lax cookies (Secure in
  production via `COOKIE_SECURE=1`). Verified in `middleware.ts` (Edge) and in
  every route.
- **Passwords:** bcrypt (cost 10). Login compares against a dummy hash for
  unknown emails to avoid user enumeration by timing.
- **Authorization:** every route re-checks access server-side. Report visibility
  is resolved once in the shared report model, so a participant can never read
  or download another participant's report.
- **Rate limiting:** login, registration, first-run provisioning, join-code
  lookups, evaluation and the AI tick are all throttled per client.
- **Input validation:** every request body is parsed with Zod schemas; JSON
  bodies are size-limited (64 KB) before buffering.
- **AI keys** are server-side only and never prefixed `NEXT_PUBLIC_`.
- **HTTP headers** (`next.config.mjs`): a Content-Security-Policy locked to the
  app origin and the configured LiveKit origin, plus `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (camera/mic
  only), `Cross-Origin-Opener-Policy`, and HSTS in production.

Operational notes:

- The rate limiter is **in-memory and per-process**. Running more than one Node
  instance (horizontal scaling) needs a shared store such as Redis, or the limit
  applies per instance. A single instance comfortably handles several concurrent
  rooms.
- Set `TRUST_PROXY=on` (and forward `X-Forwarded-For`) when running behind a
  trusted reverse proxy, so rate limiting keys on the real client address.

---

## 9. Deployment

### 9.1 Docker Compose (Postgres + LiveKit + app)

A self-contained stack is provided in `docker-compose.yml`:

```powershell
$env:JWT_SECRET="a-long-random-secret-at-least-32-characters"
$env:GEMINI_API_KEY="your-key"   # needed for AI features and for transcription
docker compose up --build
```

Then open http://localhost:4000. The `app` container applies the schema on boot
(`prisma db push`) and serves on port 4000; the `agent` container runs the
transcription worker against the same Postgres and the same LiveKit server;
Postgres and LiveKit run alongside them.

> The Compose file and Dockerfile are provided for convenience and have not been
> executed in the authoring environment — review the environment values before
> using them in production.

### 9.2 Manual / platform deployment

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Set `JWT_SECRET`, `APP_URL` (the public HTTPS URL), `COOKIE_SECURE=1`,
   `TRUST_PROXY=on`.
3. Set the LiveKit variables. For LiveKit Cloud, set `LIVEKIT_URL` to the `wss://`
   URL so the CSP in `next.config.mjs` allows it.
4. `npm ci && npx prisma db push && npm run build && npm run start`.
5. Deploy the transcription agent as its **own long-lived process** on the same
   image: `npm run agent`, with the same `DATABASE_URL`, `LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `GEMINI_API_KEY`. It must not be
   run inside the web process — an agent holds a room connection for the whole
   discussion, and it would also be scaled or restarted with the web tier. On
   Render, `render.yaml` already declares it as the `quorum-transcriber` worker.

Notes:

- The app is a long-running Node server (`next start`), not static output: the
  PDF, AI and Prisma work all require the Node runtime.
- On serverless platforms, Prisma needs a pooled connection; append
  `?connection_limit=5&pool_timeout=20` (or use the provider's pooler URL) to
  `DATABASE_URL`.
- Terminate TLS at your proxy/load balancer and let HSTS handle upgrades.

---

## 10. External services, cost and free alternatives

| Service | Purpose | Pricing consideration | Free alternative |
| --- | --- | --- | --- |
| **Google Gemini** | Relevance scoring, live moderation, rubric evaluation | Free tier is rate-limited; paid tier bills per token. Keep `GEMINI_CONCURRENCY` low on free keys. `AI_MAX_CALLS_PER_ROOM` caps spend per room. | Self-host an open model (e.g. via Ollama) and adapt `src/lib/gemini.ts`. Without a key, AI features are disabled and the UI says so. |
| **LiveKit** | Real-time audio/video | LiveKit Cloud is usage-based (participant-minutes). | The self-hosted `livekit-server` is free; use `--dev` locally or deploy the OSS server in production. |
| **Gemini speech-to-text** | Transcribing every participant's microphone | The worker sends one clip per finished utterance, so cost tracks how much is said rather than how many people are in the room. | The provider is isolated in `src/lib/stt.ts`, so another recogniser can be dropped in — there is no browser-side fallback. |

Gemini is only ever called server-side. If no key is configured, the app does not
pretend AI is working: `/api/health` reports it as unconfigured, and AI-dependent
actions return a clear message instead of a fake result.

---

## 11. Known limitations

- **Transcription needs the agent running.** It is a separate process (§5.6, §9);
  without it the room still works but nothing is transcribed. Recognition quality
  depends on the model, so heavy crosstalk or very quiet speech can come out
  imperfectly.
- **The agent joins rooms on demand.** The worker must be registered with the
  LiveKit server to be dispatched, and it only transcribes discussions that are
  live and have transcription enabled.
- **Rate limiting** is per-process (see §8).
- **No migrations directory** — the schema is applied with `prisma db push`. For
  a production deployment with change history, switch to `prisma migrate`.
- **LiveKit-scoped media only:** sessions depend on a reachable LiveKit server;
  without it, audio/video cannot start (the rest of the app still works).

---

## 12. Project structure

```
src/
  app/
    api/            REST route handlers (auth, discussions, transcript, ai, reports, health)
    dashboard/      Host dashboard
    join/           Join-by-code page
    room/[id]/      Live room
    reports/[id]/   Report page (HTML) + PDF downloads
  components/       Reusable UI (room, dashboard, join, charts, controls)
  agent/            LiveKit transcription worker: worker, participant-session, utterance
  hooks/            useLivekitRoom, usePresenceReporter, useRoomRecorder, useAssistantVoice
  lib/              env, auth, prisma, gemini, ai-assistant, evaluation, rubric,
                    reports, pdf, livekit, transcript, rate-limit, validation, http
prisma/             schema.prisma, seed.ts
tests/              Vitest suite
```

---

## 13. Phase status

- **Phase 9 — Reports & PDF generation:** complete. Report read model, HTML
  report page with charts, individual and overall PDF rendering and download
  endpoints, evaluation trigger.
- **Phase 10 — Testing, security, optimisation & deployment:** complete. Vitest
  suite, HTTP security headers, body-size limits, extra rate limits, Next.js
  build optimisations, README, Dockerfile and Docker Compose.
