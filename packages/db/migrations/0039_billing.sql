-- Plans and billing. A new company starts on a free trial (30 days for Dealer Terminal, 14 for Clivada);
-- Stripe holds the card and the subscription, and tells us its state through signed notifications.
-- Companies that existed before billing are exempt: they belong to whoever runs the service.

alter table organizations add column if not exists billing_exempt boolean not null default false;
alter table organizations add column if not exists trial_ends_at timestamptz;
-- One of cedro_basic, cedro_small, cedro_corporate, dealer. Null until the company subscribes.
alter table organizations add column if not exists plan text check (plan is null or plan in ('cedro_basic', 'cedro_small', 'cedro_corporate', 'dealer'));
alter table organizations add column if not exists billing_interval text check (billing_interval is null or billing_interval in ('month', 'year'));
-- Stripe's own word for the subscription: active, trialing, past_due, unpaid, canceled, incomplete, ...
alter table organizations add column if not exists subscription_status text;
alter table organizations add column if not exists stripe_customer_id text;
alter table organizations add column if not exists stripe_subscription_id text;
alter table organizations add column if not exists current_period_end timestamptz;
alter table organizations add column if not exists cancel_at_period_end boolean not null default false;
-- The time of the newest Stripe notification applied, so one that arrives late cannot undo a newer one.
alter table organizations add column if not exists stripe_updated_at timestamptz;

create unique index if not exists organizations_stripe_customer_idx on organizations (stripe_customer_id) where stripe_customer_id is not null;

update organizations set billing_exempt = true where trial_ends_at is null and plan is null;

-- Every new company gets its trial end date when it is created.
create or replace function organizations_set_trial() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.trial_ends_at is null and not new.billing_exempt then
    new.trial_ends_at := coalesce(new.created_at, now()) + case when new.business_type = 'dealer' then interval '30 days' else interval '14 days' end;
  end if;
  return new;
end $$;
drop trigger if exists organizations_set_trial on organizations;
create trigger organizations_set_trial before insert on organizations for each row execute function organizations_set_trial();
