-- Purchasing: suppliers, purchase orders with an approval threshold, and
-- receipts. Receiving posts ledger entries and updates average cost.

alter table organizations
  add column po_approval_threshold numeric(19, 4) not null default 1000 check (po_approval_threshold >= 0);

create table suppliers (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  email text,
  phone text,
  payment_terms text,
  lead_time_days integer check (lead_time_days >= 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table purchase_orders (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  number text not null,
  supplier_id uuid not null,
  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'cancelled'
  )),
  expected_on date,
  notes text,
  created_by uuid references users (id),
  approved_by uuid references users (id),
  approved_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, number),
  foreign key (org_id, supplier_id) references suppliers (org_id, id)
);

create table purchase_order_lines (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  position integer not null,
  product_id uuid not null,
  qty numeric(18, 4) not null check (qty > 0),
  unit_cost numeric(19, 4) not null check (unit_cost >= 0),
  qty_received numeric(18, 4) not null default 0 check (qty_received >= 0),
  primary key (org_id, id),
  unique (org_id, order_id, position),
  foreign key (org_id, order_id) references purchase_orders (org_id, id),
  foreign key (org_id, product_id) references products (org_id, id),
  constraint not_over_received check (qty_received <= qty)
);
create index purchase_order_lines_product_idx on purchase_order_lines (org_id, product_id);

create table receipts (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  number text not null,
  order_id uuid not null,
  idempotency_key text not null,
  received_at timestamptz not null default now(),
  received_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, number),
  unique (org_id, idempotency_key),
  foreign key (org_id, order_id) references purchase_orders (org_id, id)
);

create table receipt_lines (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  receipt_id uuid not null,
  order_line_id uuid not null,
  qty numeric(18, 4) not null check (qty > 0),
  primary key (org_id, id),
  foreign key (org_id, receipt_id) references receipts (org_id, id),
  foreign key (org_id, order_line_id) references purchase_order_lines (org_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['suppliers', 'purchase_orders', 'purchase_order_lines', 'receipts', 'receipt_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())', t);
  end loop;
end $$;

grant select, insert, update on suppliers, purchase_orders, purchase_order_lines to bos_app;
-- A receipt is a posted document: it is never edited.
grant select, insert on receipts, receipt_lines to bos_app;
