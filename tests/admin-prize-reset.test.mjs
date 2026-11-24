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
const state=async(db,id=123456789,key=null)=>(await db.query('select wjx_player_state($1,$2) as x',[id,key])).rows[0].x;
const spin=async(db,id=123456789,key=uuid())=>(await db.query("select wjx_perform_spin($1,$2,false,'Мерч WJX') as x",[id,key])).rows[0].x;
const reset=async(db,id=123456789,key=uuid())=>(await db.query('select wjx_reset_user_prizes($1,$2,$3) as x',[id,key,'a'.repeat(64)])).rows[0].x;
test('prize cancellation keeps original history, attempts, deliveries and stock; replay never cancels new wins',async()=>{
 const db=await database();try{
  await db.exec("update roulette_prize_chances set prize_limit=3 where prize='Мерч WJX';set role service_role");
  const op=uuid();await spin(db,123456789,op);await spin(db,382749857);
  await db.exec("reset role;insert into wjx_prize_deliveries(spin_id,admin_session_hash) select id,repeat('a',64) from wjx_spins where telegram_id=123456789;set role service_role");
  const before=(await db.query('select * from wjx_spins order by id')).rows;
  const operations=(await db.query('select * from wjx_spin_operations order by request_id')).rows;
  const deliveries=(await db.query('select * from wjx_prize_deliveries')).rows;
  const key=uuid();assert.equal((await reset(db,123456789,key)).reset_count,1);
  assert.equal((await state(db)).eventSummary.total_wins,0);assert.equal((await state(db)).spinsRemaining,2);
  assert.equal((await state(db)).dailyHistory[0].prize,'Приз сброшен');
  assert.equal((await state(db,382749857)).eventSummary.total_wins,1);
  assert.deepEqual((await db.query('select * from wjx_spins order by id')).rows,before);
  assert.deepEqual((await db.query('select * from wjx_spin_operations order by request_id')).rows,operations);
  assert.deepEqual((await db.query('select * from wjx_prize_deliveries')).rows,deliveries);
  assert.equal((await spin(db,123456789,op)).prizeReset,true);assert.equal((await state(db,123456789,op)).pendingOperation.prize,null);
  const winner=(await db.query("select wjx_event_winners('',0) as x")).rows[0].x;
  assert.deepEqual(winner.winners.map(w=>w.telegram_id),['382749857']);
  await spin(db);assert.equal((await reset(db,123456789,key)).replayed,true);
  assert.equal((await state(db)).eventSummary.total_wins,1,'new win survives repeated old reset UUID');
  assert.equal((await spin(db)).prize,null,'cancelled win still consumes stock');
  const stats=(await db.query('select wjx_admin_prize_stats() as x')).rows[0].x.prizes.find(p=>p.prize==='Мерч WJX');
  assert.equal(stats.remainingToday,0);assert.equal(stats.resetWins,1);
  await assert.rejects(reset(db,382749857,key),e=>e.code==='22023');
  await db.exec('begin');await reset(db);await db.exec('rollback');assert.equal((await state(db)).eventSummary.total_wins,1);
  await db.exec('reset role');await db.exec(fs.readFileSync('dashboard-dist/release.sql','utf8'));
  assert.equal((await state(db)).eventSummary.total_wins,1);
  for(const role of ['anon','authenticated'])for(const fn of ['wjx_reset_user_prizes(bigint,uuid,text)','wjx_visible_operation_result(bigint,uuid)'])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as x",[role,fn])).rows[0].x,false);
 }finally{await db.close();}
});
test('prize resets affect only current configured event and prevent later delivery of cancelled wins',async()=>{
 const db=await database();try{
  await spin(db);
  await db.exec("update roulette_settings set event_start='2000-01-01',event_end='2001-01-01'");
  assert.equal((await reset(db)).reset_count,0);
  await db.exec("update roulette_settings set event_end='2099-12-31'");assert.equal((await state(db)).eventSummary.total_wins,1);
  await reset(db);assert.equal((await state(db)).eventSummary.total_wins,0);
  await db.exec("update roulette_settings set end_time='00:00',event_end=(clock_timestamp() at time zone 'Europe/Moscow')::date-1; update wjx_spins set spin_date=(clock_timestamp() at time zone 'Europe/Moscow')::date-1");
  assert.equal((await db.query("select wjx_mark_prizes_delivered(123456789,repeat('a',64)) as x")).rows[0].x.marked_count,0);
  await assert.rejects(reset(db,999),e=>e.code==='P0002');
  await assert.rejects(db.query('select wjx_reset_user_prizes(123456789,$1,$2)',[uuid(),'bad']),e=>e.code==='22023');
 }finally{await db.close();}
});
test('prize reset API requires browser admin and validated UUID with server session audit',async()=>{
 const db=mockDb(),api=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette,auth=loadFunction('supabase/functions/wjx-admin-auth/index.ts',db).handleAdminAuth;
 const body={action:'admin_reset_user_prizes',telegram_id:'123456789',requestId:uuid()};
 assert.equal((await api(request({...body,initData:await telegramData(221535678)}))).status,401);
 const token=(await (await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}))).json()).token;
 for(const patch of [{telegram_id:0},{telegram_id:'bad'},{requestId:'bad'}])assert.equal((await api(request({...body,...patch},token))).status,400);
 db.eventWinCount=2;assert.equal((await (await api(request(body,token))).json()).reset_count,2);
 db.eventWinCount=1;assert.equal((await api(request(body,token))).status,200);assert.equal(db.eventWinCount,1);
 assert.match(db.calls.find(c=>c.rpc==='wjx_reset_user_prizes').args.p_admin_session_hash,/^[a-f0-9]{64}$/);
});
