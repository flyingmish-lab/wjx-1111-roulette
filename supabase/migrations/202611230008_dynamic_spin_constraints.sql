begin;
-- A legacy table CHECK hard-coded 10–12 November 2026. The server RPC already
-- validates the current Moscow date and the event window from roulette_settings
-- in the same transaction. Keep that authoritative schedule check unchanged.
alter table public.wjx_spins drop constraint if exists wjx_event_dates;
-- Match the existing admin setting range (1–20 attempts). wjx_save_spin still
-- enforces each player's configured daily allowance under its advisory lock.
alter table public.wjx_spins drop constraint if exists wjx_spins_spin_number_check;
do $slot_check$
begin
  -- Reapplying an older release must not shrink storage after migration 010.
  if to_regclass('public.wjx_admin_spin_resets') is null then
    alter table public.wjx_spins add constraint wjx_spins_spin_number_check check (spin_number between 1 and 20);
  else
    alter table public.wjx_spins add constraint wjx_spins_spin_number_check check (spin_number between 1 and 32767);
  end if;
end;
$slot_check$;
commit;
