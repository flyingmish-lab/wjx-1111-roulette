import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {env,mockDb,loadFunction,request,prizes} from './helpers.mjs';
const migration=fs.readFileSync('supabase/migrations/202611230007_prize_stock.sql','utf8');
async function database() {
  const db=new PGlite();
  await db.exec(fs.readFileSync('tests/database.test.mjs','utf8').match(/const fixture=`([\s\S]*?)`;/)[1]);
  await db.exec('alter table roulette_prize_chances alter column chance type numeric(5,2)');
  for(const file of fs.readdirSync('supabase/migrations').sort().filter(f=>!f.includes('230010')&&!f.includes('240011')&&f.endsWith('.sql')&&!f.includes('230007')&&!f.includes('230009')))await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  await db.exec("insert into roulette_prize_chances(prize,chance) values ('Noir Blade',0),('Картридж',0),('Бандажка',0),('Soul Ink',0),('Расходники',0); insert into wjx_spins(telegram_id,spin_date,spin_number,prize) values(123456789,'2020-01-01',1,'Noir Blade');");
  return db;
}
const spin=(db,id,prize='Noir Blade',isTest=false,uuid=webcrypto.randomUUID())=>db.query('select wjx_perform_spin($1,$2,$3,$4) as result',[id,uuid,isTest,prize]).then(r=>r.rows[0].result);
test('stock migration preserves game records and configured chances; repeated application retains admin edits',async()=>{
  const db=await database();try {
    const before=await db.query('select * from wjx_spins order by id');
    const chances=await db.query('select prize,chance::double precision as chance from roulette_prize_chances order by prize');
    await db.exec(migration);
    assert.deepEqual(await db.query('select * from wjx_spins order by id'),before);
    assert.deepEqual(await db.query('select prize,chance::double precision as chance from roulette_prize_chances order by prize'),chances);
    await db.exec("update roulette_prize_chances set chance=0.0333 where prize='Noir Blade'");
    assert.equal(Number((await db.query("select chance from roulette_prize_chances where prize='Noir Blade'")).rows[0].chance),0.0333);
    const stats=(await db.query('select wjx_admin_prize_stats() as x')).rows[0].x;
    const noir=stats.prizes.find(p=>p.prize==='Noir Blade');
    assert.equal(noir.prize_limit,3);assert.equal(noir.realWins,1);assert.equal(noir.remaining,2);
    await db.exec("update roulette_prize_chances set prize_limit=null where prize='Noir Blade'; update roulette_prize_chances set prize_limit=7 where prize='Soul Ink';");
    await db.exec(migration);
    assert.equal((await db.query("select prize_limit from roulette_prize_chances where prize='Noir Blade'")).rows[0].prize_limit,null);
    assert.equal((await db.query("select prize_limit from roulette_prize_chances where prize='Soul Ink'")).rows[0].prize_limit,7);
    for(const role of ['anon','authenticated']) {
      assert.equal((await db.query("select has_table_privilege($1,'roulette_prize_chances','UPDATE') as x",[role])).rows[0].x,false);
      assert.equal((await db.query("select has_function_privilege($1,'wjx_enforce_prize_stock()','EXECUTE') as x",[role])).rows[0].x,false);
    }
    await assert.rejects(db.exec("update roulette_prize_chances set prize_limit=-1 where prize='Noir Blade'"),/check constraint/);
  } finally {await db.close();}
});
test('100 queued independent spins cannot exceed stock; response, history and idempotent recovery agree',async()=>{
  const db=await database();try {
    await db.exec(migration);
    // PGlite queues calls on a single connection: this checks limits, not cloud concurrency.
    const ids=Array.from({length:100},(_,i)=>700000+i);
    await db.query('insert into wjx_participants(telegram_id) select unnest($1::bigint[])',[ids.concat([800000,800001,800002,800003,800004])]);
    const results=await Promise.all(ids.map(id=>spin(db,id)));
    assert.equal(results.filter(r=>r.prize==='Noir Blade').length,2);
    assert.equal(results.filter(r=>r.prize===null).length,98);
    assert.equal((await db.query("select count(*)::int as n from wjx_spins where prize='Noir Blade'")).rows[0].n,3);
    for(let i=0;i<results.length;i++) {
      assert.equal(results[i].spinsRemaining,2);
      const replay=await spin(db,ids[i],'Расходники',false,results[i].operationId);
      assert.deepEqual(replay,results[i]);
    }
    assert.equal((await db.query('select count(*)::int as n from wjx_spins')).rows[0].n,101);
    await db.exec("update roulette_settings set event_start='2001-01-01'; update roulette_prize_chances set prize_limit=0 where prize='Soul Ink';");
    assert.equal((await spin(db,800000)).prize,null,'date edit does not refill Noir stock');
    assert.equal((await spin(db,800001,'Soul Ink')).prize,null);
    await db.exec("update roulette_prize_chances set prize_limit=null where prize='Расходники'");
    assert.equal((await spin(db,800002,'Расходники')).prize,'Расходники');
    await db.exec('begin');await spin(db,800003,'Бандажка');await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int as n from wjx_spins where prize='Бандажка'")).rows[0].n,0);
    // Even the older server save RPC must pass through the same stock guard.
    await db.query("select wjx_save_spin(800004,(clock_timestamp() at time zone 'Europe/Moscow')::date,'Noir Blade')");
    assert.equal((await db.query('select prize from wjx_spins where telegram_id=800004')).rows[0].prize,'Без выигрыша');
  } finally {await db.close();}
});
test('assigned tests can draw an exhausted prize without reducing real stock or altering saved real results',async()=>{
  const db=await database();try {
    await db.exec(migration);
    await db.exec("update roulette_prize_chances set prize_limit=1 where prize='Noir Blade'; select wjx_set_test_spins(123456789,2);");
    assert.equal((await spin(db,123456789,'Noir Blade',true)).prize,'Noir Blade');
    const actual=await spin(db,123456789);assert.equal(actual.prize,null);
    const stats=(await db.query('select wjx_admin_prize_stats() as x')).rows[0].x.prizes.find(p=>p.prize==='Noir Blade');
    assert.equal(stats.realWins,1);assert.equal(stats.testWins,1);assert.equal(stats.remaining,0);
    await db.exec("update roulette_prize_chances set prize_limit=10 where prize='Noir Blade'");
    assert.deepEqual(await spin(db,123456789,'Noir Blade',false,actual.operationId),actual);
  } finally {await db.close();}
});
test('only password admin can save integer caps; omitted caps preserve existing values; invalid requests do not write',async()=>{
  const db=mockDb(),api=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette;
  const auth=loadFunction('supabase/functions/wjx-admin-auth/index.ts',db).handleAdminAuth;
  const login=await (await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}))).json();
  const capped=prizes.map(p=>({...p,prize_limit:p.prize==='Без выигрыша'?null:3}));
  assert.equal((await api(request({action:'admin_save_prize_chances',limitScope:'day',prizes:capped}))).status,401);
  assert.equal((await api(request({action:'admin_save_prize_chances',limitScope:'day',prizes:capped},login.token))).status,200);
  assert.equal(db.prizes.find(p=>p.prize==='Noir Blade').prize_limit,3);
  const invalid=[-1,1.5,1000001,'3',true];
  const writes=()=>db.calls.filter(c=>c.operation==='upsert').length;
  const before=writes();
  for(const cap of invalid)assert.equal((await api(request({action:'admin_save_prize_chances',limitScope:'day',prizes:capped.map(p=>p.prize==='Noir Blade'?{...p,prize_limit:cap}:p)},login.token))).status,400);
  assert.equal((await api(request({action:'admin_save_prize_chances',limitScope:'day',prizes:capped.map(p=>({...p,prize_limit:0}))},login.token))).status,400);
  const mixed=capped.map(p=>({...p}));delete mixed[0].prize_limit;
  assert.equal((await api(request({action:'admin_save_prize_chances',limitScope:'day',prizes:mixed},login.token))).status,400);
  assert.equal(writes(),before);
  assert.equal((await api(request({action:'admin_save_prize_chances',limitScope:'day',prizes:prizes.map(({prize,chance})=>({prize,chance}))},login.token))).status,200);
  assert.equal(db.prizes.find(p=>p.prize==='Noir Blade').prize_limit,3);
});
