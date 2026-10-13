-- Each person arranges their own Home screen. No row means "use the starting layout for this kind of business".
create table home_layouts (
  org_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  widgets text[] not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
alter table home_layouts enable row level security;
create policy tenant_isolation on home_layouts using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on home_layouts to bos_app;
