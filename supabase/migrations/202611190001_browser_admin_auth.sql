begin;

-- Additive migration: retain participants, spins, test history, chances and settings.
alter table public.wjx_admin_login_attempts
  add column if not exists window_started_at timestamptz not null default now();
create unique index if not exists wjx_admin_login_client_id_unique
  on public.wjx_admin_login_attempts(client_id);

create table if not exists public.wjx_admin_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.wjx_admin_sessions enable row level security;
revoke all on public.wjx_admin_sessions from public, anon, authenticated;
grant select, insert, delete on public.wjx_admin_sessions to service_role;

create or replace function public.wjx_consume_admin_login_attempt()
returns table(allowed boolean, retry_after integer)
language plpgsql set search_path = '' as $$
declare
  v_row public.wjx_admin_login_attempts%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  insert into public.wjx_admin_login_attempts(client_id, window_started_at)
  values ('shared-admin-v1', v_now) on conflict (client_id) do nothing;
  select * into strict v_row from public.wjx_admin_login_attempts
    where client_id = 'shared-admin-v1' for update;
  v_now := clock_timestamp();
  if v_row.window_started_at + interval '15 minutes' <= v_now then
    update public.wjx_admin_login_attempts
      set failed_attempts = 1, window_started_at = v_now, locked_until = null, updated_at = v_now
      where client_id = 'shared-admin-v1';
    return query select true, 0;
  elsif v_row.failed_attempts >= 10 then
    return query select false, greatest(1, ceil(extract(epoch from
      (v_row.window_started_at + interval '15 minutes' - v_now)))::integer);
  else
    update public.wjx_admin_login_attempts
      set failed_attempts = failed_attempts + 1, updated_at = v_now,
        locked_until = case when failed_attempts + 1 >= 10
          then window_started_at + interval '15 minutes' else null end
      where client_id = 'shared-admin-v1';
    return query select true, 0;
  end if;
end;
$$;
revoke all on function public.wjx_consume_admin_login_attempt() from public, anon, authenticated;
grant execute on function public.wjx_consume_admin_login_attempt() to service_role;

-- Aggregate in PostgreSQL: API row limits must never truncate statistics.
create or replace function public.wjx_admin_prize_stats()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'prizes', (select coalesce(jsonb_agg(jsonb_build_object(
      'prize', p.prize, 'chance', p.chance,
      'realWins', (select count(*) from public.wjx_spins s where s.prize = p.prize),
      'testWins', (select count(*) from public.wjx_test_spins s where s.prize = p.prize)
    ) order by p.prize), '[]'::jsonb) from public.roulette_prize_chances p),
    'history', (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc, h.id desc), '[]'::jsonb)
      from (select s.id, s.created_at, s.telegram_id, s.spin_date, s.prize,
        coalesce(p.first_name, 'Неизвестный участник') as first_name, p.username
        from public.wjx_spins s left join public.wjx_participants p using (telegram_id)
        order by s.created_at desc, s.id desc limit 50) h)
  );
$$;
revoke all on function public.wjx_admin_prize_stats() from public, anon, authenticated;
grant execute on function public.wjx_admin_prize_stats() to service_role;

-- Keep the existing advisory lock and enforce schedule inside the same transaction.
create or replace function public.wjx_save_spin(p_telegram_id bigint, p_spin_date date, p_prize text)
returns table(spin_number integer, spins_remaining integer)
language plpgsql set search_path = '' as $$
declare
  v_used integer;
  v_settings public.roulette_settings%rowtype;
  v_now timestamp;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then raise exception 'Invalid participant'; end if;
  perform pg_advisory_xact_lock(p_telegram_id);
  select * into strict v_settings from public.roulette_settings where id = 1 for share;
  v_now := date_trunc('minute', clock_timestamp() at time zone 'Europe/Moscow');
  if p_spin_date is distinct from v_now::date or
    v_now < v_settings.event_start + v_settings.start_time or
    v_now > v_settings.event_end + v_settings.end_time then
    raise exception 'Event is not active' using errcode = 'P0002';
  end if;
  if p_prize is null or not exists (select 1 from public.roulette_prize_chances where prize = p_prize) then
    raise exception 'Invalid prize';
  end if;
  select count(*)::integer into v_used from public.wjx_spins
    where telegram_id = p_telegram_id and spin_date = p_spin_date;
  if v_used >= v_settings.daily_spins then
    raise exception 'Daily spin limit reached' using errcode = 'P0001';
  end if;
  insert into public.wjx_spins(telegram_id, spin_date, spin_number, prize)
    values (p_telegram_id, p_spin_date, v_used + 1, p_prize);
  return query select v_used + 1, v_settings.daily_spins - v_used - 1;
end;
$$;
revoke all on function public.wjx_save_spin(bigint, date, text) from public, anon, authenticated;
grant execute on function public.wjx_save_spin(bigint, date, text) to service_role;
-- Retain the old function and all test data, but disable further test spins.
revoke all on function public.wjx_save_test_spin(bigint, date, text) from public, anon, authenticated, service_role;

-- No browser role needs direct access. RLS remains enabled as a second layer.
revoke all on public.wjx_admin_login_attempts, public.roulette_settings,
  public.roulette_prize_chances, public.wjx_participants, public.wjx_spins, public.wjx_test_spins
  from public, anon, authenticated;
alter table public.wjx_admin_login_attempts enable row level security;
alter table public.roulette_settings enable row level security;
alter table public.roulette_prize_chances enable row level security;
alter table public.wjx_participants enable row level security;
alter table public.wjx_spins enable row level security;
alter table public.wjx_test_spins enable row level security;
commit;
