-- Stock ledger. stock_movements is the append-only record of every change;
-- stock_levels is the running balance, changed only in the same transaction as
-- a movement or a reservation. Both can always be recomputed from the ledger.

create table locations (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'warehouse' check (kind in ('warehouse', 'store', 'virtual')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table stock_levels (
  org_id uuid not null,
  product_id uuid not null,
  location_id uuid not null,
  on_hand numeric(18, 4) not null default 0 check (on_hand >= 0),
  reserved numeric(18, 4) not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, product_id, location_id),
  foreign key (org_id, product_id) references products (org_id, id),
  foreign key (org_id, location_id) references locations (org_id, id),
  constraint reserved_within_on_hand check (reserved <= on_hand)
);

create table stock_movements (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  product_id uuid not null,
  location_id uuid not null,
  qty_delta numeric(18, 4) not null check (qty_delta <> 0),
  unit_cost numeric(19, 4),
  kind text not null check (kind in (
    'opening_balance', 'adjustment', 'receipt', 'shipment', 'return_in', 'return_out', 'transfer_in', 'transfer_out'
  )),
  reason text,
  source_type text,
  source_id uuid,
  idempotency_key text not null,
  posted_at timestamptz not null default now(),
  posted_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, idempotency_key),
  foreign key (org_id, product_id) references products (org_id, id),
  foreign key (org_id, location_id) references locations (org_id, id)
);
create index stock_movements_product_idx on stock_movements (org_id, product_id, posted_at desc);

create table stock_reservations (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  product_id uuid not null,
  location_id uuid not null,
  qty numeric(18, 4) not null check (qty > 0),
  status text not null default 'open' check (status in ('open', 'consumed', 'released')),
  source_type text not null,
  source_id uuid not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, idempotency_key),
  foreign key (org_id, product_id) references products (org_id, id),
  foreign key (org_id, location_id) references locations (org_id, id)
);
create index stock_reservations_open_idx on stock_reservations (org_id, product_id) where status = 'open';

alter table locations enable row level security;
create policy tenant_isolation on locations
  using (org_id = current_org_id()) with check (org_id = current_org_id());
alter table stock_levels enable row level security;
create policy tenant_isolation on stock_levels
  using (org_id = current_org_id()) with check (org_id = current_org_id());
alter table stock_movements enable row level security;
create policy tenant_isolation on stock_movements
  using (org_id = current_org_id()) with check (org_id = current_org_id());
alter table stock_reservations enable row level security;
create policy tenant_isolation on stock_reservations
  using (org_id = current_org_id()) with check (org_id = current_org_id());

grant select, insert, update on locations, stock_levels, stock_reservations to bos_app;
-- The ledger is append-only for the application: corrections are new entries.
grant select, insert on stock_movements to bos_app;
