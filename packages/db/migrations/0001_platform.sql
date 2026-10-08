-- Platform foundation: tenants, people, memberships, audit log.
-- Runs as the owner role. The web app connects as bos_app, which owns nothing
-- and cannot bypass row-level security.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bos_app') then
    create role bos_app nologin nobypassrls;
  end if;
end $$;

grant usage on schema public to bos_app;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  base_currency char(3) not null default 'USD',
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  auth_user_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memberships (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references users (id),
  role text not null check (role in ('owner', 'admin', 'sales', 'purchasing', 'warehouse', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, user_id)
);

create table audit_log (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  actor_type text not null check (actor_type in ('user', 'ai', 'system', 'api')),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  created_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index audit_log_entity_idx on audit_log (org_id, entity_type, entity_id, created_at desc);

-- Tenant context: the service layer sets app.org_id for the current transaction.
create function current_org_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

alter table organizations enable row level security;
create policy tenant_isolation on organizations
  using (id = current_org_id()) with check (id = current_org_id());

alter table memberships enable row level security;
create policy tenant_isolation on memberships
  using (org_id = current_org_id()) with check (org_id = current_org_id());

alter table audit_log enable row level security;
create policy tenant_isolation on audit_log
  using (org_id = current_org_id()) with check (org_id = current_org_id());

-- People are shared across companies; a company sees only its own members.
alter table users enable row level security;
create policy visible_to_own_org on users for select
  using (exists (
    select 1 from memberships m
    where m.user_id = users.id and m.org_id = current_org_id()
  ));

grant select, insert, update on organizations, memberships to bos_app;
grant select on users to bos_app;
-- The audit log is append-only for the application.
grant select, insert on audit_log to bos_app;
