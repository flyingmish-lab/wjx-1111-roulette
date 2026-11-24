-- Requires schema migration 011. Before its first deployment use the previous published export.
-- Read-only application backup. Does not export Supabase Secrets, Auth or Storage.
select 'tables' section, coalesce(jsonb_agg(jsonb_build_object(
  'name',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'sequence',case when a.attidentity<>'' then pg_get_serial_sequence(format('%I.%I',n.nspname,c.relname),a.attname) end) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid),'type',contype)),'[]') from pg_constraint where conrelid=c.oid),
  'indexes',(select coalesce(jsonb_agg(indexdef),'[]') from pg_indexes i where i.schemaname='public' and i.tablename=c.relname and not exists(select 1 from pg_constraint k where k.conindid=(quote_ident(i.schemaname)||'.'||quote_ident(i.indexname))::regclass)),
  'grants',(select coalesce(jsonb_agg(jsonb_build_object('role',grantee,'privilege',privilege_type)),'[]') from information_schema.role_table_grants g where g.table_schema='public' and g.table_name=c.relname)
) order by c.relname),'[]')::text payload from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
union all select 'functions',coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),'signature',p.oid::regprocedure::text,'grants',(select coalesce(jsonb_agg(jsonb_build_object('role',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,'privilege',x.privilege_type)),'[]') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x))),'[]')::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
union all select 'sequences',coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('identity_owned',exists(select 1 from pg_depend d where d.objid=(quote_ident(s.schemaname)||'.'||quote_ident(s.sequencename))::regclass and d.deptype='i'))),'[]')::text from pg_sequences s where schemaname='public'
union all select 'policies',coalesce(jsonb_agg(to_jsonb(p)),'[]')::text from pg_policies p where schemaname='public'
union all select 'data:roulette_settings',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.roulette_settings t
union all select 'data:roulette_prize_chances',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.roulette_prize_chances t
union all select 'data:wjx_participants',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_participants t
union all select 'data:wjx_spins',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_spins t
union all select 'data:wjx_test_spins',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_test_spins t
union all select 'data:wjx_test_balances',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_test_balances t
union all select 'data:wjx_spin_operations',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_spin_operations t
union all select 'data:wjx_prize_deliveries',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_prize_deliveries t
union all select 'data:wjx_admin_login_attempts',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_admin_login_attempts t
union all select 'data:wjx_admin_sessions',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_admin_sessions t
union all select 'data:wjx_admin_prize_resets',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_admin_prize_resets t
union all select 'data:wjx_cancelled_prizes',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_cancelled_prizes t
union all select 'data:wjx_admin_spin_resets',coalesce(jsonb_agg(to_jsonb(t)),'[]')::text from public.wjx_admin_spin_resets t
union all select 'sequence_grants',coalesce(jsonb_agg(jsonb_build_object('sequence',c.relname,'role',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,'privilege',x.privilege_type)),'[]')::text from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) x where n.nspname='public' and c.relkind='S'
union all select 'triggers',coalesce(jsonb_agg(pg_get_triggerdef(t.oid)),'[]')::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal;
