begin;
-- Append-only cancellation ledger: original spins, UUID results and stock stay intact.
create table if not exists public.wjx_admin_prize_resets (
 request_id uuid primary key,
 telegram_id bigint not null references public.wjx_participants(telegram_id),
 event_start date not null, event_end date not null,
 operation_ids uuid[] not null default '{}',
 reset_count integer not null default 0 check(reset_count>=0),
 admin_session_hash text not null check(admin_session_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now()
);
create index if not exists wjx_admin_prize_resets_user on public.wjx_admin_prize_resets(telegram_id);
create table if not exists public.wjx_cancelled_prizes (
 spin_id bigint primary key references public.wjx_spins(id),
 reset_id uuid not null references public.wjx_admin_prize_resets(request_id)
);
alter table public.wjx_admin_prize_resets enable row level security;
alter table public.wjx_cancelled_prizes enable row level security;
revoke all on public.wjx_admin_prize_resets,public.wjx_cancelled_prizes from public,anon,authenticated,service_role;
grant select,insert on public.wjx_admin_prize_resets,public.wjx_cancelled_prizes to service_role;

create or replace function public.wjx_reset_user_prizes(p_telegram_id bigint,p_request_id uuid,p_admin_session_hash text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_old public.wjx_admin_prize_resets%rowtype; v_settings public.roulette_settings%rowtype; v_ids bigint[]; v_ops uuid[];
begin
 if p_telegram_id is null or p_telegram_id<=0 or p_request_id is null or p_admin_session_hash is null or p_admin_session_hash !~ '^[a-f0-9]{64}$' then
  raise exception 'Invalid reset' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(p_telegram_id);
 select * into v_old from public.wjx_admin_prize_resets where request_id=p_request_id;
 if found then
  if v_old.telegram_id<>p_telegram_id then raise exception 'Reset user mismatch' using errcode='22023'; end if;
  return jsonb_build_object('resetId',p_request_id,'reset_count',v_old.reset_count,'replayed',true); end if;
 if not exists(select 1 from public.wjx_participants where telegram_id=p_telegram_id) then raise exception 'Participant not found' using errcode='P0002'; end if;
 select * into strict v_settings from public.roulette_settings where id=1 for share;
 select coalesce(array_agg(s.id),'{}') into v_ids from public.wjx_spins s
 where s.telegram_id=p_telegram_id and s.spin_date between v_settings.event_start and v_settings.event_end
 and nullif(btrim(s.prize),'') is not null and btrim(s.prize)<>'Без выигрыша'
 and not exists(select 1 from public.wjx_cancelled_prizes c where c.spin_id=s.id);
 select coalesce(array_agg(o.request_id),'{}') into v_ops from public.wjx_spin_operations o
 where o.telegram_id=p_telegram_id and not o.is_test and o.result->>'spinDate' between v_settings.event_start::text and v_settings.event_end::text
 and nullif(btrim(o.result->>'prize'),'') is not null and o.result->>'prize'<>'Без выигрыша';
 insert into public.wjx_admin_prize_resets(request_id,telegram_id,event_start,event_end,operation_ids,reset_count,admin_session_hash)
 values(p_request_id,p_telegram_id,v_settings.event_start,v_settings.event_end,v_ops,cardinality(v_ids),p_admin_session_hash);
 insert into public.wjx_cancelled_prizes(spin_id,reset_id) select unnest(v_ids),p_request_id;
 return jsonb_build_object('resetId',p_request_id,'reset_count',cardinality(v_ids),'replayed',false);
end;
$$;
create or replace function public.wjx_visible_operation_result(p_telegram_id bigint,p_request_id uuid)
returns jsonb language sql stable set search_path = '' as $$
 select case when exists(select 1 from public.wjx_admin_prize_resets r where r.telegram_id=p_telegram_id and p_request_id=any(r.operation_ids))
 then o.result || jsonb_build_object('prize',null,'prizeReset',true) else o.result end
 from public.wjx_spin_operations o where o.telegram_id=p_telegram_id and o.request_id=p_request_id and not o.is_test;
$$;
create or replace function public.wjx_event_winners(p_search text default '', p_offset integer default 0)
returns jsonb language sql stable set search_path = '' as $$
  with event as (
    select event_start, event_end, start_time, end_time from public.roulette_settings where id = 1
  ), matched as (
    select p.telegram_id::text as telegram_id, p.first_name, p.username, count(*) as total_wins
    from public.wjx_spins s join public.wjx_participants p using (telegram_id) cross join event e
    where s.spin_date between e.event_start and e.event_end
      and not exists(select 1 from public.wjx_cancelled_prizes c where c.spin_id=s.id)
      and nullif(btrim(s.prize),'') is not null and btrim(s.prize) <> 'Без выигрыша'
      and (strpos(lower(coalesce(p.username,'')),lower(ltrim(left(coalesce(p_search,''),100),'@'))) > 0
        or strpos(lower(coalesce(p.first_name,'')),lower(ltrim(left(coalesce(p_search,''),100),'@'))) > 0
        or strpos(p.telegram_id::text,ltrim(left(coalesce(p_search,''),100),'@')) > 0)
    group by p.telegram_id, p.first_name, p.username
    order by count(*) desc, p.telegram_id
    limit 26 offset greatest(0,least(coalesce(p_offset,0),1000000))
  )
  select jsonb_build_object(
    'period',(select to_jsonb(e) from event e),
    'winners',(select coalesce(jsonb_agg(to_jsonb(w) order by w.total_wins desc,w.telegram_id),'[]'::jsonb) from (select * from matched limit 25) w),
    'has_more',(select count(*) > 25 from matched)
  );
$$;
create or replace function public.wjx_user_prize_summary(p_telegram_id bigint)
returns jsonb language sql stable set search_path = '' as $$
  with event as (
    select event_start, event_end, start_time, end_time from public.roulette_settings where id = 1
  ), wins as (
    select s.id, s.spin_date, btrim(s.prize) as prize
    from public.wjx_spins s cross join event e
    where s.telegram_id = p_telegram_id and s.spin_date between e.event_start and e.event_end
      and not exists(select 1 from public.wjx_cancelled_prizes c where c.spin_id=s.id)
      and nullif(btrim(s.prize),'') is not null and btrim(s.prize) <> 'Без выигрыша'
  )
  select jsonb_build_object(
    'participant',jsonb_build_object('telegram_id',p.telegram_id::text,'first_name',p.first_name,'username',p.username),
    'period',(select to_jsonb(e) from event e),
    'total_wins',(select count(*) from wins),
    'delivered_count',(select count(*) from wins w join public.wjx_prize_deliveries d on d.spin_id=w.id),
    'remaining_count',(select count(*) from wins w where not exists(select 1 from public.wjx_prize_deliveries d where d.spin_id=w.id)),
    'can_deliver',(select date_trunc('minute',clock_timestamp() at time zone 'Europe/Moscow') > e.event_end+e.end_time from event e),
    'delivered_prizes',(select coalesce(jsonb_agg(to_jsonb(g) order by g.prize),'[]'::jsonb)
      from (select w.prize,count(*) as quantity from wins w join public.wjx_prize_deliveries d on d.spin_id=w.id group by w.prize) g),
    'prizes',(select coalesce(jsonb_agg(to_jsonb(g) order by g.quantity desc,g.prize),'[]'::jsonb)
      from (select prize,count(*) as quantity from wins group by prize) g),
    'daily',(select coalesce(jsonb_agg(to_jsonb(d) order by d.spin_date,d.prize),'[]'::jsonb)
      from (select spin_date,prize,count(*) as quantity from wins group by spin_date,prize) d)
  ) from public.wjx_participants p where p.telegram_id = p_telegram_id;
$$;
create or replace function public.wjx_mark_prizes_delivered(p_telegram_id bigint,p_session_hash text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_settings public.roulette_settings%rowtype;
  v_count integer;
begin
  if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid session' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(p_telegram_id);
  select * into strict v_settings from public.roulette_settings where id=1 for share;
  if date_trunc('minute',clock_timestamp() at time zone 'Europe/Moscow') <= v_settings.event_end+v_settings.end_time then
    raise exception 'Event has not finished' using errcode='P0002';
  end if;
  if not exists(select 1 from public.wjx_participants where telegram_id=p_telegram_id) then
    raise exception 'Participant not found' using errcode='P0002';
  end if;
  insert into public.wjx_prize_deliveries(spin_id,admin_session_hash)
    select s.id,p_session_hash from public.wjx_spins s
    where s.telegram_id=p_telegram_id and s.spin_date between v_settings.event_start and v_settings.event_end
      and not exists(select 1 from public.wjx_cancelled_prizes c where c.spin_id=s.id)
      and nullif(btrim(s.prize),'') is not null and btrim(s.prize)<>'Без выигрыша'
    on conflict(spin_id) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('marked_count',v_count);
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
    return public.wjx_visible_operation_result(p_telegram_id,p_request_id);
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
    'prizeResetVersion',(select max(created_at) from public.wjx_admin_prize_resets where telegram_id=p_telegram_id),
    'eventSummary',public.wjx_user_prize_summary(p_telegram_id),
    'dailyHistory',(select coalesce(jsonb_agg(jsonb_build_object('prize',case when exists(select 1 from public.wjx_cancelled_prizes c where c.spin_id=s.id) then 'Приз сброшен' else s.prize end,'spinNumber',s.spin_number-(select n from baseline),'spinDate',s.spin_date)
      order by s.spin_number,s.id),'[]'::jsonb) from public.wjx_spins s cross join day d
      where s.telegram_id=p_telegram_id and s.spin_date=d.date and s.spin_number>(select n from baseline)),
    'pendingOperation',public.wjx_visible_operation_result(p_telegram_id,p_request_id)
  ) from configuration c cross join used u cross join moment m;
$$;
create or replace function public.wjx_admin_prize_stats()
returns jsonb language sql stable set search_path = '' as $$
  with day as materialized (
    select (statement_timestamp() at time zone 'Europe/Moscow')::date as date
  ), counts as (
    select prize,count(*) as n from public.wjx_spins group by prize
  ), today as (
    select prize,count(*) as n from public.wjx_spins cross join day where spin_date=day.date group by prize
  ), tests as (
    select prize,count(*) as n from public.wjx_test_spins group by prize
  )
  select jsonb_build_object(
    'limitScope','day','stockDate',(select date from day),
    'prizes',(select coalesce(jsonb_agg(jsonb_build_object(
      'prize',p.prize,'chance',p.chance,'prize_limit',p.prize_limit,
      'resetWins',(select count(*) from public.wjx_cancelled_prizes v join public.wjx_spins x on x.id=v.spin_id where x.prize=p.prize),'realWins',coalesce(c.n,0),'todayWins',coalesce(d.n,0),'testWins',coalesce(t.n,0),
      'remainingToday',case when p.prize_limit is null then null else greatest(0,p.prize_limit-coalesce(d.n,0)) end,
      'remaining',case when p.prize_limit is null then null else greatest(0,p.prize_limit-coalesce(d.n,0)) end
    ) order by p.prize),'[]'::jsonb)
      from public.roulette_prize_chances p left join counts c using(prize) left join today d using(prize) left join tests t using(prize)),
    'history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id desc),'[]'::jsonb)
      from (select s.id,s.created_at,s.telegram_id,s.spin_date,s.prize,exists(select 1 from public.wjx_cancelled_prizes c where c.spin_id=s.id) as prize_reset,
        coalesce(p.first_name,'Неизвестный участник') as first_name,p.username
        from public.wjx_spins s left join public.wjx_participants p using(telegram_id)
        order by s.created_at desc,s.id desc limit 50) h)
  );
$$;
revoke all on function public.wjx_reset_user_prizes(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.wjx_reset_user_prizes(bigint,uuid,text) to service_role;
revoke all on function public.wjx_visible_operation_result(bigint,uuid) from public,anon,authenticated;
grant execute on function public.wjx_visible_operation_result(bigint,uuid) to service_role;
commit;
