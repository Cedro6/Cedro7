-- Some goods are not taxed (food, books, children's clothes, depending on where the business is).
-- A product says whether it is taxed; an order line keeps the answer from the day it was added,
-- so changing a product later does not rewrite the tax on existing orders.
alter table products add column taxable boolean not null default true;
alter table sales_order_lines add column taxable boolean not null default true;

-- Where the supplier is, for the top of a printed purchase order.
alter table suppliers add column address text;
