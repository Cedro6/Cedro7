-- Pins where this trigger function looks up tables, like every other function in the database.
alter function invoice_freeze_addresses() set search_path = public;
