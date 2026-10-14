-- Changing a quote, or an order that has not shipped, rewrites its lines, so the app role needs to
-- be able to remove the old ones. Everything else about sales orders is unchanged.
grant delete on sales_order_lines to bos_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on sales_order_lines from %I', r);
    end if;
  end loop;
end $$;
