-- Invoices, payments and credit notes.
-- An invoice is raised for each shipment (or completed order), as a deposit before
-- anything ships, or by hand without an order. Money on these documents is kept to the cent.
-- Posted documents are corrected by a later document (a payment, a credit), never edited.

create table invoices (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  number text not null,
  kind text not null check (kind in ('shipment', 'deposit', 'manual')),
  customer_id uuid not null,
  order_id uuid,
  shipment_id uuid,
  deposit_percent numeric(5, 2) check (deposit_percent > 0 and deposit_percent < 100),
  tax_rate numeric(7, 6) not null default 0 check (tax_rate >= 0 and tax_rate < 1),
  subtotal numeric(19, 2) not null check (subtotal >= 0),
  tax numeric(19, 2) not null check (tax >= 0),
  -- gross is subtotal plus tax; deposit_applied is the part already billed on a deposit invoice
  gross numeric(19, 2) not null check (gross >= 0),
  deposit_applied numeric(19, 2) not null default 0 check (deposit_applied >= 0),
  amount numeric(19, 2) not null check (amount >= 0),
  payment_terms text,
  notes text,
  issued_at timestamptz not null default now(),
  due_at timestamptz not null,
  voided_at timestamptz,
  void_reason text,
  created_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, number),
  unique (org_id, shipment_id),
  foreign key (org_id, customer_id) references customers (org_id, id),
  foreign key (org_id, order_id) references sales_orders (org_id, id),
  foreign key (org_id, shipment_id) references shipments (org_id, id),
  constraint amount_adds_up check (amount = gross - deposit_applied),
  constraint kind_matches_links check (
    (kind = 'shipment' and order_id is not null and shipment_id is not null)
    or (kind = 'deposit' and order_id is not null and shipment_id is null and deposit_percent is not null)
    or (kind = 'manual' and order_id is null and shipment_id is null)
  )
);
create index invoices_customer_idx on invoices (org_id, customer_id, issued_at desc);
create index invoices_order_idx on invoices (org_id, order_id);

create table invoice_lines (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  invoice_id uuid not null,
  position integer not null,
  product_id uuid,
  description text not null check (length(trim(description)) > 0),
  qty numeric(18, 4) not null check (qty > 0),
  unit_price numeric(19, 4) not null check (unit_price >= 0),
  list_price numeric(19, 4) not null check (list_price >= 0),
  discount_pct numeric(5, 2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  amount numeric(19, 2) not null check (amount >= 0),
  primary key (org_id, id),
  unique (org_id, invoice_id, position),
  foreign key (org_id, invoice_id) references invoices (org_id, id),
  foreign key (org_id, product_id) references products (org_id, id)
);

create table payments (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  invoice_id uuid not null,
  amount numeric(19, 2) not null check (amount > 0),
  method text not null,
  reference text,
  idempotency_key text not null,
  paid_at timestamptz not null default now(),
  recorded_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, idempotency_key),
  foreign key (org_id, invoice_id) references invoices (org_id, id)
);
create index payments_invoice_idx on payments (org_id, invoice_id);

create table credit_notes (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  number text not null,
  customer_id uuid not null,
  amount numeric(19, 2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now(),
  created_by uuid references users (id),
  primary key (org_id, id),
  unique (org_id, number),
  foreign key (org_id, customer_id) references customers (org_id, id)
);

-- Where a credit note was used. What is left of a credit note stays on the customer's account.
create table credit_applications (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  credit_note_id uuid not null,
  invoice_id uuid not null,
  amount numeric(19, 2) not null check (amount > 0),
  applied_at timestamptz not null default now(),
  applied_by uuid references users (id),
  primary key (org_id, id),
  foreign key (org_id, credit_note_id) references credit_notes (org_id, id),
  foreign key (org_id, invoice_id) references invoices (org_id, id)
);
create index credit_applications_invoice_idx on credit_applications (org_id, invoice_id);
create index credit_applications_note_idx on credit_applications (org_id, credit_note_id);

do $$
declare t text;
begin
  foreach t in array array['invoices', 'invoice_lines', 'payments', 'credit_notes', 'credit_applications'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())', t);
  end loop;
end $$;

-- An invoice can only be updated to void it; lines, payments and credits are never edited.
grant select, insert, update on invoices to bos_app;
grant select, insert on invoice_lines, payments, credit_notes, credit_applications to bos_app;
