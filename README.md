# BusinessOS

Operations software for wholesale distributors: customers, stock, sales orders and purchasing, with an AI assistant.

## Status

Stage 0 (foundations) only. There is no sign-in and no business feature yet.

Working and tested:

- Database migrations that apply to an empty PostgreSQL 16 database.
- Tenant isolation by row-level security, with a restricted app role.
- An append-only audit log.
- A repeatable demo-company seed.
- A status page in the approved visual style.

Not built yet: authentication, roles and permissions, every business module, background jobs, error monitoring, the AI assistant, billing.

## Layout

- `apps/web` — Next.js app.
- `packages/db` — SQL migrations, tenant context helper, seed.

## Running locally

Needs Node 22, pnpm and PostgreSQL 16 with two roles: an owner (`bos_owner`) and the app role (`bos_app`, no table ownership, no BYPASSRLS). Copy `.env.example` to `.env` to change the connection strings.

```
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Checks

```
pnpm lint
pnpm typecheck
pnpm test      # runs against a real Postgres database (bos_test), which it wipes first
```
