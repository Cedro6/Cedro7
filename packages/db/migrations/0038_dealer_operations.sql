-- Dealer Terminal: what happens around a sale. Title follow-up, the IRS cash report, who sold it,
-- what each car really cost, and the paperwork and photos kept with deals and cars.

-- After delivery: the temporary tag, the title application at the tag office, and the plate.
alter table deals add column if not exists temp_tag_number text;
alter table deals add column if not exists temp_tag_issued_on date;
alter table deals add column if not exists temp_tag_expires_on date;
alter table deals add column if not exists title_sent_on date;
alter table deals add column if not exists plate_number text;
alter table deals add column if not exists title_done_on date;

-- IRS Form 8300 (cash over $10,000). The dealer files it; the deal records when. The buyer's
-- taxpayer number is never stored: it is written on the printed form by hand.
alter table deals add column if not exists buyer_occupation text;
alter table deals add column if not exists form_8300_filed_on date;

-- Who sold it, and what they are paid for it.
alter table deals add column if not exists salesperson_id uuid references users (id);
alter table deals add column if not exists commission numeric(10, 2) check (commission is null or commission >= 0);

-- Money spent on a car after buying it: reconditioning, parts, transport, auction fees.
create table if not exists vehicle_costs (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  vehicle_id uuid not null,
  kind text not null check (kind in ('recon', 'parts', 'labour', 'detail', 'transport', 'auction_fee', 'inspection', 'other')),
  description text,
  amount numeric(12, 2) not null check (amount > 0),
  spent_on date not null,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, vehicle_id) references vehicles (org_id, id)
);
create index if not exists vehicle_costs_vehicle_idx on vehicle_costs (org_id, vehicle_id);
alter table vehicle_costs enable row level security;
drop policy if exists tenant_isolation on vehicle_costs;
create policy tenant_isolation on vehicle_costs using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, delete on vehicle_costs to bos_app;

-- Files kept with a deal (signed forms, the buyer's licence, the title) or a car (photos).
-- Stored in the database so nothing depends on another service; images are shrunk before upload.
create table if not exists dealer_files (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  deal_id uuid,
  vehicle_id uuid,
  kind text not null check (kind in ('signed_form', 'licence', 'title', 'receipt', 'photo', 'other')),
  name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 4500000),
  data bytea not null,
  -- Photos are listed in this order; the first is the cover.
  position integer not null default 0,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  check ((deal_id is null) <> (vehicle_id is null)),
  foreign key (org_id, deal_id) references deals (org_id, id),
  foreign key (org_id, vehicle_id) references vehicles (org_id, id)
);
create index if not exists dealer_files_deal_idx on dealer_files (org_id, deal_id) where deal_id is not null;
create index if not exists dealer_files_vehicle_idx on dealer_files (org_id, vehicle_id, position) where vehicle_id is not null;
alter table dealer_files enable row level security;
drop policy if exists tenant_isolation on dealer_files;
create policy tenant_isolation on dealer_files using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on dealer_files to bos_app;

-- Listing sites fetch car photos without signing in. This returns only a photo of a car that is
-- on the lot, found by its unguessable id, and nothing else. It runs as its owner so it can look
-- across companies for that one row.
create or replace function public_vehicle_photo(photo uuid)
returns table (content_type text, data bytea)
language sql stable security definer set search_path = public as $$
  select f.content_type, f.data
    from dealer_files f join vehicles v on v.org_id = f.org_id and v.id = f.vehicle_id
   where f.id = photo and f.kind = 'photo' and v.status = 'on_lot'
$$;
revoke all on function public_vehicle_photo(uuid) from public;
grant execute on function public_vehicle_photo(uuid) to bos_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on vehicle_costs from %I', r);
      execute format('revoke all on dealer_files from %I', r);
      execute format('revoke all on function public_vehicle_photo(uuid) from %I', r);
    end if;
  end loop;
end $$;
