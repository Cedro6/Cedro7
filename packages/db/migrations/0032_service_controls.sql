-- Whoever runs the service can suspend a company: its people can no longer sign in or use the app,
-- and nothing is deleted, so it can be switched back on.
alter table organizations add column suspended_at timestamptz;
-- A company can insist that everyone with a password also uses two-step verification.
alter table organizations add column require_two_step boolean not null default false;

create function platform_set_suspended(p_org_id uuid, p_suspended boolean) returns boolean
language sql security definer set search_path = public as $$
  update organizations set suspended_at = case when p_suspended then coalesce(suspended_at, now()) end, updated_at = now()
   where id = p_org_id returning true
$$;

-- For an owner who has lost both their phone and their recovery codes, and has nobody above them to ask.
create function platform_reset_two_step(p_email text) returns boolean
language sql security definer set search_path = public as $$
  delete from user_totp where user_id = (select id from users where email = lower(trim(p_email))) returning true
$$;

drop function platform_companies();
create function platform_companies()
returns table (id uuid, name text, business_type text, created_at timestamptz, people integer, orders integer, last_activity timestamptz, suspended_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.business_type, o.created_at,
         (select count(*)::int from memberships m where m.org_id = o.id and m.status = 'active'),
         (select count(*)::int from sales_orders s where s.org_id = o.id),
         (select max(a.created_at) from audit_log a where a.org_id = o.id),
         o.suspended_at
    from organizations o order by o.created_at desc limit 500
$$;

do $$
declare f text; r text;
begin
  foreach f in array array['platform_set_suspended(uuid, boolean)', 'platform_reset_two_step(text)', 'platform_companies()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to bos_app', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;
