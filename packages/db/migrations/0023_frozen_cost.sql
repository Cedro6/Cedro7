-- What each product cost on the day the order was confirmed, so margin on past sales does not
-- move when a cost is edited later. Null on a quote, which has no cost of sale yet.
alter table sales_order_lines add column unit_cost numeric(19, 4) check (unit_cost >= 0);

-- Orders confirmed before this existed take the cost as it stands today, the best figure there is.
update sales_order_lines l
   set unit_cost = p.cost
  from products p, sales_orders o
 where p.org_id = l.org_id and p.id = l.product_id
   and o.org_id = l.org_id and o.id = l.order_id and o.confirmed_at is not null;
