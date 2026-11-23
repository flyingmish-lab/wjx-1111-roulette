import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {webcrypto} from 'node:crypto';
const migration=fs.readFileSync('supabase/migrations/202611230008_dynamic_spin_constraints.sql','utf8');
async function setup() {
  const db=new PGlite();
  await db.exec(fs.readFileSync('tests/database.test.mjs','utf8').match(/const fixture=`([\s\S]*?)`;/)[1]);
  for(const file of fs.readdirSync('supabase/migrations').sort().filter(f=>!f.includes('230010')&&f.endsWith('.sql')&&!f.includes('230008')))await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  await db.exec("alter table wjx_spins add constraint wjx_event_dates check(spin_date between '2026-11-10' and '2026-11-12'); alter table wjx_spins add constraint wjx_spins_spin_number_check check(spin_number between 1 and 3);");
  return db;
}
const spin=(db,uuid=webcrypto.randomUUID())=>db.query("select wjx_perform_spin(123456789,$1,false,'Без выигрыша') as result",[uuid]).then(r=>r.rows[0].result);
test('legacy live date constraint reproduces failed real spins; migration enables the configured date with the same UUID',async()=>{
  const db=await setup();try {
    const uuid=webcrypto.randomUUID();
    await db.exec('set role service_role');
    await assert.rejects(spin(db,uuid),e=>e.code==='23514'&&e.constraint==='wjx_event_dates');
    assert.equal((await db.query('select count(*)::int as n from wjx_spins')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from wjx_spin_operations')).rows[0].n,0);
    await db.exec('reset role');await db.exec(migration);await db.exec(migration);
    await db.exec('set role service_role');
    const result=await spin(db,uuid);assert.equal(result.spinNumber,1);assert.equal(result.spinsRemaining,2);
    assert.deepEqual(await spin(db,uuid),result);
    assert.equal((await db.query('select count(*)::int as n from wjx_spins')).rows[0].n,1);
    await db.exec("update roulette_settings set event_start='2099-01-01'");
    await assert.rejects(spin(db),e=>e.code==='P0002');
    await db.exec("update roulette_settings set event_start='2000-01-01',event_end='2001-01-01'");
    await assert.rejects(spin(db),e=>e.code==='P0002');
    assert.equal((await db.query('select count(*)::int as n from wjx_spins')).rows[0].n,1);
  } finally {await db.close();}
});
test('configured daily allowance can exceed three while pause, stock, access and persisted records remain protected',async()=>{
  const db=await setup();try {
    await db.exec("insert into wjx_spins(telegram_id,spin_date,spin_number,prize) values(123456789,'2026-11-10',1,'Без выигрыша')");
    const before=(await db.query('select * from wjx_spins')).rows;
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from wjx_spins')).rows,before);
    await db.exec('set role service_role; update roulette_settings set daily_spins=5');
    for(let i=1;i<=5;i++)assert.equal((await spin(db)).spinNumber,i);
    await assert.rejects(spin(db),e=>e.code==='P0001');
    await db.exec('update roulette_settings set daily_spins=6,spins_paused=true');
    await assert.rejects(spin(db),e=>e.code==='P0003');
    await db.exec('reset role');
    await assert.rejects(db.query("insert into wjx_spins(telegram_id,spin_date,spin_number,prize) values(123456789,current_date,21,'Без выигрыша')"),e=>e.code==='23514');
    for(const role of ['anon','authenticated']) {
      assert.equal((await db.query("select has_table_privilege($1,'wjx_spins','INSERT') as x",[role])).rows[0].x,false);
      assert.equal((await db.query("select has_function_privilege($1,'wjx_save_spin(bigint,date,text)','EXECUTE') as x",[role])).rows[0].x,false);
    }
    assert.equal((await db.query('select remaining from wjx_test_balances where telegram_id=123456789')).rows.length,0);
  } finally {await db.close();}
});
