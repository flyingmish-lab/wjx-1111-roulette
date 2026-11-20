begin;
-- Issued prizes are identified by persisted real spin IDs, never by nickname.
create table if not exists public.wjx_prize_deliveries (
  spin_id bigint primary key references public.wjx_spins(id),
  delivered_at timestamptz not null default now(),
  admin_session_hash text not null check(admin_session_hash ~ '^[a-f0-9]{64}$')
);
alter table public.wjx_prize_deliveries enable row level security;
revoke all on public.wjx_prize_deliveries from public,anon,authenticated;
grant select,insert on public.wjx_prize_deliveries to service_role;

create or replace function public.wjx_user_prize_summary(p_telegram_id bigint)
returns jsonb language sql stable set search_path = '' as $$
  with event as (
    select event_start, event_end, start_time, end_time from public.roulette_settings where id = 1
  ), wins as (
    select s.id, s.spin_date, btrim(s.prize) as prize
    from public.wjx_spins s cross join event e
    where s.telegram_id = p_telegram_id and s.spin_date between e.event_start and e.event_end
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
      and nullif(btrim(s.prize),'') is not null and btrim(s.prize)<>'Без выигрыша'
    on conflict(spin_id) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('marked_count',v_count);
end;
$$;
revoke all on function public.wjx_mark_prizes_delivered(bigint,text) from public,anon,authenticated;
grant execute on function public.wjx_mark_prizes_delivered(bigint,text) to service_role;
commit;
