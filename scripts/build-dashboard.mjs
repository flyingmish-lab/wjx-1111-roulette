import fs from 'node:fs';
import path from 'node:path';
const sharedHttp=fs.readFileSync('supabase/functions/_shared/http.ts','utf8').replace(/export /g,'');
const sharedSession=fs.readFileSync('supabase/functions/_shared/admin-session.ts','utf8').replace(/export /g,'').replace(/\bencoder\b/g,'sessionEncoder');
const sharedTelegram=fs.readFileSync('supabase/functions/_shared/telegram-bot.ts','utf8').replace(/export /g,'');
for(const name of ['wjx-admin-auth','wjx-roulette','rapid-action','wjx-telegram-bot']) {
  let source=fs.readFileSync(`supabase/functions/${name}/index.ts`,'utf8');
  source=source.replace(/import\s+[\s\S]*?from\s+"\.\.\/_shared\/[^\"]+";\n/g, match => {
    // An import block may begin before the npm import; preserve that import.
    const npm=match.match(/import[^;]+from "npm:[^\"]+";\n/);
    return npm?.[0]??'';
  });
  const result=`// Generated from supabase/functions by scripts/build-dashboard.mjs\n${sharedHttp}\n${name==='rapid-action'?'':sharedSession}\n${['wjx-roulette','wjx-telegram-bot'].includes(name)?sharedTelegram:''}\n${source}`;
  fs.mkdirSync(`dashboard-dist/${name}`,{recursive:true});fs.writeFileSync(`dashboard-dist/${name}/index.ts`,result);
}
const migrationFiles=fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort();
const sql=migrationFiles.map(n=>fs.readFileSync(path.join('supabase/migrations',n),'utf8').replace(/^begin;\s*/,'').replace(/commit;\s*$/,''));
const counts = "jsonb_build_array((select count(*) from public.wjx_participants),(select count(*) from public.wjx_spins),(select count(*) from public.wjx_test_spins))";
fs.writeFileSync('dashboard-dist/release.sql', `begin;
lock table public.wjx_participants, public.wjx_spins, public.wjx_test_spins in share mode;
do $wjx_release$
declare v_before jsonb;
begin
  select ${counts} into v_before;
${sql.join('\n')}
  if v_before <> ${counts} then raise exception 'Existing counts changed'; end if;
end;
$wjx_release$;
select 'Migration complete; existing rows preserved' as status;
commit;
`);
