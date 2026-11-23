import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {webcrypto} from 'node:crypto';
import {mockDb,loadFunction,request,telegramData,env} from './helpers.mjs';
const uuid=()=>webcrypto.randomUUID();
async function database(){
 const db=new PGlite();await db.exec(fs.readFileSync('tests/database.test.mjs','utf8').match(/const fixture=`([\s\S]*?)`;/)[1]);
 await db.exec("insert into roulette_prize_chances(prize,chance) values('Мерч WJX',0),('Noir Blade',0),('Soul Ink',0),('Бандажка',0),('Картридж',0),('Расходники',0)");
 for(const file of fs.readdirSync('supabase/migrations').sort().filter(f=>f.endsWith('.sql')))await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 return db;
}
const state=async(db,id=123456789)=>(await db.query('select wjx_player_state($1) as x',[id])).rows[0].x;
const spin=async(db,id=123456789,key=uuid(),prize='Мерч WJX')=>(await db.query('select wjx_perform_spin($1,$2,false,$3) as x',[id,key,prize])).rows[0].x;
const reset=async(db,id=123456789,key=uuid())=>(await db.query('select wjx_reset_daily_spins($1,$2,$3) as x',[id,key,'a'.repeat(64)])).rows[0].x;
test('reset restores today allowance while preserving wins, stock, UUID results and audit; retries never reset twice',async()=>{
 const db=await database();try{
  await db.exec("update roulette_prize_chances set prize_limit=2 where prize='Мерч WJX';set role service_role");
  const firstKey=uuid(),first=await spin(db,123456789,firstKey);await spin(db);await spin(db);
  assert.equal((await state(db)).spinsRemaining,0);assert.equal((await state(db)).eventSummary.total_wins,2);
  const saved=(await db.query('select * from wjx_spins order by id')).rows;
  const resetKey=uuid();await reset(db,123456789,resetKey);
  let current=await state(db);assert.equal(current.spinsUsed,0);assert.equal(current.spinsRemaining,3);assert.equal(current.dailyHistory.length,0);assert.equal(current.eventSummary.total_wins,2);
  assert.deepEqual((await db.query('select * from wjx_spins order by id')).rows,saved);
  assert.deepEqual(await spin(db,123456789,firstKey),first);assert.equal((await state(db)).spinsRemaining,3);
  const fourth=await spin(db);assert.equal(fourth.spinNumber,1);assert.equal(fourth.prize,null);assert.equal(fourth.spinsRemaining,2);
  assert.equal((await reset(db,123456789,resetKey)).replayed,true);assert.equal((await state(db)).spinsRemaining,2);
  await spin(db);await spin(db);await assert.rejects(spin(db),e=>e.code==='P0001');
  assert.deepEqual((await db.query("select spin_number from wjx_spins where telegram_id=123456789 order by spin_number")).rows.map(r=>r.spin_number),[1,2,3,4,5,6]);
  const stats=(await db.query('select wjx_admin_prize_stats() as x')).rows[0].x.prizes.find(p=>p.prize==='Мерч WJX');assert.equal(stats.todayWins,2);assert.equal(stats.remainingToday,0);
  const users=(await db.query("select wjx_admin_spin_users('Player',0) as x")).rows[0].x;assert.equal(users.users[0].spins_remaining,0);
  await assert.rejects(reset(db,382749857,resetKey),e=>e.code==='22023');
  assert.equal((await db.query('select count(*)::int as n from wjx_admin_spin_resets')).rows[0].n,1);
  await db.exec('begin');await reset(db);await db.exec('rollback');assert.equal((await state(db)).spinsRemaining,0);
  await reset(db);assert.equal((await state(db)).spinsRemaining,3);assert.equal((await state(db,382749857)).spinsUsed,0);
  for(let cycle=0;cycle<6;cycle++) {for(let n=1;n<=3;n++)assert.equal((await spin(db)).spinNumber,n);await reset(db);}
  assert.ok((await db.query('select max(spin_number) as n from wjx_spins')).rows[0].n>20);
  assert.equal((await state(db)).eventSummary.total_wins,2);
  const audit=(await db.query('select * from wjx_admin_spin_resets order by request_id')).rows;
  await db.exec('reset role');await db.exec(fs.readFileSync('dashboard-dist/release.sql','utf8'));
  assert.equal((await state(db)).spinsRemaining,3);
  assert.equal((await state(db)).eventSummary.total_wins,2);
  assert.deepEqual((await db.query('select * from wjx_admin_spin_resets order by request_id')).rows,audit);
 }finally{await db.close();}
});
test('retired tests are blocked in SQL, history/balances remain, reset never bypasses dates, pause or role permissions',async()=>{
 const db=await database();try{
  await db.exec('reset role');
  // Seed an existing allocation to prove retirement does not spend/delete it.
  await db.exec('insert into wjx_test_balances(telegram_id,remaining) values(123456789,9)');
  const tests=(await db.query('select * from wjx_test_spins order by id')).rows;
  await db.exec('set role service_role');
  await assert.rejects(db.query("select wjx_perform_spin(123456789,$1,true,'Без выигрыша')",[uuid()]),e=>e.code==='22023');
  await assert.rejects(db.query("select wjx_use_test_spin(123456789,'Без выигрыша')"),e=>e.code==='42501');
  await assert.rejects(db.query('select wjx_set_test_spins(123456789,3)'),e=>e.code==='42501');
  await assert.rejects(db.query('update wjx_test_balances set remaining=10 where telegram_id=123456789'),e=>e.code==='42501');
  await assert.rejects(reset(db,999),e=>e.code==='P0002');
  await reset(db);await db.exec('update roulette_settings set spins_paused=true');await assert.rejects(spin(db),e=>e.code==='P0003');
  await db.exec("update roulette_settings set spins_paused=false,event_start='2099-01-01'");await assert.rejects(spin(db),e=>e.code==='P0002');
  assert.deepEqual((await db.query('select * from wjx_test_spins order by id')).rows,tests);assert.equal((await db.query('select remaining from wjx_test_balances where telegram_id=123456789')).rows[0].remaining,9);
  assert.equal('testRemaining' in await state(db),false);
  for(const role of ['anon','authenticated'])for(const fn of ['wjx_reset_daily_spins(bigint,uuid,text)','wjx_admin_spin_users(text,integer)'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as x',[role,fn])).rows[0].x,false);
  assert.equal((await db.query("select has_table_privilege('anon','wjx_admin_spin_resets','SELECT') as x")).rows[0].x,false);
 }finally{await db.close();}
});
test('reset baselines are scoped to the participant and Moscow date',async()=>{
 const db=await database();try{
  await db.exec("insert into wjx_admin_spin_resets(request_id,telegram_id,spin_date,baseline_spin_number,admin_session_hash) values('00000000-0000-4000-8000-000000000001',123456789,(clock_timestamp() at time zone 'Europe/Moscow')::date-1,99,repeat('a',64));set role service_role");
  assert.equal((await state(db)).spinsRemaining,3);await spin(db);await spin(db);await spin(db);
  assert.equal((await state(db)).spinsRemaining,0);await reset(db,382749857);assert.equal((await state(db)).spinsRemaining,0);
  await reset(db);assert.equal((await state(db)).spinsRemaining,3);
 }finally{await db.close();}
});
test('only browser admin resets attempts, invalid requests do not write, old test APIs cannot allocate or spin',async()=>{
 const db=mockDb(),api=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette,auth=loadFunction('supabase/functions/wjx-admin-auth/index.ts',db).handleAdminAuth;
 const token=(await (await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}))).json()).token;
 const body={action:'admin_reset_daily_spins',telegram_id:'123456789',requestId:uuid()};
 for(const initData of [await telegramData(123456789),await telegramData(221535678)])assert.equal((await api(request({...body,initData}))).status,401);
 for(const patch of [{telegram_id:0},{telegram_id:'bad'},{requestId:'bad'}])assert.equal((await api(request({...body,...patch},token))).status,400);
 db.realSpinsUsed=3;assert.equal((await api(request(body,token))).status,200);db.realSpinsUsed++;
 assert.equal((await api(request(body,token))).status,200);assert.equal(db.resets.size,1);
 assert.equal((await api(request({action:'admin_spin_users'},token))).status,200);
 for(const action of ['admin_set_test_spins','admin_test_users'])assert.equal((await api(request({action,telegram_id:'123456789',attempts:3},token))).status,403);
 assert.equal((await api(request({action:'test_spin',initData:await telegramData(123456789)}))).status,403);
 assert.equal(db.calls.some(c=>c.rpc==='wjx_set_test_spins'||c.rpc==='wjx_use_test_spin'),false);
 const audit=db.calls.find(c=>c.rpc==='wjx_reset_daily_spins').args;assert.match(audit.p_admin_session_hash,/^[a-f0-9]{64}$/);
});
