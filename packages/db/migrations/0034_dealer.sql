-- Dealer Terminal: vehicles are single units, each with its own VIN, cost and history.

-- What a VIN decoder said, kept once for everyone: a VIN describes the same car whoever asks.
create table vin_decodes (
  vin char(17) primary key,
  provider text not null,
  fields jsonb not null,
  raw jsonb not null,
  fetched_at timestamptz not null default now()
);
-- Public data, so every company may read and add to it; row security is on for the audit's sake.
alter table vin_decodes enable row level security;
create policy shared on vin_decodes using (true) with check (true);
grant select, insert, update on vin_decodes to bos_app;

create table vehicles (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  stock_number text not null,
  vin char(17),
  year integer,
  make text,
  model text,
  trim text,
  body_style text,
  engine text,
  displacement_l numeric(4, 1),
  cylinders integer,
  horsepower integer,
  transmission text,
  drivetrain text,
  fuel_type text,
  category text,
  manufacturer text,
  doors integer,
  cab text,
  bed_length text,
  made_in text,
  -- Everything else the decoder knew, by its own field names.
  specs jsonb not null default '{}'::jsonb,
  -- Where each field came from: 'decoder' or 'manual'.
  provenance jsonb not null default '{}'::jsonb,
  colour text,
  mileage integer check (mileage is null or mileage >= 0),
  condition text,
  acquisition_price numeric(12, 2) check (acquisition_price is null or acquisition_price >= 0),
  acquisition_source text,
  acquired_on date,
  asking_price numeric(12, 2) check (asking_price is null or asking_price >= 0),
  location_id uuid,
  status text not null default 'draft' check (status in ('draft', 'recon', 'on_lot', 'sold', 'removed')),
  description text,
  notes text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sold_at timestamptz,
  primary key (org_id, id),
  unique (org_id, stock_number),
  foreign key (org_id, location_id) references locations (org_id, id)
);
-- One live record per VIN: a car that was sold can come back later as a new record.
create unique index vehicles_live_vin_idx on vehicles (org_id, vin) where vin is not null and status not in ('sold', 'removed');
create index vehicles_status_idx on vehicles (org_id, status, created_at desc);
alter table vehicles enable row level security;
create policy tenant_isolation on vehicles using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on vehicles to bos_app;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on vin_decodes from %I', r);
      execute format('revoke all on vehicles from %I', r);
    end if;
  end loop;
end $$;

-- How stock numbers are made: a counter with a prefix, or the last six of the VIN.
alter table organizations add column if not exists stock_number_style text not null default 'counter' check (stock_number_style in ('counter', 'vin6'));
alter table organizations add column if not exists stock_number_prefix text not null default 'STK';
