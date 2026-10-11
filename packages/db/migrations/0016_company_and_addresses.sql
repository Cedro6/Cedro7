-- What a company prints on its invoices, and where its customers are billed and shipped.
alter table organizations
  add column address text,
  add column phone text,
  add column email text,
  add column tax_number text,
  add column invoice_footer text,
  -- A small image kept as a data URL. Kept small so it never slows a page down.
  add column logo text check (logo is null or length(logo) <= 300000);

alter table customers
  add column billing_address text,
  add column shipping_address text;
