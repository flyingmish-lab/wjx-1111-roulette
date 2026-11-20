begin;
-- Preserve all existing spins. A request ID identifies one operation for one player.
create table if not exists public.wjx_spin_operations (
  telegram_id bigint not null references public.wjx_participants(telegram_id),
  request_id uuid not null,
  is_test boolean not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (telegram_id, request_id)
);
alter table public.wjx_spin_operations enable row level security;
revoke all on public.wjx_spin_operations from public, anon, authenticated;
grant select, insert on public.wjx_spin_operations to service_role;

create or replace function public.wjx_perform_spin(p_telegram_id bigint, p_request_id uuid, p_is_test boolean, p_prize text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_existing public.wjx_spin_operations%rowtype;
  v_day date;
  v_result jsonb;
  v_saved record;
  v_remaining integer;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_request_id is null or p_is_test is null then
    raise exception 'Invalid operation' using errcode='22023';
  end if;
  -- Same lock as the original real/test save functions and test balance assignment.
  perform pg_advisory_xact_lock(p_telegram_id);
  select * into v_existing from public.wjx_spin_operations
    where telegram_id=p_telegram_id and request_id=p_request_id;
  if found then
    if v_existing.is_test is distinct from p_is_test then
      raise exception 'Operation mode mismatch' using errcode='22023';
    end if;
    return v_existing.result;
  end if;
  v_day := (clock_timestamp() at time zone 'Europe/Moscow')::date;
  if p_is_test then
    v_remaining := public.wjx_use_test_spin(p_telegram_id,p_prize);
    v_result := jsonb_build_object('operationId',p_request_id,'spinDate',v_day,'isTest',true,
      'prize',case when p_prize='Без выигрыша' then null else p_prize end,'testRemaining',v_remaining);
  else
    select * into strict v_saved from public.wjx_save_spin(p_telegram_id,v_day,p_prize);
    v_result := jsonb_build_object('operationId',p_request_id,'spinDate',v_day,'isTest',false,
      'prize',case when p_prize='Без выигрыша' then null else p_prize end,
      'spinNumber',v_saved.spin_number,'spinsRemaining',v_saved.spins_remaining);
  end if;
  -- This row and the spin commit together. Retrying never consumes another attempt.
  insert into public.wjx_spin_operations(telegram_id,request_id,is_test,result)
    values(p_telegram_id,p_request_id,p_is_test,v_result);
  return v_result;
end;
$$;
revoke all on function public.wjx_perform_spin(bigint,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.wjx_perform_spin(bigint,uuid,boolean,text) to service_role;

create or replace function public.wjx_player_state(p_telegram_id bigint,p_request_id uuid default null)
returns jsonb language sql volatile set search_path = '' as $$
  with moment as materialized (
    select clock_timestamp() as now
  ), configuration as (
    select event_start,event_end,start_time,end_time,daily_spins from public.roulette_settings where id=1
  ), day as (
    select (now at time zone 'Europe/Moscow')::date as date from moment
  ), used as (
    select count(*)::integer as n from public.wjx_spins s cross join day d
      where s.telegram_id=p_telegram_id and s.spin_date=d.date
  )
  select jsonb_build_object(
    'serverNow',(select now from moment),'serverDate',(select date from day),
    'settings',to_jsonb(c),'spinsUsed',u.n,'spinsRemaining',greatest(0,c.daily_spins-u.n),
    'testRemaining',coalesce((select remaining from public.wjx_test_balances where telegram_id=p_telegram_id),0),
    'eventStatus',case when date_trunc('minute',m.now at time zone 'Europe/Moscow') < c.event_start+c.start_time then 'before'
      when date_trunc('minute',m.now at time zone 'Europe/Moscow') > c.event_end+c.end_time then 'finished' else 'active' end,
    'eventSummary',public.wjx_user_prize_summary(p_telegram_id),
    'dailyHistory',(select coalesce(jsonb_agg(jsonb_build_object('prize',s.prize,'spinNumber',s.spin_number,'spinDate',s.spin_date)
      order by s.spin_number,s.id),'[]'::jsonb) from public.wjx_spins s cross join day d
      where s.telegram_id=p_telegram_id and s.spin_date=d.date),
    'pendingOperation',(select result from public.wjx_spin_operations where telegram_id=p_telegram_id and request_id=p_request_id)
  ) from configuration c cross join used u cross join moment m;
$$;
revoke all on function public.wjx_player_state(bigint,uuid) from public,anon,authenticated;
grant execute on function public.wjx_player_state(bigint,uuid) to service_role;
commit;
