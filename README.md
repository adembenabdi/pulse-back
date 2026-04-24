# Pulse Backend (V2)

Production-ready Express + TypeScript backend for Pulse.

## Stack
- Node 20+ / pnpm
- Express 4 + Helmet + CORS
- PostgreSQL via `pg` (Supabase compatible)
- Groq (LLM), node-telegram-bot-api, web-push
- Zod for validation, Pino for logs

## Local dev

```bash
pnpm install
cp .env.example .env  # fill in DATABASE_URL, JWT_SECRET, GROQ_API_KEY…
pnpm migrate          # apply migrations under ./migrations
pnpm dev              # tsx watch src/index.ts → http://localhost:4000
```

Health check: `GET /health`

## Deploy on Render

This repo includes a `render.yaml` blueprint. Connect the repo on Render → New → Blueprint → set the secret env vars (`DATABASE_URL`, `GROQ_API_KEY`, `FRONTEND_URL`, …). `JWT_SECRET` and `JWT_REFRESH_SECRET` will be auto-generated.

Build:    `corepack enable && pnpm install --frozen-lockfile=false && pnpm build`
Start:    `pnpm start`
Healthcheck: `/health`

## Scripts
- `pnpm dev` — watch mode
- `pnpm build` — `tsc -p tsconfig.json` → `dist/`
- `pnpm start` — `node dist/index.js`
- `pnpm migrate` — apply SQL migrations
- `pnpm typecheck`, `pnpm lint`, `pnpm test`
