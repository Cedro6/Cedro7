-- Two-step verification: a six-digit code from an authenticator app, asked for after the password.
-- Like passwords, the secrets live in a table the app's own database role cannot read or write;
-- every use goes through one of the narrow functions below.
create table user_totp (
  user_id uuid primary key references users (id),
  -- The shared secret, base32. Not yet in force until confirmed_at is set.
  secret text not null,
  confirmed_at timestamptz,
  -- The last 30-second step a code was accepted for, so a code cannot be used twice.
  last_step bigint not null default 0,
  -- Hashes of the one-time recovery codes that are still unused.
  recovery_hashes text[] not null default '{}',
  created_at timestamptz not null default now()
);
revoke all on user_totp from public;
alter table user_totp enable row level security;

-- Starts (or restarts) setup with a fresh secret. Refused once two-step is on: it must be turned off first.
create function auth_totp_begin(p_user_id uuid, p_secret text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from user_totp where user_id = p_user_id and confirmed_at is not null) then return false; end if;
  insert into user_totp (user_id, secret) values (p_user_id, p_secret)
  on conflict (user_id) do update set secret = excluded.secret, last_step = 0, recovery_hashes = '{}', created_at = now();
  return true;
end $$;

-- What is needed to check a code for one person.
create function auth_totp_secret(p_user_id uuid) returns table (secret text, confirmed boolean, last_step bigint)
language sql stable security definer set search_path = public as $$
  select secret, confirmed_at is not null, last_step from user_totp where user_id = p_user_id
$$;

-- Turns two-step on after the first correct code, and stores the recovery codes' hashes.
create function auth_totp_confirm(p_user_id uuid, p_step bigint, p_recovery_hashes text[]) returns boolean
language sql security definer set search_path = public as $$
  update user_totp set confirmed_at = now(), last_step = p_step, recovery_hashes = p_recovery_hashes
   where user_id = p_user_id and confirmed_at is null
  returning true
$$;

-- Records that the code for a step was used. False when that step, or a later one, was used already.
create function auth_totp_use_step(p_user_id uuid, p_step bigint) returns boolean
language sql security definer set search_path = public as $$
  update user_totp set last_step = p_step
   where user_id = p_user_id and confirmed_at is not null and last_step < p_step
  returning true
$$;

-- Uses up one recovery code. False when it is not one of this person's unused codes.
create function auth_totp_use_recovery(p_user_id uuid, p_hash text) returns boolean
language sql security definer set search_path = public as $$
  update user_totp set recovery_hashes = array_remove(recovery_hashes, p_hash)
   where user_id = p_user_id and confirmed_at is not null and p_hash = any (recovery_hashes)
  returning true
$$;

create function auth_totp_disable(p_user_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from user_totp where user_id = p_user_id
$$;

-- Which of a set of people have two-step on, and how many recovery codes each has left.
create function auth_totp_enabled(p_user_ids uuid[]) returns table (user_id uuid, recovery_left integer)
language sql stable security definer set search_path = public as $$
  select user_id, coalesce(array_length(recovery_hashes, 1), 0) from user_totp where user_id = any (p_user_ids) and confirmed_at is not null
$$;

-- Whether the account is locked after too many wrong passwords or codes.
create function auth_is_locked(p_user_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select locked_until > now() from user_credentials where user_id = p_user_id), false)
$$;

do $$
declare f text; r text;
begin
  foreach f in array array[
    'auth_totp_begin(uuid, text)', 'auth_totp_secret(uuid)', 'auth_totp_confirm(uuid, bigint, text[])', 'auth_totp_use_step(uuid, bigint)',
    'auth_totp_use_recovery(uuid, text)', 'auth_totp_disable(uuid)', 'auth_totp_enabled(uuid[])', 'auth_is_locked(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to bos_app', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on user_totp from %I', r);
    end if;
  end loop;
end $$;
