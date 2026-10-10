-- Price lists and line discounts.
-- A customer can be on one price list: a percentage off every product, with optional
-- special prices for particular products. Each order line keeps the price it started
-- from and the discount applied, so a document can show how the price was reached.

create table price_lists (
  org_id uuid not null references organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  percent_off numeric(5, 2) not null default 0 check (percent_off >= 0 and percent_off < 100),
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, name)
);

create table price_list_prices (
  org_id uuid not null,
  price_list_id uuid not null,
  product_id uuid not null,
  price numeric(19, 4) not null check (price >= 0),
  primary key (org_id, price_list_id, product_id),
  foreign key (org_id, price_list_id) references price_lists (org_id, id) on delete cascade,
  foreign key (org_id, product_id) references products (org_id, id)
);

alter table customers
  add column price_list_id uuid,
  add constraint customers_price_list_fk foreign key (org_id, price_list_id) references price_lists (org_id, id);

alter table sales_order_lines
  add column list_price numeric(19, 4) check (list_price >= 0),
  add column discount_pct numeric(5, 2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100);
update sales_order_lines set list_price = unit_price where list_price is null;
alter table sales_order_lines alter column list_price set not null;

do $$
declare t text;
begin
  foreach t in array array['price_lists', 'price_list_prices'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on price_lists, price_list_prices to bos_app;
