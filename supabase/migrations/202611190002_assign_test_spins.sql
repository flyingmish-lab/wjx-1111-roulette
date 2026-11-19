begin;
create table if not exists public.wjx_test_balances (
  telegram_id bigint primary key references public.wjx_participants(telegram_id),
  remaining integer not null default 0 check (remaining between 0 and 100),
  updated_at timestamptz not null default now()
);
alter table public.wjx_test_balances enable row level security;
revoke all on public.wjx_test_balances from public, anon, authenticated;
grant select, insert, update on public.wjx_test_balances to service_role;

-- Setting an absolute balance makes a repeated HTTP request idempotent.
create or replace function public.wjx_set_test_spins(p_telegram_id bigint, p_attempts integer)
returns integer language plpgsql set search_path = '' as $$
begin
  if p_attempts is null or p_attempts < 0 or p_attempts > 100 then
    raise exception 'Invalid test balance' using errcode = '22023';
  end if;
  if not exists (select 1 from public.wjx_participants where telegram_id = p_telegram_id) then
    raise exception 'Participant not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(p_telegram_id);
  insert into public.wjx_test_balances(telegram_id, remaining) values (p_telegram_id, p_attempts)
    on conflict (telegram_id) do update set remaining = excluded.remaining, updated_at = now();
  return p_attempts;
end;
$$;

create or replace function public.wjx_admin_test_users(p_search text default '', p_offset integer default 0)
returns jsonb language sql stable set search_path = '' as $$
  with matched as (
    select p.telegram_id::text as telegram_id, p.first_name, p.username, coalesce(b.remaining,0) as test_remaining
    from public.wjx_participants p left join public.wjx_test_balances b using(telegram_id)
    where p.telegram_id::text ilike '%' || left(coalesce(p_search,''),100) || '%'
      or coalesce(p.first_name,'') ilike '%' || left(coalesce(p_search,''),100) || '%'
      or coalesce(p.username,'') ilike '%' || left(coalesce(p_search,''),100) || '%'
    order by p.telegram_id limit 26 offset greatest(0,least(coalesce(p_offset,0),1000000))
  )
  select jsonb_build_object('users',(select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from (select * from matched limit 25) u),
    'has_more',(select count(*) > 25 from matched));
$$;

-- A new RPC spends only explicitly allocated test balance; legacy RPC stays disabled.
create or replace function public.wjx_use_test_spin(p_telegram_id bigint, p_prize text)
returns integer language plpgsql set search_path = '' as $$
declare
  v_balance integer;
  v_number integer;
  v_day date;
begin
  perform pg_advisory_xact_lock(p_telegram_id);
  select remaining into v_balance from public.wjx_test_balances where telegram_id = p_telegram_id for update;
  if v_balance is null or v_balance <= 0 then
    raise exception 'No test attempts available' using errcode = 'P0001';
  end if;
  if p_prize is null or not exists (select 1 from public.roulette_prize_chances where prize = p_prize) then
    raise exception 'Invalid prize' using errcode = '22023';
  end if;
  v_day := (clock_timestamp() at time zone 'Europe/Moscow')::date;
  select coalesce(max(spin_number),0) + 1 into v_number from public.wjx_test_spins
    where telegram_id = p_telegram_id and spin_date = v_day;
  if v_number > 32767 then raise exception 'Test daily storage limit reached' using errcode = 'P0001'; end if;
  insert into public.wjx_test_spins(telegram_id, spin_date, spin_number, prize)
    values (p_telegram_id, v_day, v_number, p_prize);
  update public.wjx_test_balances set remaining = remaining - 1, updated_at = now()
    where telegram_id = p_telegram_id;
  return v_balance - 1;
end;
$$;
revoke all on function public.wjx_set_test_spins(bigint,integer), public.wjx_admin_test_users(text,integer),
  public.wjx_use_test_spin(bigint,text) from public, anon, authenticated;
grant execute on function public.wjx_set_test_spins(bigint,integer), public.wjx_admin_test_users(text,integer),
  public.wjx_use_test_spin(bigint,text) to service_role;
commit;
