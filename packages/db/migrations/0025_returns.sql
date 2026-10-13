-- Goods a customer sends back from an order that was shipped.
create table returns (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  number text not null,
  order_id uuid not null,
  reason text not null,
  -- Whether the goods went back on the shelf. Damaged goods are taken back without restocking.
  restocked boolean not null,
  credit_note_id uuid,
  idempotency_key text not null,
  returned_at timestamptz not null default now(),
  created_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, number),
  unique (org_id, idempotency_key),
  foreign key (org_id, order_id) references sales_orders (org_id, id),
  foreign key (org_id, credit_note_id) references credit_notes (org_id, id)
);
create table return_lines (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  return_id uuid not null,
  order_line_id uuid not null,
  qty numeric(18, 4) not null check (qty > 0),
  primary key (org_id, id),
  foreign key (org_id, return_id) references returns (org_id, id),
  foreign key (org_id, order_line_id) references sales_order_lines (org_id, id)
);
create index returns_order_idx on returns (org_id, order_id);
create index return_lines_line_idx on return_lines (org_id, order_line_id);

do $$
declare t text; r text;
begin
  foreach t in array array['returns', 'return_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())', t);
    -- A return is a record of what happened: it is added, never changed or removed.
    execute format('grant select, insert on %I to bos_app', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
