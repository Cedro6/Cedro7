-- Personal sign-in. Password hashes and one-time links live in tables the app's own database
-- role cannot read or write. Everything goes through the functions below, each of which does
-- one narrow job, so a bug elsewhere in the app cannot list or change credentials.

create table user_credentials (
  user_id uuid primary key references users (id),
  password_hash text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  -- Raised whenever the password changes, which signs the person out everywhere else.
  session_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  org_id uuid not null references organizations (id),
  purpose text not null check (purpose in ('invite', 'reset')),
  -- Only a hash of the link's secret is kept, so reading this table does not let anyone sign in.
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create index auth_tokens_user_idx on auth_tokens (user_id);

revoke all on user_credentials, auth_tokens from public;
-- Row-level security with no policy: closed to everyone but the functions below, which run as the owner.
alter table user_credentials enable row level security;
alter table auth_tokens enable row level security;

-- What sign-in needs to check a password: nothing unless the person has an active membership.
create function auth_credential(p_email text)
returns table (user_id uuid, password_hash text, locked boolean, session_version integer)
language sql stable security definer set search_path = public as $$
  select u.id, c.password_hash, coalesce(c.locked_until > now(), false), c.session_version
    from users u join user_credentials c on c.user_id = u.id
   where u.email = lower(trim(p_email))
     and exists (select 1 from memberships m where m.user_id = u.id and m.status = 'active')
$$;

-- Counts a failed attempt and locks the account for 15 minutes after five in a row; a success clears the count.
create function auth_record_attempt(p_user_id uuid, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  update user_credentials
     set failed_count = case when p_ok then 0 else failed_count + 1 end,
         locked_until = case when p_ok then null when failed_count + 1 >= 5 then now() + interval '15 minutes' else locked_until end
   where user_id = p_user_id
$$;

-- The version a session cookie must carry to still be valid. Zero for someone who has no password yet.
create function auth_session_version(p_user_id uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select session_version from user_credentials where user_id = p_user_id), 0)
$$;

-- Finds or creates the person behind an email address. The caller adds the membership.
create function auth_upsert_user(p_email text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from users where email = lower(trim(p_email));
  if v_id is null then
    insert into users (email, name) values (lower(trim(p_email)), trim(p_name)) returning id into v_id;
  end if;
  return v_id;
end $$;

-- Issues a one-time link for a member of the given company, replacing any earlier unused one.
create function auth_issue_token(p_org_id uuid, p_user_id uuid, p_purpose text, p_token_hash text, p_created_by uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_expires timestamptz := now() + case when p_purpose = 'invite' then interval '7 days' else interval '1 hour' end;
begin
  if not exists (select 1 from memberships where org_id = p_org_id and user_id = p_user_id and status = 'active') then
    raise exception 'not a member';
  end if;
  update auth_tokens set used_at = now() where user_id = p_user_id and used_at is null;
  insert into auth_tokens (user_id, org_id, purpose, token_hash, expires_at, created_by)
  values (p_user_id, p_org_id, p_purpose, p_token_hash, v_expires, p_created_by);
  return v_expires;
end $$;

-- Who a link is for, if it is still good. Used to greet them on the set-password page.
create function auth_token_owner(p_token_hash text)
returns table (user_id uuid, email text, name text, org_name text, purpose text)
language sql stable security definer set search_path = public as $$
  select u.id, u.email, u.name, o.name, t.purpose
    from auth_tokens t join users u on u.id = t.user_id join organizations o on o.id = t.org_id
   where t.token_hash = p_token_hash and t.used_at is null and t.expires_at > now()
$$;

-- Uses a link once to set the password. Returns the person and company to sign in as, or nothing.
create function auth_set_password(p_token_hash text, p_password_hash text)
returns table (user_id uuid, org_id uuid, session_version integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_token auth_tokens;
begin
  update auth_tokens set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   returning * into v_token;
  if v_token.id is null then return; end if;
  insert into user_credentials as c (user_id, password_hash)
  values (v_token.user_id, p_password_hash)
  on conflict (user_id) do update
    set password_hash = excluded.password_hash, session_version = c.session_version + 1,
        failed_count = 0, locked_until = null, updated_at = now();
  return query select v_token.user_id, v_token.org_id, c.session_version from user_credentials c where c.user_id = v_token.user_id;
end $$;

-- Whether each of a set of people has set a password, for the team list.
create function auth_has_password(p_user_ids uuid[]) returns table (user_id uuid)
language sql stable security definer set search_path = public as $$
  select user_id from user_credentials where user_id = any(p_user_ids)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'auth_credential(text)', 'auth_record_attempt(uuid, boolean)', 'auth_session_version(uuid)', 'auth_upsert_user(text, text)',
    'auth_issue_token(uuid, uuid, text, text, uuid)', 'auth_token_owner(text)', 'auth_set_password(text, text)', 'auth_has_password(uuid[])'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to bos_app', f);
  end loop;
end $$;

-- Some hosts (Supabase) add public-facing roles that are granted every new table and function by
-- default. These must never reach credentials, so their access is taken away where they exist.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on user_credentials, auth_tokens from %I', r);
      execute format(
        'revoke all on function auth_credential(text), auth_record_attempt(uuid, boolean), auth_session_version(uuid),
           auth_upsert_user(text, text), auth_issue_token(uuid, uuid, text, text, uuid), auth_token_owner(text),
           auth_set_password(text, text), auth_has_password(uuid[]) from %I', r);
    end if;
  end loop;
end $$;
