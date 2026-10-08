-- Master data: customers, contacts, products. One product is one SKU.
-- Also the sign-in lookup, which must work before a company context exists.

create table customers (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  owner_user_id uuid references users (id),
  payment_terms text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index customers_name_idx on customers (org_id, lower(name));

create table contacts (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  customer_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  title text,
  email text,
  phone text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, customer_id) references customers (org_id, id)
);
create index contacts_customer_idx on contacts (org_id, customer_id);

create table products (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  sku text not null check (length(trim(sku)) > 0),
  name text not null check (length(trim(name)) > 0),
  category text,
  barcode text,
  cost numeric(19, 4) not null default 0 check (cost >= 0),
  price numeric(19, 4) not null default 0 check (price >= 0),
  shelf_location text,
  reorder_point numeric(18, 4) check (reorder_point >= 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, sku)
);

alter table customers enable row level security;
create policy tenant_isolation on customers
  using (org_id = current_org_id()) with check (org_id = current_org_id());

alter table contacts enable row level security;
create policy tenant_isolation on contacts
  using (org_id = current_org_id()) with check (org_id = current_org_id());

alter table products enable row level security;
create policy tenant_isolation on products
  using (org_id = current_org_id()) with check (org_id = current_org_id());

grant select, insert, update on customers, contacts, products to bos_app;

-- Sign-in happens before a company is chosen, so it cannot go through row-level
-- security. This function is the only way the app role can look a person up by
-- email, and it returns nothing but their own active memberships.
create function auth_memberships_by_email(p_email text)
returns table (user_id uuid, user_name text, org_id uuid, org_name text, role text)
language sql stable security definer set search_path = public
as $$
  select u.id, u.name, o.id, o.name, m.role
  from users u
  join memberships m on m.user_id = u.id and m.status = 'active'
  join organizations o on o.id = m.org_id
  where u.email = lower(trim(p_email))
  order by o.name
$$;
revoke all on function auth_memberships_by_email(text) from public;
grant execute on function auth_memberships_by_email(text) to bos_app;
