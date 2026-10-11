-- Reminders: something to do on a day, optionally about a customer and assigned to a person.
create table reminders (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  due_on date not null,
  customer_id uuid,
  assigned_to uuid references users (id),
  created_by uuid references users (id),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, customer_id) references customers (org_id, id)
);
create index reminders_due_idx on reminders (org_id, due_on);
alter table reminders enable row level security;
create policy tenant_isolation on reminders using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on reminders to bos_app;
