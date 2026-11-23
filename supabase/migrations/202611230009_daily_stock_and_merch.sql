begin;
-- Preserve all existing limits, chances and game records. Their limit scope
-- becomes one Moscow calendar day. Test spins remain in their separate table.
insert into public.roulette_prize_chances(prize,chance,prize_limit)
  values('Мерч WJX',0,10) on conflict(prize) do nothing;
create index if not exists wjx_spins_prize_day_stock_idx on public.wjx_spins(prize,spin_date);
create or replace function public.wjx_enforce_prize_stock()
returns trigger language plpgsql volatile set search_path = '' as $$
declare v_limit integer; v_used bigint;
begin
  if new.prize='Без выигрыша' then return new; end if;
  select prize_limit into strict v_limit from public.roulette_prize_chances
    where prize=new.prize for update;
  if v_limit is not null then
    -- Serialize awards of this prize; also force a serialization error for stale
    -- REPEATABLE READ snapshots instead of allowing them to exceed stock.
    update public.roulette_prize_chances set prize_limit=prize_limit where prize=new.prize;
    select count(*) into v_used from public.wjx_spins
      where prize=new.prize and spin_date=new.spin_date;
    if v_used>=v_limit then new.prize:='Без выигрыша'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.wjx_enforce_prize_stock() from public,anon,authenticated;
create or replace trigger wjx_enforce_prize_stock before insert on public.wjx_spins
  for each row execute function public.wjx_enforce_prize_stock();

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
      'realWins',coalesce(c.n,0),'todayWins',coalesce(d.n,0),'testWins',coalesce(t.n,0),
      'remainingToday',case when p.prize_limit is null then null else greatest(0,p.prize_limit-coalesce(d.n,0)) end,
      'remaining',case when p.prize_limit is null then null else greatest(0,p.prize_limit-coalesce(d.n,0)) end
    ) order by p.prize),'[]'::jsonb)
      from public.roulette_prize_chances p left join counts c using(prize) left join today d using(prize) left join tests t using(prize)),
    'history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id desc),'[]'::jsonb)
      from (select s.id,s.created_at,s.telegram_id,s.spin_date,s.prize,
        coalesce(p.first_name,'Неизвестный участник') as first_name,p.username
        from public.wjx_spins s left join public.wjx_participants p using(telegram_id)
        order by s.created_at desc,s.id desc limit 50) h)
  );
$$;
commit;
