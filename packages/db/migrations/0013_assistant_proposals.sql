-- A change the assistant has prepared and a person has yet to confirm. Nothing here has happened
-- until status is 'done'. The payload is checked again, with the person's permissions, on confirm.
create table assistant_proposals (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references users (id),
  kind text not null,
  payload jsonb not null,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'dismissed')),
  result_link text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (org_id, id)
);
create index assistant_proposals_user_idx on assistant_proposals (org_id, user_id, created_at desc);
alter table assistant_proposals enable row level security;
create policy tenant_isolation on assistant_proposals using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on assistant_proposals to bos_app;
