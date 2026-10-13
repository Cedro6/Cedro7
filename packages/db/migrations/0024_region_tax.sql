-- The tax rate a company usually charges, used when an order or invoice does not say otherwise.
alter table organizations add column default_tax_percent numeric(6, 3) not null default 0
  check (default_tax_percent >= 0 and default_tax_percent < 100);
-- A customer who is not charged tax (a reseller, a charity, an export customer).
alter table customers add column tax_exempt boolean not null default false;
