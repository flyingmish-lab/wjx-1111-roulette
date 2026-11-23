// Isolated PostgreSQL/WASM probe. No network, credentials, or production writes.
// Timings describe this local engine, not hosted Supabase throughput/concurrency.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const db = new PGlite();
const fixture = fs.readFileSync('tests/database.test.mjs','utf8').match(/const fixture=`([\s\S]*?)`;/)[1];
const samples = async (n, fn) => {
  const values=[];
  for(let i=0;i<n;i++){const start=performance.now();await fn(i);values.push(performance.now()-start);}
  values.sort((a,b)=>a-b);
  return {n,p50_ms:+values[Math.floor(n*.5)].toFixed(2),p95_ms:+values[Math.floor(n*.95)].toFixed(2),max_ms:+values.at(-1).toFixed(2)};
};
try {
  await db.exec(fixture);
  for(const path of fs.readdirSync('supabase/migrations').sort())await db.exec(fs.readFileSync('supabase/migrations/'+path,'utf8'));
  // Same lookup index observed in production; fixture intentionally has no legacy indexes.
  await db.exec(`create unique index if not exists wjx_spins_unique_per_day on wjx_spins(telegram_id,spin_date,spin_number);
    update roulette_settings set event_start=(clock_timestamp() at time zone 'Europe/Moscow')::date-2,event_end=(clock_timestamp() at time zone 'Europe/Moscow')::date,start_time='00:00',end_time='23:59';
    insert into roulette_prize_chances(prize,chance) values('Soul Ink',0) on conflict(prize) do nothing;
    insert into wjx_participants(telegram_id,first_name,username) select 1000000000+i,'Synthetic','synthetic_'||i from generate_series(1,3000)i;
    insert into wjx_spins(telegram_id,spin_date,spin_number,prize) select 1000000000+i,(clock_timestamp() at time zone 'Europe/Moscow')::date-((i-1)/1000),n,case when i%2=0 then 'Soul Ink' else 'Без выигрыша' end from generate_series(1,3000)i cross join generate_series(1,3)n;
    insert into wjx_spin_operations(telegram_id,request_id,is_test,result)
      select telegram_id,('00000000-0000-4000-8000-'||lpad(id::text,12,'0'))::uuid,false,
      jsonb_build_object('operationId',('00000000-0000-4000-8000-'||lpad(id::text,12,'0'))::uuid,'spinDate',spin_date,'isTest',false,'prize',nullif(prize,'Без выигрыша'),'spinNumber',spin_number,'spinsRemaining',3-spin_number) from wjx_spins;
    analyze wjx_spins; analyze wjx_participants; analyze wjx_spin_operations;`);
  const result={engine:'local PGlite: serialized; not a Supabase load test',seeded_players:3000,seeded_spins:9000};
  for(let i=0;i<10;i++)await db.query('select wjx_player_state($1) as result',[1000000001+i]);
  result.player_state=await samples(500,i=>db.query('select wjx_player_state($1) as result',[1000000001+i%3000]));
  result.winner_search=await samples(25,()=>db.query("select wjx_event_winners('',0) as result"));
  result.stats=await samples(25,()=>db.query('select wjx_admin_prize_stats() as result'));
  result.spin_and_state=await samples(100,async i=>{
    const id=2000000000+i,key=`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
    await db.query('insert into wjx_participants(telegram_id) values($1)',[id]);
    const first=(await db.query('select wjx_perform_spin($1,$2,false,$3) as r',[id,key,'Без выигрыша'])).rows[0].r;
    const retry=(await db.query('select wjx_perform_spin($1,$2,false,$3) as r',[id,key,'Soul Ink'])).rows[0].r;
    assert.deepEqual(retry,first);
    await db.query('select wjx_player_state($1) as result',[id]);
  });
  assert.equal((await db.query('select count(*)::int n from wjx_spins where telegram_id>=2000000000')).rows[0].n,100);
  result.rows=(await db.query('select count(*)::int spins from wjx_spins')).rows[0];
  result.spin_table_bytes=(await db.query("select pg_total_relation_size('wjx_spins')::int bytes")).rows[0].bytes;
  result.operation_table_bytes=(await db.query("select pg_total_relation_size('wjx_spin_operations')::int bytes")).rows[0].bytes;
  result.retry_integrity='100 retries consumed no additional attempts';
  console.log(JSON.stringify(result,null,2));
} finally {await db.close();}
