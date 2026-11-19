begin;

-- Winners are derived only from persisted real spins during the configured event.
-- A nickname is searchable; the stable Telegram ID selects a participant's record.
create or replace function public.wjx_event_winners(p_search text default '', p_offset integer default 0)
returns jsonb language sql stable set search_path = '' as $$
  with event as (
    select event_start, event_end, start_time, end_time from public.roulette_settings where id = 1
  ), matched as (
    select p.telegram_id::text as telegram_id, p.first_name, p.username, count(*) as total_wins
    from public.wjx_spins s join public.wjx_participants p using (telegram_id) cross join event e
    where s.spin_date between e.event_start and e.event_end
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
    select s.spin_date, btrim(s.prize) as prize
    from public.wjx_spins s cross join event e
    where s.telegram_id = p_telegram_id and s.spin_date between e.event_start and e.event_end
      and nullif(btrim(s.prize),'') is not null and btrim(s.prize) <> 'Без выигрыша'
  )
  select jsonb_build_object(
    'participant',jsonb_build_object('telegram_id',p.telegram_id::text,'first_name',p.first_name,'username',p.username),
    'period',(select to_jsonb(e) from event e),
    'total_wins',(select count(*) from wins),
    'prizes',(select coalesce(jsonb_agg(to_jsonb(g) order by g.quantity desc,g.prize),'[]'::jsonb)
      from (select prize,count(*) as quantity from wins group by prize) g),
    'daily',(select coalesce(jsonb_agg(to_jsonb(d) order by d.spin_date,d.prize),'[]'::jsonb)
      from (select spin_date,prize,count(*) as quantity from wins group by spin_date,prize) d)
  ) from public.wjx_participants p where p.telegram_id = p_telegram_id;
$$;

revoke all on function public.wjx_event_winners(text,integer), public.wjx_user_prize_summary(bigint)
  from public, anon, authenticated;
grant execute on function public.wjx_event_winners(text,integer), public.wjx_user_prize_summary(bigint)
  to service_role;
commit;
