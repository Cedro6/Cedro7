-- Money going out: supplier bills and everyday expenses in one list.
-- A bill is an expense with a supplier and a due date that has not been paid yet.
create table expenses (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  supplier_id uuid,
  purchase_order_id uuid,
  category text not null,
  description text not null,
  -- The supplier's own invoice number, when there is one.
  reference text,
  amount numeric(14, 2) not null check (amount > 0),
  incurred_on date not null,
  due_on date,
  paid_on date,
  paid_method text,
  voided_at timestamptz,
  void_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (paid_on is null or voided_at is null),
  primary key (org_id, id),
  foreign key (org_id, supplier_id) references suppliers (org_id, id),
  foreign key (org_id, purchase_order_id) references purchase_orders (org_id, id)
);
create index expenses_org_date_idx on expenses (org_id, incurred_on desc);
create index expenses_org_unpaid_idx on expenses (org_id, due_on) where paid_on is null and voided_at is null;
alter table expenses enable row level security;
create policy tenant_isolation on expenses using (org_id = current_org_id()) with check (org_id = current_org_id());
-- Nothing is deleted: a mistake is voided, which keeps the record.
grant select, insert, update on expenses to bos_app;

-- Some hosts (Supabase) grant every new table to their public-facing roles. This one is only for the app.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on expenses from %I', r);
    end if;
  end loop;
end $$;
