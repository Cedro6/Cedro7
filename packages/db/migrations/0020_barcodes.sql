-- A barcode identifies one product within a company, so a scan has exactly one answer.
create unique index products_barcode_idx on products (org_id, barcode) where barcode is not null;
