-- Lets a signed-in person replace their own password. The app checks the current password first;
-- this only swaps the hash and raises the session version, which signs them out everywhere else.
create function auth_change_password(p_user_id uuid, p_password_hash text) returns integer
language sql security definer set search_path = public as $$
  update user_credentials
     set password_hash = p_password_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = null, updated_at = now()
   where user_id = p_user_id
  returning session_version
$$;
revoke all on function auth_change_password(uuid, text) from public;
grant execute on function auth_change_password(uuid, text) to bos_app;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function auth_change_password(uuid, text) from %I', r);
    end if;
  end loop;
end $$;
