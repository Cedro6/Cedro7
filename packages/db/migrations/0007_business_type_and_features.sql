-- Each company has a business type and a set of feature switches. The type is only a
-- starting set; the switches are what the app checks. A switch that is absent counts as on,
-- so companies created before this migration keep everything they had.

alter table organizations
  add column business_type text not null default 'distributor'
    check (business_type in ('distributor', 'retail', 'warehouse', 'sales', 'contractor')),
  add column features jsonb not null default '{}'::jsonb
    check (jsonb_typeof(features) = 'object');
