begin;
-- A legacy table CHECK hard-coded 10–12 November 2026. The server RPC already
-- validates the current Moscow date and the event window from roulette_settings
-- in the same transaction. Keep that authoritative schedule check unchanged.
alter table public.wjx_spins drop constraint if exists wjx_event_dates;
-- Match the existing admin setting range (1–20 attempts). wjx_save_spin still
-- enforces each player's configured daily allowance under its advisory lock.
alter table public.wjx_spins drop constraint if exists wjx_spins_spin_number_check;
alter table public.wjx_spins add constraint wjx_spins_spin_number_check
  check (spin_number between 1 and 20);
commit;
