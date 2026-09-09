'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
test('replacing an article or dataset clears derived state and rejects an older brainstorm completion',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table engelbart_onboardings(id uuid primary key,user_id uuid,status text default 'open',paper_id uuid,
    dataset_resource jsonb,planning jsonb default '{}',updated_at timestamptz,
    analysis jsonb,analysis_status text,analysis_error text,analysis_started_at timestamptz,
    assets jsonb,assets_brief jsonb,assets_status text,assets_error text,assets_started_at timestamptz,
    leveled jsonb,leveled_status text,leveled_error text,leveled_started_at timestamptz,
    assessment jsonb,asset_chosen jsonb,direction jsonb,subgoals jsonb,todos jsonb);
   create table engelbart_onboarding_calibrations(onboarding_id uuid);
   create table engelbart_onboarding_turns(id uuid default gen_random_uuid(),onboarding_id uuid,user_id uuid,stage text,role text,content text,card jsonb,created_at timestamptz default now());`);
  await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260908070000_brainstorm_opening.sql'),'utf8'));
  await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260909160000_onboarding_sources.sql'),'utf8'));
  const id='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',token='33333333-3333-4333-8333-333333333333';
  await db.query("insert into engelbart_onboardings(id,user_id,source_article,analysis_status,analysis) values($1,$2,$3,'done',$4)",[id,user,{text:'First article'},{title:'First'}]);
  await db.query("insert into engelbart_onboarding_calibrations values($1)",[id]);
  await db.query("select engelbart_brainstorm_opening($1,$2,null,$3)",[user,id,token]);
  await db.query("update engelbart_onboardings set source_article=$1 where id=$2",[{text:'Replacement article'},id]);
  const row=(await db.query('select * from engelbart_onboardings where id=$1',[id])).rows[0];
  assert.equal(row.source_revision,1);assert.equal(row.analysis,null);assert.equal(row.analysis_status,'none');assert.deepEqual(row.planning,{});
  const late=(await db.query("select engelbart_brainstorm_opening($1,$2,null,$3,$4) as result",[user,id,token,{status:'done',content:'Old result'}])).rows[0].result;
  assert.equal(late.status,'superseded');assert.equal((await db.query('select * from engelbart_onboarding_calibrations')).rows.length,0);
  await db.query("update engelbart_onboardings set analysis=$1,analysis_status='done' where id=$2",[{title:'Replacement'},id]);
  await db.query('update engelbart_onboardings set dataset_resource=$1 where id=$2',[{id:'new-dataset'},id]);
  assert.equal((await db.query('select analysis_status from engelbart_onboardings where id=$1',[id])).rows[0].analysis_status,'none');
 } finally {await db.close();}
});
