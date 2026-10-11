-- The assistant's briefing for one person on one day. Written on request and kept for the day,
-- so opening Home does not ask the model again.
create table assistant_briefings (
  org_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  day date not null,
  body text not null,
  written_at timestamptz not null default now(),
  primary key (org_id, user_id, day)
);
alter table assistant_briefings enable row level security;
create policy tenant_isolation on assistant_briefings using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on assistant_briefings to bos_app;
