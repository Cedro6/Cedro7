# BusinessOS

Operations software for wholesale distributors: customers, stock, sales orders and purchasing, with an AI assistant.

## Status

Early build. Working and tested:

- Database migrations, tenant isolation by row-level security, append-only audit log.
- Six roles with a permission table that every service function checks.
- App shell in the approved glass style: sign-in, Home, Customers (list, detail, create), Products.
- Stock ledger for one warehouse: on-hand, reserved and available per product, manual adjustments with history, reservations, and a reconciliation check. Only `packages/core/src/inventory/ledger.ts` writes the stock tables.
- A demo company with three people, four customers, seven products and opening stock.

Sign-in is a development sign-in with no password. It is refused in production unless `DEV_SIGN_IN=1` is set, and must be replaced by a real identity provider before any real data is entered.

On Home, the sales chart and briefing show sample figures and are labelled "Sample data" on screen. Sales, Purchasing, Calendar and Reports are placeholder pages.

Not built yet: real authentication, invitations, purchasing, sales orders, imports, reports, background jobs, error monitoring, the AI assistant, billing.

## Layout

- `apps/web` — Next.js app.
- `packages/core` — business logic: permissions, customers, products. No HTTP, no React.
- `packages/db` — SQL migrations, tenant context helper, seed.

## Running locally

Needs Node 22, pnpm and PostgreSQL 16 with two roles: an owner (`bos_owner`) and the app role (`bos_app`, no table ownership, no BYPASSRLS). Copy `.env.example` to `.env` to change the connection strings.

```
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then open http://localhost:3000 and choose a demo person.

## Checks

```
pnpm lint
pnpm typecheck
pnpm test      # runs against a real Postgres database (bos_test), which it wipes first
```
