create table if not exists public.ai_usages (
  id bigserial primary key,
  usage_date date not null,
  provider text not null,
  ip_address text not null,
  device_id text not null,
  endpoint text not null,
  legacy_source text,
  legacy_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists ai_usages_daily_provider_client_idx
  on public.ai_usages (usage_date, provider, ip_address, device_id);

create index if not exists ai_usages_daily_provider_device_idx
  on public.ai_usages (usage_date, provider, device_id);

create unique index if not exists ai_usages_legacy_idx
  on public.ai_usages (legacy_source, legacy_id)
  where legacy_source is not null and legacy_id is not null;

create table if not exists public.ai_quota_overrides (
  id bigserial primary key,
  provider text not null default 'gemini',
  device_id text not null,
  ip_address text,
  usage_date date,
  daily_limit integer,
  extra_uses integer not null default 0,
  is_blocked boolean not null default false,
  status text not null default 'active',
  note text,
  legacy_source text,
  legacy_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_quota_overrides_status_check
    check (status in ('active', 'deactive')),
  constraint ai_quota_overrides_daily_limit_check
    check (daily_limit is null or daily_limit >= 0),
  constraint ai_quota_overrides_extra_uses_check
    check (extra_uses >= 0),
  constraint ai_quota_overrides_provider_check
    check (provider ~ '^[a-z0-9._:-]{2,64}$')
);

create index if not exists ai_quota_overrides_client_idx
  on public.ai_quota_overrides (provider, device_id, status, usage_date);

create unique index if not exists ai_quota_overrides_legacy_idx
  on public.ai_quota_overrides (legacy_source, legacy_id)
  where legacy_source is not null and legacy_id is not null;

alter table public.ai_usages enable row level security;
alter table public.ai_quota_overrides enable row level security;

do $$
begin
  if to_regclass('public.gemini_usages') is not null then
    insert into public.ai_usages (
      usage_date,
      provider,
      ip_address,
      device_id,
      endpoint,
      legacy_source,
      legacy_id,
      created_at
    )
    select
      usage_date,
      'gemini',
      ip_address,
      device_id,
      endpoint,
      'gemini_usages',
      id,
      created_at
    from public.gemini_usages
    on conflict (legacy_source, legacy_id) where legacy_source is not null and legacy_id is not null do nothing;
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.gemini_quota_overrides') is not null then
    insert into public.ai_quota_overrides (
      provider,
      device_id,
      ip_address,
      usage_date,
      daily_limit,
      extra_uses,
      is_blocked,
      status,
      note,
      legacy_source,
      legacy_id,
      created_at,
      updated_at
    )
    select
      'gemini',
      device_id,
      ip_address,
      usage_date,
      daily_limit,
      extra_uses,
      is_blocked,
      status,
      note,
      'gemini_quota_overrides',
      id,
      created_at,
      updated_at
    from public.gemini_quota_overrides
    on conflict (legacy_source, legacy_id) where legacy_source is not null and legacy_id is not null do nothing;
  end if;
end;
$$;

create or replace function public.record_ai_usage(
  p_usage_date date,
  p_provider text,
  p_ip_address text,
  p_device_id text,
  p_endpoint text,
  p_daily_limit integer
)
returns table(allowed boolean, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
  clean_provider text;
begin
  clean_provider := lower(trim(p_provider));

  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', p_usage_date::text, clean_provider, p_device_id),
    0
  ));

  select count(*)
    into current_count
    from public.ai_usages
    where usage_date = p_usage_date
      and provider = clean_provider
      and device_id = p_device_id;

  if current_count >= p_daily_limit then
    allowed := false;
    remaining := 0;
    return next;
    return;
  end if;

  insert into public.ai_usages (
    usage_date,
    provider,
    ip_address,
    device_id,
    endpoint
  )
  values (
    p_usage_date,
    clean_provider,
    p_ip_address,
    p_device_id,
    p_endpoint
  );

  allowed := true;
  remaining := greatest(0, p_daily_limit - current_count - 1);
  return next;
end;
$$;

create or replace function public.get_ai_usage_count(
  p_usage_date date,
  p_provider text,
  p_device_id text
)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.ai_usages
    where usage_date = p_usage_date
      and provider = lower(trim(p_provider))
      and device_id = p_device_id;
$$;

create or replace function public.record_gemini_usage(
  p_usage_date date,
  p_ip_address text,
  p_device_id text,
  p_endpoint text,
  p_daily_limit integer
)
returns table(allowed boolean, remaining integer)
language sql
security definer
set search_path = public
as $$
  select *
    from public.record_ai_usage(
      p_usage_date,
      'gemini',
      p_ip_address,
      p_device_id,
      p_endpoint,
      p_daily_limit
    );
$$;
