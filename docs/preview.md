# Preview deployment

A password-protected copy of the app with demo data, for review. It is not the production setup: sign-in is the development sign-in behind one shared password.

## Pieces

- **Database:** Supabase project `businessos-preview` (US East). The app connects as the restricted `bos_app` role through the transaction pooler. Supabase's auto-generated data API has no access to the schema: the `anon` and `authenticated` roles hold no privileges on it.
- **Web host:** Vercel, building `apps/web` from the `main` branch.

## Settings on the web host

| Name | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://bos_app.<project-ref>:<password>@<pooler-host>:6543/postgres?uselibpqcompat=true&sslmode=require` |
| `SESSION_SECRET` | At least 32 random characters |
| `DEV_SIGN_IN` | `1` |
| `PREVIEW_PASSWORD` | The shared password given to reviewers |

Sign-in stays off unless the last three are all set. The connection is encrypted; `uselibpqcompat=true&sslmode=require` skips certificate-authority verification, which is acceptable for demo data and should be replaced with the provider's CA certificate before real data is stored.

## Database changes

The hosted database is not reachable from the build environment, so each file in `packages/db/migrations` is applied through the Supabase tools and recorded in `schema_migrations` by hand. Demo data was copied from a local database built with `pnpm db:seed` and `pnpm db:demo-orders`, and checked table by table against the original.
