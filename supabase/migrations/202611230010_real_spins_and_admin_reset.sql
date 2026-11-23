begin;
-- Keep all real wins, old test history, allocations, deliveries and UUIDs intact.
create table if not exists public.wjx_admin_spin_resets (
  request_id uuid primary key,
  telegram_id bigint not null references public.wjx_participants(telegram_id),
  spin_date date not null,
  baseline_spin_number integer not null check(baseline_spin_number between 0 and 32767),
  admin_session_hash text not null check(admin_session_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists wjx_admin_spin_resets_user_day on public.wjx_admin_spin_resets(telegram_id,spin_date,baseline_spin_number);
alter table public.wjx_admin_spin_resets enable row level security;
revoke all on public.wjx_admin_spin_resets from public,anon,authenticated;
grant select,insert on public.wjx_admin_spin_resets to service_role;
-- Stored slots are monotonic across resets to preserve the original unique key.
-- The configured 1–20 attempts per allocation is still enforced by the RPC.
alter table public.wjx_spins drop constraint if exists wjx_spins_spin_number_check;
alter table public.wjx_spins add constraint wjx_spins_spin_number_check check(spin_number between 1 and 32767);

create or replace function public.wjx_reset_daily_spins(p_telegram_id bigint,p_request_id uuid,p_admin_session_hash text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_old public.wjx_admin_spin_resets%rowtype; v_day date; v_baseline integer; v_limit integer;
begin
  if p_telegram_id is null or p_telegram_id<=0 or p_request_id is null or p_admin_session_hash is null or
    p_admin_session_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid reset' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(p_telegram_id);
  select * into v_old from public.wjx_admin_spin_resets where request_id=p_request_id;
  if found then
    if v_old.telegram_id<>p_telegram_id then raise exception 'Reset user mismatch' using errcode='22023'; end if;
    return jsonb_build_object('resetId',p_request_id,'telegram_id',p_telegram_id::text,'spinDate',v_old.spin_date,'replayed',true);
  end if;
  if not exists(select 1 from public.wjx_participants where telegram_id=p_telegram_id) then
    raise exception 'Participant not found' using errcode='P0002'; end if;
  v_day:=(clock_timestamp() at time zone 'Europe/Moscow')::date;
  select daily_spins into strict v_limit from public.roulette_settings where id=1 for share;
  select coalesce(max(spin_number),0) into v_baseline from public.wjx_spins where telegram_id=p_telegram_id and spin_date=v_day;
  insert into public.wjx_admin_spin_resets(request_id,telegram_id,spin_date,baseline_spin_number,admin_session_hash)
    values(p_request_id,p_telegram_id,v_day,v_baseline,p_admin_session_hash);
  return jsonb_build_object('resetId',p_request_id,'telegram_id',p_telegram_id::text,'spinDate',v_day,'spinsRemaining',v_limit,'replayed',false);
end;
$$;
revoke all on function public.wjx_reset_daily_spins(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.wjx_reset_daily_spins(bigint,uuid,text) to service_role;

create or replace function public.wjx_save_spin(p_telegram_id bigint,p_spin_date date,p_prize text)
returns table(spin_number integer,spins_remaining integer)
language plpgsql set search_path = '' as $$
declare v_used integer; v_next integer; v_baseline integer; v_settings public.roulette_settings%rowtype; v_now timestamp;
begin
  if p_telegram_id is null or p_telegram_id<=0 then raise exception 'Invalid participant' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(p_telegram_id);
  select * into strict v_settings from public.roulette_settings where id=1 for share;
  if v_settings.spins_paused then raise exception 'Spins paused' using errcode='P0003'; end if;
  v_now:=date_trunc('minute',clock_timestamp() at time zone 'Europe/Moscow');
  if p_spin_date is distinct from v_now::date or v_now<v_settings.event_start+v_settings.start_time or
    v_now>v_settings.event_end+v_settings.end_time then raise exception 'Event is not active' using errcode='P0002'; end if;
  if p_prize is null or not exists(select 1 from public.roulette_prize_chances where prize=p_prize) then
    raise exception 'Invalid prize' using errcode='22023'; end if;
  select coalesce(max(baseline_spin_number),0) into v_baseline from public.wjx_admin_spin_resets where telegram_id=p_telegram_id and spin_date=p_spin_date;
  select count(*) filter(where s.spin_number>v_baseline)::integer,coalesce(max(s.spin_number),0)+1 into v_used,v_next
    from public.wjx_spins s where s.telegram_id=p_telegram_id and s.spin_date=p_spin_date;
  if v_used>=v_settings.daily_spins or v_next>32767 then raise exception 'Daily spin limit reached' using errcode='P0001'; end if;
  insert into public.wjx_spins(telegram_id,spin_date,spin_number,prize) values(p_telegram_id,p_spin_date,v_next,p_prize);
  return query select v_next,v_settings.daily_spins-v_used-1;
end;
$$;
create or replace function public.wjx_perform_spin(p_telegram_id bigint, p_request_id uuid, p_is_test boolean, p_prize text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_existing public.wjx_spin_operations%rowtype;
  v_day date;
  v_result jsonb;
  v_saved record;
  v_remaining integer;
  v_paused boolean;
  v_actual_prize text;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_request_id is null or p_is_test is null then
    raise exception 'Invalid operation' using errcode='22023';
  end if;
  if p_is_test then raise exception 'Test spins retired' using errcode='22023'; end if;
  -- Serialize each participant's spin, reset and UUID recovery.
  perform pg_advisory_xact_lock(p_telegram_id);
  select * into v_existing from public.wjx_spin_operations
    where telegram_id=p_telegram_id and request_id=p_request_id;
  if found then
    if v_existing.is_test is distinct from p_is_test then
      raise exception 'Operation mode mismatch' using errcode='22023';
    end if;
    return v_existing.result;
  end if;
  select spins_paused into strict v_paused from public.roulette_settings where id=1 for share;
  if v_paused then raise exception 'Spins paused' using errcode='P0003'; end if;
  v_day := (clock_timestamp() at time zone 'Europe/Moscow')::date;
  select * into strict v_saved from public.wjx_save_spin(p_telegram_id,v_day,p_prize);
  select prize into strict v_actual_prize from public.wjx_spins
    where telegram_id=p_telegram_id and spin_date=v_day and spin_number=v_saved.spin_number;
  v_result := jsonb_build_object('operationId',p_request_id,'spinDate',v_day,'isTest',false,
    'prize',case when v_actual_prize='Без выигрыша' then null else v_actual_prize end,
    'spinNumber',v_saved.spin_number-coalesce((select max(baseline_spin_number) from public.wjx_admin_spin_resets
      where telegram_id=p_telegram_id and spin_date=v_day),0),
    'spinsRemaining',v_saved.spins_remaining);
  -- This row and the spin commit together. Retrying never consumes another attempt.
  insert into public.wjx_spin_operations(telegram_id,request_id,is_test,result)
    values(p_telegram_id,p_request_id,p_is_test,v_result);
  return v_result;
end;
$$;
create or replace function public.wjx_player_state(p_telegram_id bigint,p_request_id uuid default null)
returns jsonb language sql volatile set search_path = '' as $$
  with moment as materialized (
    select clock_timestamp() as now
  ), configuration as (
    select event_start,event_end,start_time,end_time,daily_spins,spins_paused from public.roulette_settings where id=1
  ), day as (
    select (now at time zone 'Europe/Moscow')::date as date from moment
  ), baseline as (
    select coalesce(max(r.baseline_spin_number),0) as n from public.wjx_admin_spin_resets r cross join day d
      where r.telegram_id=p_telegram_id and r.spin_date=d.date
  ), used as (
    select count(*)::integer as n from public.wjx_spins s cross join day d
      where s.telegram_id=p_telegram_id and s.spin_date=d.date and s.spin_number>(select n from baseline)
  )
  select jsonb_build_object(
    'serverNow',(select now from moment),'serverDate',(select date from day),
    'settings',to_jsonb(c),'spinsUsed',u.n,'spinsRemaining',greatest(0,c.daily_spins-u.n),
    'eventStatus',case when date_trunc('minute',m.now at time zone 'Europe/Moscow') < c.event_start+c.start_time then 'before'
      when date_trunc('minute',m.now at time zone 'Europe/Moscow') > c.event_end+c.end_time then 'finished' else 'active' end,
    'eventSummary',public.wjx_user_prize_summary(p_telegram_id),
    'dailyHistory',(select coalesce(jsonb_agg(jsonb_build_object('prize',s.prize,'spinNumber',s.spin_number-(select n from baseline),'spinDate',s.spin_date)
      order by s.spin_number,s.id),'[]'::jsonb) from public.wjx_spins s cross join day d
      where s.telegram_id=p_telegram_id and s.spin_date=d.date and s.spin_number>(select n from baseline)),
    'pendingOperation',(select result from public.wjx_spin_operations where telegram_id=p_telegram_id and request_id=p_request_id and not is_test)
  ) from configuration c cross join used u cross join moment m;
$$;
create or replace function public.wjx_admin_spin_users(p_search text default '',p_offset integer default 0)
returns jsonb language sql stable set search_path = '' as $$
  with day as materialized(select (statement_timestamp() at time zone 'Europe/Moscow')::date as date),
  matched as (
    select p.telegram_id::text as telegram_id,p.first_name,p.username,
      (select count(*)::integer from public.wjx_spins s cross join day d where s.telegram_id=p.telegram_id and s.spin_date=d.date
        and s.spin_number>coalesce((select max(r.baseline_spin_number) from public.wjx_admin_spin_resets r where r.telegram_id=p.telegram_id and r.spin_date=d.date),0)) as spins_used
    from public.wjx_participants p
    where p.telegram_id::text ilike '%'||left(coalesce(p_search,''),100)||'%'
      or coalesce(p.first_name,'') ilike '%'||left(coalesce(p_search,''),100)||'%'
      or coalesce(p.username,'') ilike '%'||left(coalesce(p_search,''),100)||'%'
    order by p.telegram_id limit 26 offset greatest(0,least(coalesce(p_offset,0),1000000))
  )
  select jsonb_build_object('spinDate',(select date from day),'users',(select coalesce(jsonb_agg(to_jsonb(u)),'[]') from
    (select m.*,greatest(0,(select daily_spins from public.roulette_settings where id=1)-spins_used) as spins_remaining from matched m limit 25) u),
    'has_more',(select count(*)>25 from matched));
$$;
revoke all on function public.wjx_admin_spin_users(text,integer) from public,anon,authenticated;
grant execute on function public.wjx_admin_spin_users(text,integer) to service_role;
-- Retire old allocation/test RPCs without deleting historical tables or balances.
revoke all on function public.wjx_use_test_spin(bigint,text),public.wjx_set_test_spins(bigint,integer),public.wjx_admin_test_users(text,integer)
  from public,anon,authenticated,service_role;
revoke insert,update,delete on public.wjx_test_balances,public.wjx_test_spins from service_role;
commit;
