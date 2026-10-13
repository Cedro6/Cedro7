-- Money paid back to a customer out of the credit on their account.
create table credit_refunds (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  credit_note_id uuid not null,
  amount numeric(19, 2) not null check (amount > 0),
  method text not null,
  reference text,
  -- One request, however many credit notes it draws on, shares this key, so a repeat does nothing.
  request_key text not null,
  paid_at timestamptz not null default now(),
  paid_by uuid references users (id),
  primary key (org_id, id),
  foreign key (org_id, credit_note_id) references credit_notes (org_id, id)
);
create index credit_refunds_note_idx on credit_refunds (org_id, credit_note_id);
create index credit_refunds_request_idx on credit_refunds (org_id, request_key);

-- Payments made against a bill. A bill can be paid in parts; it counts as paid when they add up to its amount.
create table expense_payments (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  expense_id uuid not null,
  amount numeric(14, 2) not null check (amount > 0),
  paid_on date not null,
  method text,
  recorded_by uuid references users (id),
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, expense_id) references expenses (org_id, id)
);
create index expense_payments_expense_idx on expense_payments (org_id, expense_id);

-- Bills already marked as paid become one payment for the full amount.
insert into expense_payments (org_id, expense_id, amount, paid_on, method, recorded_by)
select org_id, id, amount, paid_on, paid_method, created_by from expenses where paid_on is not null;

do $$
declare t text; r text;
begin
  foreach t in array array['credit_refunds', 'expense_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())', t);
    -- Records of money moving: added, never changed or removed.
    execute format('grant select, insert on %I to bos_app', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
