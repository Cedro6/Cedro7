-- New companies join by invitation: whoever runs the service makes a one-time sign-up link, and the
-- person who opens it creates their company and their own owner login in one step.
-- The table is closed to the app's database role; the functions below are the only way in.
create table signup_invites (
  id uuid primary key default gen_random_uuid(),
  -- Only a hash of the link's secret is kept.
  token_hash text not null unique,
  -- Who it is for, as a reminder to the person who made it.
  note text not null default '',
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  org_id uuid references organizations (id)
);
revoke all on signup_invites from public;
alter table signup_invites enable row level security;

create function signup_invite_create(p_token_hash text, p_note text, p_created_by uuid) returns timestamptz
language sql security definer set search_path = public as $$
  insert into signup_invites (token_hash, note, created_by, expires_at)
  values (p_token_hash, left(coalesce(p_note, ''), 200), p_created_by, now() + interval '14 days')
  returning expires_at
$$;

-- True while a link is unused and in date.
create function signup_invite_valid(p_token_hash text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from signup_invites where token_hash = p_token_hash and used_at is null and expires_at > now())
$$;

create function signup_invite_revoke(p_id uuid) returns boolean
language sql security definer set search_path = public as $$
  update signup_invites set expires_at = now() where id = p_id and used_at is null and expires_at > now() returning true
$$;

create function signup_invite_list()
returns table (id uuid, note text, created_at timestamptz, expires_at timestamptz, used_at timestamptz, org_name text)
language sql stable security definer set search_path = public as $$
  select i.id, i.note, i.created_at, i.expires_at, i.used_at, o.name
    from signup_invites i left join organizations o on o.id = i.org_id
   order by i.created_at desc limit 200
$$;

-- Every company on the service, for the person who runs it. Names and counts only.
create function platform_companies()
returns table (id uuid, name text, business_type text, created_at timestamptz, people integer, orders integer, last_activity timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.business_type, o.created_at,
         (select count(*)::int from memberships m where m.org_id = o.id and m.status = 'active'),
         (select count(*)::int from sales_orders s where s.org_id = o.id),
         (select max(a.created_at) from audit_log a where a.org_id = o.id)
    from organizations o order by o.created_at desc limit 500
$$;

-- Uses a link once to create the company, its first warehouse and its owner. Everything or nothing.
-- Returns nothing when the link is no good; raises 'email_taken' when the email already has a login.
create function signup_create_company(
  p_token_hash text, p_company text, p_slug text, p_business_type text, p_features jsonb,
  p_timezone text, p_currency text, p_tax numeric, p_name text, p_email text, p_password_hash text
) returns table (user_id uuid, org_id uuid, session_version integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_invite uuid; v_org uuid; v_user uuid; v_email text := lower(trim(p_email)); v_slug text := p_slug; v_n integer := 1;
begin
  update signup_invites set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   returning id into v_invite;
  if v_invite is null then return; end if;
  if exists (select 1 from users where email = v_email) then raise exception 'email_taken'; end if;
  while exists (select 1 from organizations where slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := left(p_slug, 58) || '-' || v_n;
  end loop;
  insert into organizations (name, slug, business_type, features, timezone, base_currency, default_tax_percent)
  values (trim(p_company), v_slug, p_business_type, p_features, p_timezone, p_currency, p_tax) returning id into v_org;
  insert into locations (org_id, name) values (v_org, 'Main warehouse');
  insert into users (email, name) values (v_email, trim(p_name)) returning id into v_user;
  insert into memberships (org_id, user_id, role) values (v_org, v_user, 'owner');
  insert into user_credentials (user_id, password_hash) values (v_user, p_password_hash);
  insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
  values (v_org, 'user', v_user, 'company.created', 'organization', v_org, jsonb_build_object('businessType', p_business_type));
  update signup_invites set org_id = v_org where id = v_invite;
  return query select v_user, v_org, c.session_version from user_credentials c where c.user_id = v_user;
end $$;

do $$
declare f text; r text;
begin
  foreach f in array array[
    'signup_invite_create(text, text, uuid)', 'signup_invite_valid(text)', 'signup_invite_revoke(uuid)', 'signup_invite_list()', 'platform_companies()',
    'signup_create_company(text, text, text, text, jsonb, text, text, numeric, text, text, text)'
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
      execute format('revoke all on signup_invites from %I', r);
    end if;
  end loop;
end $$;
