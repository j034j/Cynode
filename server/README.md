# Backend

## Dev

### SQLite (default)

1. Install deps: `npm install`
2. Create `.env` (see `.env.example`)
3. Run migrations: `npm run db:migrate`
4. Run dev server: `npm run dev`

### PostgreSQL (optional)

1. Start Postgres: `docker compose up -d`
2. Set `DATABASE_URL` in `.env` to the Postgres URL
3. Run migrations: `npm run db:migrate:postgres`

### MySQL (optional)

1. Set `DATABASE_URL` in `.env` to the MySQL URL
2. Run migrations: `npm run db:migrate:mysql`

Open: `http://127.0.0.1:3000`
API docs (OpenAPI UI): `http://127.0.0.1:3000/docs`

If `DATABASE_URL` is not set, the API falls back to an in-memory store.
