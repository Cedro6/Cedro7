-- The app role calls current_org_id() inside every row-level security policy.
-- Grant it by name, so the database still works where the default
-- "everyone may run functions" grant has been removed (as on the hosted preview).
grant execute on function current_org_id() to bos_app;
alter function current_org_id() set search_path = public;
