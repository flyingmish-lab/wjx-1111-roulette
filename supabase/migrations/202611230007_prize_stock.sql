begin;
-- Add limits without changing existing chances, dates, histories or deliveries.
alter table public.roulette_prize_chances alter column chance type numeric(7,4);
alter table public.roulette_prize_chances
  add column if not exists prize_limit integer check (prize_limit between 0 and 1000000);
-- Seed once only. Reapplying a release must preserve later admin edits, including NULL.
do $seed$
begin
  if not exists (select 1 from pg_trigger where tgname='wjx_enforce_prize_stock' and tgrelid='public.wjx_spins'::regclass) then
    update public.roulette_prize_chances set prize_limit=case prize
      when 'Noir Blade' then 3 when 'Картридж' then 20 when 'Бандажка' then 50
      when 'Soul Ink' then 20 when 'Расходники' then 30 else null end;
  end if;
end;
$seed$;
create index if not exists wjx_spins_prize_stock_idx on public.wjx_spins(prize);

-- Applies to every real spin insert, including the older server RPC.
-- Test spins use a different table and never consume this stock.
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
    select count(*) into v_used from public.wjx_spins where prize=new.prize;
    if v_used>=v_limit then new.prize:='Без выигрыша'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.wjx_enforce_prize_stock() from public,anon,authenticated;
create or replace trigger wjx_enforce_prize_stock before insert on public.wjx_spins
  for each row execute function public.wjx_enforce_prize_stock();

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
  select spins_paused into strict v_paused from public.roulette_settings where id=1 for share;
  if v_paused then raise exception 'Spins paused' using errcode='P0003'; end if;
  v_day := (clock_timestamp() at time zone 'Europe/Moscow')::date;
  if p_is_test then
    v_remaining := public.wjx_use_test_spin(p_telegram_id,p_prize);
    v_result := jsonb_build_object('operationId',p_request_id,'spinDate',v_day,'isTest',true,
      'prize',case when p_prize='Без выигрыша' then null else p_prize end,'testRemaining',v_remaining);
  else
    select * into strict v_saved from public.wjx_save_spin(p_telegram_id,v_day,p_prize);
    -- The stock trigger may replace an exhausted prize with a miss.
    select prize into strict v_actual_prize from public.wjx_spins
      where telegram_id=p_telegram_id and spin_date=v_day and spin_number=v_saved.spin_number;
    v_result := jsonb_build_object('operationId',p_request_id,'spinDate',v_day,'isTest',false,
      'prize',case when v_actual_prize='Без выигрыша' then null else v_actual_prize end,
      'spinNumber',v_saved.spin_number,'spinsRemaining',v_saved.spins_remaining);
  end if;
  -- This row and the spin commit together. Retrying never consumes another attempt.
  insert into public.wjx_spin_operations(telegram_id,request_id,is_test,result)
    values(p_telegram_id,p_request_id,p_is_test,v_result);
  return v_result;
end;
$$;
create or replace function public.wjx_admin_prize_stats()
returns jsonb language sql stable set search_path = '' as $$
  with counts as (
    select prize,count(*) as n from public.wjx_spins group by prize
  ), tests as (
    select prize,count(*) as n from public.wjx_test_spins group by prize
  )
  select jsonb_build_object(
    'prizes',(select coalesce(jsonb_agg(jsonb_build_object(
      'prize',p.prize,'chance',p.chance,'prize_limit',p.prize_limit,
      'realWins',coalesce(c.n,0),'testWins',coalesce(t.n,0),
      'remaining',case when p.prize_limit is null then null else greatest(0,p.prize_limit-coalesce(c.n,0)) end
    ) order by p.prize),'[]'::jsonb)
      from public.roulette_prize_chances p left join counts c using(prize) left join tests t using(prize)),
    'history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id desc),'[]'::jsonb)
      from (select s.id,s.created_at,s.telegram_id,s.spin_date,s.prize,
        coalesce(p.first_name,'Неизвестный участник') as first_name,p.username
        from public.wjx_spins s left join public.wjx_participants p using(telegram_id)
        order by s.created_at desc,s.id desc limit 50) h)
  );
$$;
commit;
