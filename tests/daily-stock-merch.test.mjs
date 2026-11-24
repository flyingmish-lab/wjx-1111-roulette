import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {webcrypto} from 'node:crypto';
import {mockDb,loadFunction,request,telegramData,prizes,env} from './helpers.mjs';
const migration=fs.readFileSync('supabase/migrations/202611230009_daily_stock_and_merch.sql','utf8');
async function setup() {
  const db=new PGlite();
  await db.exec(fs.readFileSync('tests/database.test.mjs','utf8').match(/const fixture=`([\s\S]*?)`;/)[1]);
  // Historical wins predate stock enforcement and must not be modified by it.
  await db.exec("insert into roulette_prize_chances(prize,chance) values('Noir Blade',0),('Soul Ink',0),('Картридж',0),('Бандажка',0),('Расходники',0); insert into wjx_spins(telegram_id,spin_date,spin_number,prize) select 123456789,(clock_timestamp() at time zone 'Europe/Moscow')::date-1,n,'Noir Blade' from generate_series(1,4) n;");
  for(const name of fs.readdirSync('supabase/migrations').sort().filter(n=>!n.includes('230010')&&!n.includes('240011')&&n.endsWith('.sql')&&!n.includes('230009')))await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
  return db;
}
const stats=async db=>(await db.query('select wjx_admin_prize_stats() as x')).rows[0].x;
const insert=(db,prize,offset=0)=>db.query("insert into wjx_spins(telegram_id,spin_date,spin_number,prize) values(123456789,(clock_timestamp() at time zone 'Europe/Moscow')::date+$2::integer,1,$1) returning prize",[prize,offset]).then(r=>r.rows[0].prize);
test('daily migration preserves previous wins, settings, chances and caps; adds merch disabled by chance with daily limit ten',async()=>{
  const db=await setup();try {
    const before=(await db.query('select * from wjx_spins order by id')).rows;
    const settings=(await db.query('select * from roulette_settings')).rows;
    const catalog=(await db.query('select * from roulette_prize_chances order by prize')).rows;
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from wjx_spins order by id')).rows,before);
    assert.deepEqual((await db.query('select * from roulette_settings')).rows,settings);
    assert.deepEqual((await db.query("select * from roulette_prize_chances where prize<>'Мерч WJX' order by prize")).rows,catalog);
    const report=await stats(db),merch=report.prizes.find(p=>p.prize==='Мерч WJX'),noir=report.prizes.find(p=>p.prize==='Noir Blade');
    assert.equal(report.limitScope,'day');
    assert.equal(report.stockDate,(await db.query("select (clock_timestamp() at time zone 'Europe/Moscow')::date::text as d")).rows[0].d);
    assert.equal(merch.chance,0);assert.equal(merch.prize_limit,10);assert.equal(merch.remainingToday,10);
    assert.equal(noir.realWins,4);assert.equal(noir.todayWins,0);assert.equal(noir.remainingToday,3);
    await db.exec("update roulette_prize_chances set chance=0.25,prize_limit=7 where prize='Мерч WJX'");await db.exec(migration);
    const edited=(await stats(db)).prizes.find(p=>p.prize==='Мерч WJX');assert.equal(edited.chance,0.25);assert.equal(edited.prize_limit,7);
    for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_table_privilege($1,'roulette_prize_chances','UPDATE') as x",[role])).rows[0].x,false);
  } finally {await db.close();}
});
test('limits count each Moscow spin date independently, never refill when editing event dates and ignore assigned tests',async()=>{
  const db=await setup();try {
    await db.exec(migration);await db.exec('set role service_role');
    for(let i=0;i<10;i++)assert.equal(await insert(db,'Мерч WJX',-1),'Мерч WJX');
    assert.equal(await insert(db,'Мерч WJX',-1),'Без выигрыша');
    for(let i=0;i<10;i++)assert.equal(await insert(db,'Мерч WJX'),'Мерч WJX');
    assert.equal(await insert(db,'Мерч WJX'),'Без выигрыша');
    let merch=(await stats(db)).prizes.find(p=>p.prize==='Мерч WJX');
    assert.equal(merch.realWins,20);assert.equal(merch.todayWins,10);assert.equal(merch.remainingToday,0);
    await db.exec("update roulette_settings set event_start='2001-01-01'; select wjx_set_test_spins(123456789,1)");
    assert.equal(await insert(db,'Мерч WJX'),'Без выигрыша');
    const uuid=webcrypto.randomUUID();const testSpin=(await db.query("select wjx_perform_spin(123456789,$1,true,'Мерч WJX') as x",[uuid])).rows[0].x;
    assert.equal(testSpin.prize,'Мерч WJX');
    merch=(await stats(db)).prizes.find(p=>p.prize==='Мерч WJX');assert.equal(merch.todayWins,10);assert.equal(merch.testWins,1);
    // A new Moscow date has a fresh allowance even while yesterday's records remain.
    assert.equal(await insert(db,'Мерч WJX',1),'Мерч WJX');
    const results=await Promise.all(Array.from({length:20},()=>insert(db,'Noir Blade')));
    assert.equal(results.filter(p=>p==='Noir Blade').length,3);
    assert.equal(results.filter(p=>p==='Без выигрыша').length,17);
    assert.equal((await stats(db)).prizes.find(p=>p.prize==='Noir Blade').realWins,7);
  } finally {await db.close();}
});
test('merch result, UUID recovery, prize summary and winner report include the new real prize',async()=>{
  const db=await setup();try {
    await db.exec(migration);await db.exec('set role service_role');
    const uuid=webcrypto.randomUUID(),run=()=>db.query("select wjx_perform_spin(123456789,$1,false,'Мерч WJX') as x",[uuid]);
    const first=(await run()).rows[0].x,replay=(await run()).rows[0].x;
    assert.equal(first.prize,'Мерч WJX');assert.deepEqual(first,replay);
    const summary=(await db.query('select wjx_user_prize_summary(123456789) as x')).rows[0].x;
    assert.equal(summary.prizes.find(p=>p.prize==='Мерч WJX').quantity,1);
    const winners=(await db.query("select wjx_event_winners('Player',0) as x")).rows[0].x;
    assert.equal(winners.winners[0].telegram_id,'123456789');
    assert.ok(winners.winners[0].total_wins>=1);
    assert.equal((await stats(db)).prizes.find(p=>p.prize==='Мерч WJX').todayWins,1);
  } finally {await db.close();}
});
test('server supports the rollout catalog, rejects stale admin scope, and rolls merch with validated seven-prize chances',async()=>{
  const db=mockDb(),api=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette;
  const auth=loadFunction('supabase/functions/wjx-admin-auth/index.ts',db).handleAdminAuth;
  const token=(await (await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}))).json()).token;
  assert.equal((await api(request({action:'admin_save_prize_chances',prizes},token))).status,400);
  assert.equal(db.calls.some(c=>c.operation==='upsert'),false);
  const merchOnly=prizes.map(p=>({...p,chance:p.prize==='Мерч WJX'?100:0}));
  assert.equal((await api(request({action:'admin_save_prize_chances',prizes:merchOnly,limitScope:'day'},token))).status,200);
  const initData=await telegramData(123456789);
  const result=await (await api(request({action:'spin',initData}))).json();assert.equal(result.prize,'Мерч WJX');
  db.prizes=prizes.filter(p=>p.prize!=='Мерч WJX').map(p=>({...p}));
  assert.equal((await api(request({action:'spin',initData}))).status,200,'previous six-prize catalog works before additive migration');
});
