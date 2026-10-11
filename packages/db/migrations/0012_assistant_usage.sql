-- What the assistant has cost each company, per month, so use can be capped and shown.
create table assistant_usage (
  org_id uuid not null references organizations (id),
  month date not null,
  questions integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (org_id, month)
);
alter table assistant_usage enable row level security;
create policy tenant_isolation on assistant_usage using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on assistant_usage to bos_app;
