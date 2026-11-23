// Restores a captured application snapshot ONLY into an isolated in-memory database.
// Does not connect to Supabase. Snapshot bytes and generated restore SQL stay private.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const source=process.argv[2];if(!source)throw Error('Pass snapshot path');
const b=JSON.parse(fs.readFileSync(source,'utf8'));
assert.equal(b.format,'wjx-public-schema-v1');
const qi=s=>'"'+String(s).replaceAll('"','""')+'"';
const ql=s=>"'"+String(s).replaceAll("'","''")+"'";
const tableName=t=>'public.'+qi(t.name);
const sql=['begin;','set check_function_bodies = false;'];
for(const s of b.sequences.filter(s=>!s.identity_owned))sql.push(`create sequence public.${qi(s.sequencename)} as ${s.data_type} start ${s.start_value} increment ${s.increment_by};`);
for(const t of b.tables) {
  assert.ok(Array.isArray(b['data:'+t.name]));
  const columns=t.columns.map(c=>{
    if(c.generated)throw Error('Generated columns require explicit backup support');
    return qi(c.name)+' '+c.type+(c.identity?` generated ${c.identity==='a'?'always':'by default'} as identity (sequence name ${c.sequence})`:c.default?' default '+c.default:'')+(c.notnull?' not null':'');
  });
  sql.push(`create table ${tableName(t)} (${columns.join(',')});`);
}
for(const t of b.tables)if(b['data:'+t.name].length)sql.push(`insert into ${tableName(t)} overriding system value select * from jsonb_populate_recordset(null::${tableName(t)},${ql(JSON.stringify(b['data:'+t.name]))}::jsonb);`);
for(const type of ['p','u','c','f','x'])for(const t of b.tables)for(const c of t.constraints.filter(c=>c.type===type))sql.push(`alter table ${tableName(t)} add constraint ${qi(c.name)} ${c.definition};`);
for(const t of b.tables)for(const index of t.indexes)sql.push(index+';');
for(const fn of b.functions)sql.push(fn.definition+';');
for(const trigger of b.triggers||[])sql.push(trigger+';');
for(const t of b.tables) {
  sql.push(`revoke all on ${tableName(t)} from public,anon,authenticated;`);
  for(const g of t.grants)sql.push(`grant ${g.privilege} on ${tableName(t)} to ${g.role==='PUBLIC'?'public':qi(g.role)};`);
  if(t.rls)sql.push(`alter table ${tableName(t)} enable row level security;`);
  if(t.force_rls)sql.push(`alter table ${tableName(t)} force row level security;`);
}
for(const p of b.policies)sql.push(`create policy ${qi(p.policyname)} on public.${qi(p.tablename)} as ${p.permissive} for ${p.cmd} to ${p.roles.map(r=>r==='public'?'public':qi(r)).join(',')}${p.qual?' using ('+p.qual+')':''}${p.with_check?' with check ('+p.with_check+')':''};`);
for(const fn of b.functions){sql.push(`revoke all on function ${fn.signature} from public,anon,authenticated;`);for(const g of fn.grants)sql.push(`grant ${g.privilege} on function ${fn.signature} to ${g.role==='PUBLIC'?'public':qi(g.role)};`);}
for(const g of b.sequence_grants||[])sql.push(`grant ${g.privilege} on sequence public.${qi(g.sequence)} to ${g.role==='PUBLIC'?'public':qi(g.role)};`);
for(const s of b.sequences)if(s.last_value!=null)sql.push(`select setval(${ql('public.'+s.sequencename)},${s.last_value},true);`);
sql.push('commit;');
const restore=sql.join('\n');
const roles=new Set(['anon','authenticated','service_role']);for(const t of b.tables)for(const g of t.grants)if(g.role!=='PUBLIC'&&g.role!=='postgres')roles.add(g.role);for(const fn of b.functions)for(const g of fn.grants)if(g.role!=='PUBLIC'&&g.role!=='postgres')roles.add(g.role);
for(const g of b.sequence_grants||[])if(g.role!=='PUBLIC'&&g.role!=='postgres')roles.add(g.role);
const db=new PGlite();
try {
  for(const role of roles)await db.exec(`create role ${qi(role)}${role==='service_role'?' bypassrls':''};`);
  await db.exec(restore);
  // Compare canonical JSON inside PostgreSQL, avoiding JS timestamp/number coercion.
  for(const t of b.tables){const result=await db.query(`select (select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]') from ${tableName(t)} r)=(select coalesce(jsonb_agg(v order by v::text),'[]') from jsonb_array_elements($1::jsonb) v) as equal`,[JSON.stringify(b['data:'+t.name])]);assert.equal(result.rows[0].equal,true,'Restored content mismatch: '+t.name);}
  const root=path.dirname(source);fs.writeFileSync(path.join(root,'restore-public-schema.sql'),restore,{mode:0o600});
  const report={scope:b.scope,verifiedAt:new Date().toISOString(),tables:b.tables.length,functions:b.functions.length,tableRows:Object.fromEntries(b.tables.map(t=>[t.name,b['data:'+t.name].length])),restore:'Exact table contents restored in isolated PGlite; constraints, indexes, functions, RLS and grants recreated',limitations:'Application/public schema only. No Supabase Secrets, Auth, Storage or platform configuration. Not a pg_dump replacement for the entire Supabase project.'};
  fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({restoredTables:b.tables.length,functions:b.functions.length,verified:true}));
} finally {await db.close();}
