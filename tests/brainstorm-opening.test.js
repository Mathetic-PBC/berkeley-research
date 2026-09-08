"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
let db;
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table engelbart_onboardings(id uuid primary key,user_id uuid,status text default 'open',
      paper_id uuid,step integer default 7,planning jsonb default '{}',updated_at timestamptz);
    create table engelbart_onboarding_calibrations(onboarding_id uuid);
    create table engelbart_onboarding_turns(id uuid default gen_random_uuid(),onboarding_id uuid,
      user_id uuid,stage text,role text,content text,card jsonb,created_at timestamptz default now());`);
  await db.exec(fs.readFileSync(require.resolve("../supabase/migrations/20260908070000_brainstorm_opening.sql"),"utf8"));
});
after(async () => db.close());
async function fixture() {
  const user=crypto.randomUUID(), id=crypto.randomUUID(), paper=crypto.randomUUID(), token=crypto.randomUUID();
  await db.query("insert into engelbart_onboardings(id,user_id,paper_id) values ($1,$2,$3)",[id,user,paper]);
  return {id,user,paper,token,
    async call(save=null,retry=false,overrides={}) {
      const p={user,id,paper,token,...overrides};
      return (await db.query("select engelbart_brainstorm_opening($1,$2,$3,$4,$5,$6) as result",
        [p.user,p.id,p.paper,p.token,save,retry])).rows[0].result;
    }};
}
const saved={status:"done",content:"Choose a comparison",card:{card:"questions",ready:false,questions:{items:[{id:"a",title:"Which result?"}]}}};
test("two callers share one claim; the persisted card survives reload, retries and Topic changes",async()=>{
  const f=await fixture();
  const results=await Promise.all([f.call(),f.call(null,false,{token:crypto.randomUUID()})]);
  assert.deepEqual(results.map(r=>r.status),["claimed","running"]);
  const done=await f.call(saved);
  assert.equal(done.status,"done");
  assert.deepEqual(done.turn.card,saved.card);
  assert.equal((await f.call(null,true)).turn.id,done.turn.id);
  assert.equal((await f.call(saved)).turn.id,done.turn.id,"duplicate completion is idempotent");
  const rows=await db.query("select * from engelbart_onboardings where id=$1",[f.id]);
  assert.equal(rows.rows[0].step,7,"prewarm must not move the user off Topics");
  assert.equal((await db.query("select * from engelbart_onboarding_turns where onboarding_id=$1",[f.id])).rows.length,1);
});
test("expired claims recover; an old request cannot save over its successor",async()=>{
  const f=await fixture(); await f.call();
  await db.query("update engelbart_onboardings set planning=jsonb_set(planning,'{brainstorm_initial,lease_until}',to_jsonb('2000-01-01'::text)) where id=$1",[f.id]);
  const next=crypto.randomUUID();
  assert.equal((await f.call(null,false,{token:next})).status,"claimed");
  assert.equal((await f.call(saved)).status,"superseded");
  assert.equal((await f.call(saved,false,{token:next})).status,"done");
});
test("errors persist until explicit retry, and replacing the paper invalidates claims and turns",async()=>{
  const f=await fixture(); await f.call();
  await f.call({status:"error",error:"timeout"});
  assert.equal((await f.call()).status,"error");
  assert.equal((await f.call(null,true)).status,"claimed");
  const paper=crypto.randomUUID();
  await db.query("update engelbart_onboardings set paper_id=$1 where id=$2",[paper,f.id]);
  assert.equal((await f.call(saved)).status,"superseded");
  assert.equal((await f.call(null,false,{paper})).status,"claimed");
  await f.call(saved,false,{paper});
  await db.query("update engelbart_onboardings set paper_id=$1 where id=$2",[crypto.randomUUID(),f.id]);
  assert.equal((await db.query("select * from engelbart_onboarding_turns where onboarding_id=$1",[f.id])).rows.length,0);
});
test("a different user cannot claim an onboarding",async()=>{
  const f=await fixture();
  assert.equal((await f.call(null,false,{user:crypto.randomUUID()})).status,"superseded");
});
