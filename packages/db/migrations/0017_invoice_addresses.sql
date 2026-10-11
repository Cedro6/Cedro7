-- An invoice keeps the addresses it was issued with. Changing a customer's address later
-- does not rewrite invoices already sent.
alter table invoices
  add column bill_to_address text,
  add column ship_to_address text;

-- Invoices issued before this are given the customer's addresses as they stand today.
update invoices i
   set bill_to_address = c.billing_address, ship_to_address = c.shipping_address
  from customers c
 where c.org_id = i.org_id and c.id = i.customer_id;

-- Filled in when the invoice is created, whichever part of the app creates it.
create function invoice_freeze_addresses() returns trigger language plpgsql as $$
begin
  select c.billing_address, c.shipping_address into new.bill_to_address, new.ship_to_address
    from customers c where c.org_id = new.org_id and c.id = new.customer_id;
  return new;
end $$;
create trigger invoice_freeze_addresses before insert on invoices
  for each row execute function invoice_freeze_addresses();
revoke all on function invoice_freeze_addresses() from public;
grant execute on function invoice_freeze_addresses() to bos_app;
