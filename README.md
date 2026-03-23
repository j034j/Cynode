# Cynode (Web App)

This repo is being converted from a Chrome new-tab extension into a web application with a real backend + database.

## Run Locally

### SQLite (default)

1. Install deps: `npm install`
2. Create `.env` from `.env.example` (default uses SQLite)
3. Run migrations: `npm run db:migrate`
4. Start dev server: `npm run dev`

### PostgreSQL (optional)

1. Start Postgres: `docker compose up -d`
2. Set `DATABASE_URL` in `.env` to the Postgres URL
3. Run migrations: `npm run db:migrate:postgres`

### MySQL (optional)

1. Set `DATABASE_URL` in `.env` to the MySQL URL
2. Run migrations: `npm run db:migrate:mysql`

Open the app at `http://127.0.0.1:3000` and the API docs at `http://127.0.0.1:3000/docs`.

## Architecture (Current Iteration)

- Frontend: static files in `public/`
- Backend: Fastify server in `server/src/`
- API: `/api/v1/*` with OpenAPI at `/docs`
- DB: Prisma (SQLite default; Postgres/MySQL optional) (`server/prisma/schema.prisma`)

The UI persists graph state through the API and keeps a local `graphId` in `localStorage` to reconnect to the same graph on reload.

## Legacy

Old extension artifacts are kept in `legacy-extension/` for reference.
