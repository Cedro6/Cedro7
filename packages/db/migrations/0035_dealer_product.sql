-- Dealer Terminal is a product of its own, recorded as the business type 'dealer'.
alter table organizations drop constraint if exists organizations_business_type_check;
alter table organizations add constraint organizations_business_type_check
  check (business_type in ('distributor', 'retail', 'warehouse', 'sales', 'contractor', 'dealer'));
