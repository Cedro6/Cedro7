-- Sales orders. A quote is a sales order in its first status. Confirming reserves
-- stock; shipping consumes the reservation and posts the ledger entry.

create table document_counters (
  org_id uuid not null references organizations (id),
  doc_type text not null,
  last_number integer not null default 0,
  primary key (org_id, doc_type)
);

create table sales_orders (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  number text not null,
  customer_id uuid not null,
  status text not null default 'quote'
    check (status in ('quote', 'confirmed', 'partially_shipped', 'shipped', 'cancelled')),
  tax_rate numeric(7, 6) not null default 0 check (tax_rate >= 0 and tax_rate < 1),
  notes text,
  owner_user_id uuid references users (id),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  primary key (org_id, id),
  unique (org_id, number),
  foreign key (org_id, customer_id) references customers (org_id, id)
);
create index sales_orders_customer_idx on sales_orders (org_id, customer_id, created_at desc);

create table sales_order_lines (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  position integer not null,
  product_id uuid not null,
  qty numeric(18, 4) not null check (qty > 0),
  unit_price numeric(19, 4) not null check (unit_price >= 0),
  qty_reserved numeric(18, 4) not null default 0 check (qty_reserved >= 0),
  qty_shipped numeric(18, 4) not null default 0 check (qty_shipped >= 0),
  primary key (org_id, id),
  unique (org_id, order_id, position),
  foreign key (org_id, order_id) references sales_orders (org_id, id),
  foreign key (org_id, product_id) references products (org_id, id),
  constraint not_over_fulfilled check (qty_reserved + qty_shipped <= qty)
);

create table shipments (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  number text not null,
  order_id uuid not null,
  idempotency_key text not null,
  shipped_at timestamptz not null default now(),
  shipped_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, number),
  unique (org_id, idempotency_key),
  foreign key (org_id, order_id) references sales_orders (org_id, id)
);

create table shipment_lines (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  shipment_id uuid not null,
  order_line_id uuid not null,
  qty numeric(18, 4) not null check (qty > 0),
  primary key (org_id, id),
  foreign key (org_id, shipment_id) references shipments (org_id, id),
  foreign key (org_id, order_line_id) references sales_order_lines (org_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['document_counters', 'sales_orders', 'sales_order_lines', 'shipments', 'shipment_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())', t);
  end loop;
end $$;

grant select, insert, update on document_counters, sales_orders, sales_order_lines to bos_app;
-- A shipment is a posted document: it is never edited.
grant select, insert on shipments, shipment_lines to bos_app;
