-- Dealer Terminal: deals. A deal sells one vehicle to one buyer. Florida cash sales to begin with.

-- Dealer settings: the licence number goes on the forms, the county sets the surtax, the fees are defaults.
alter table organizations add column if not exists dealer_licence text;
alter table organizations add column if not exists dealer_county text;
alter table organizations add column if not exists county_surtax_pct numeric(5, 3) not null default 0 check (county_surtax_pct >= 0 and county_surtax_pct < 10);
alter table organizations add column if not exists dealer_fee_default numeric(10, 2) not null default 0 check (dealer_fee_default >= 0);
alter table organizations add column if not exists tag_title_default numeric(10, 2) not null default 0 check (tag_title_default >= 0);

create table deals (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  number text not null,
  vehicle_id uuid not null,
  customer_id uuid,
  status text not null default 'open' check (status in ('open', 'delivered', 'cancelled')),
  -- The buyer as they must appear on the paperwork. Kept on the deal so the forms match what was signed.
  buyer_name text not null,
  buyer_address text,
  buyer_city text,
  buyer_state text,
  buyer_zip text,
  buyer_phone text,
  buyer_email text,
  buyer_dl text,
  buyer_dob date,
  co_buyer_name text,
  -- Money. Tax is worked out from these and kept, so the paperwork does not change if a rate changes later.
  sale_price numeric(12, 2) not null default 0 check (sale_price >= 0),
  dealer_fee numeric(10, 2) not null default 0 check (dealer_fee >= 0),
  trade_allowance numeric(12, 2) not null default 0 check (trade_allowance >= 0),
  trade_vin char(17),
  trade_description text,
  trade_mileage integer,
  state_tax_pct numeric(5, 3) not null default 6,
  surtax_pct numeric(5, 3) not null default 0,
  surtax_cap numeric(10, 2) not null default 5000,
  tag_title_fees numeric(10, 2) not null default 0 check (tag_title_fees >= 0),
  other_fees numeric(10, 2) not null default 0 check (other_fees >= 0),
  other_fees_note text,
  -- The car at the time of sale.
  odometer integer,
  odometer_brand text not null default 'actual' check (odometer_brand in ('actual', 'not_actual', 'exceeds')),
  sold_as_is boolean not null default true,
  warranty_note text,
  notes text,
  delivered_on date,
  cancelled_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, number),
  foreign key (org_id, vehicle_id) references vehicles (org_id, id),
  foreign key (org_id, customer_id) references customers (org_id, id)
);
-- A vehicle has at most one open deal.
create unique index deals_open_vehicle_idx on deals (org_id, vehicle_id) where status = 'open';
create index deals_status_idx on deals (org_id, status, created_at desc);
alter table deals enable row level security;
create policy tenant_isolation on deals using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on deals to bos_app;

-- Money received on a deal: the deposit, then the balance. Recorded by a person, never by Ava.
create table deal_payments (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  deal_id uuid not null,
  amount numeric(12, 2) not null check (amount > 0),
  method text not null,
  reference text,
  paid_on date not null,
  recorded_by uuid references users (id),
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, deal_id) references deals (org_id, id)
);
create index deal_payments_deal_idx on deal_payments (org_id, deal_id);
alter table deal_payments enable row level security;
create policy tenant_isolation on deal_payments using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert on deal_payments to bos_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on deals from %I', r);
      execute format('revoke all on deal_payments from %I', r);
    end if;
  end loop;
end $$;
