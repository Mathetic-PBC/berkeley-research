"use strict";
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const Plan = require('../api/_lib/resumable-plan');
const G = require('../api/_lib/plan-evidence');
const Budget = require('../api/_lib/request-budget');
let db;
const user = { id: '11111111-1111-1111-1111-111111111111' };
const credentials = { apiKey:'fixture', baseUrl:'https://model.invalid', models:['all-proxy-models'] };
const grounding = G.normalize({ contribution:'Transform instructions into exercise loops', evidence:[{kind:'method',claim:'Map repetitions to a loop bound',quote:'We map repetitions to the loop bound',location:'Methods'}],limits:'One worked example only' });
const basis = { evidenceIds:['p1'],reproduce:'Reconstruct the worked loop',interrogate:'Change repetitions and compare bounds',extend:'After comparison try another phrase',limitation:'No empirical validation' };
const draft = { title:'Reconstruct one exercise loop',what_you_would_make:'Transform one instruction and compare its loop bound.',why_it_fits:'A worked mechanism',uses:['Code'],first_visible_result:'A loop',paperBasis:basis };
const positive = {grounded:true,actionable:true,mechanismFirst:true,resourceHonest:true,progression:true};
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table engelbart_onboardings (id uuid primary key,user_id uuid,status text default 'open',step integer default 9,
      source_revision bigint,paper_id uuid,source_article jsonb,dataset_resource jsonb,analysis jsonb,asset_chosen jsonb,assets jsonb,leveled jsonb,interest text,assessment jsonb,
      name text,year text,major text,depth text,project_url text,repo_url text,direction jsonb,subgoals jsonb,todos jsonb,
      project_name text,goal_chosen text,updated_at timestamptz);
    create table engelbart_onboarding_turns(onboarding_id uuid,user_id uuid,stage text,role text,content text,card jsonb);`);
  await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260908050000_resumable_planning.sql'),'utf8'));
  await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260908080000_background_paper_grounding.sql'),'utf8'));
  await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260908230000_longer_planning_leases.sql'),'utf8'));
});
after(async () => db.close());
async function fixture({ grounded=true, model }={}) {
  const id = crypto.randomUUID(), paper=crypto.randomUUID();
  const analysis = {title:'Exercise instructions',one_liner:'Map instructions to loops',...(grounded?{grounding}:{})};
  const asset = {title:'Code',type:'code'};
  await db.query('insert into engelbart_onboardings (id,user_id,paper_id,analysis,asset_chosen) values ($1,$2,$3,$4,$5)',[id,user.id,paper,analysis,asset]);
  const calls=[];
  const options={ env:{ SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'service',SUPABASE_ANON_KEY:'anon' }, fetchImpl:async(url,init)=>{
    if (url.includes('/rpc/')) {
      const b=JSON.parse(init.body);
      assert.ok(!url.includes('engelbart_grounding_transition'), 'no retired job RPC');
      const result=await db.query('select engelbart_plan_transition($1,$2,$3,$4,$5,$6,$7,$8,$9) as value',
        [b.p_user,b.p_id,b.p_kind,b.p_context,b.p_initial,b.p_token,b.p_save??null,b.p_updates??{},b.p_retry??false]);
      return {ok:true,status:200,text:async()=>JSON.stringify(result.rows[0].value)};
    }
    assert.ok(!url.includes('/storage/'), 'planning never downloads the full PDF');
    const b=JSON.parse(init.body);calls.push(b);
    const prompt=b.messages[0].content.map(v=>v.text||'').join('\n');
    const answer = model ? await model(prompt,calls.length) : /Return only \{grounding:/.test(prompt) ? {grounding} : /Validate this/.test(prompt) ? positive : draft;
    return {ok:true,status:200,json:async()=>({content:[{type:'text',text:JSON.stringify(answer)}]})};
  }};
  const row=async()=>(await db.query('select * from engelbart_onboardings where id=$1',[id])).rows[0];
  const step=async(body={})=>{const r=await row();return Plan.advance(user,r,{kind:'direction',...body},
    {reader:{},paper:{...r.analysis},asset:r.asset_chosen,turns:[],direction:r.direction,subgoal:r.subgoals?.[0],resources:[r.asset_chosen]},credentials,options);};
  return {id,calls,row,step,options};
}
test('Analysis-only planning persists draft and review with zero full-PDF reads',async()=>{
  const f=await fixture({grounded:false});
  for (const stage of ['draft','review','ready']) {
    const count=f.calls.length;const out=await f.step();assert.equal(out.stage,stage);assert.ok(f.calls.length-count<=1);
  }
  assert.equal(f.calls.length,2);assert.deepEqual((await f.row()).direction,{...draft,paperBasis:null});
  assert.equal((await f.step()).status,'complete');assert.equal(f.calls.length,2);
});
test('a review timeout preserves the draft and retries only review',async()=>{
  let timeout=true;
  const f=await fixture({model:prompt=>{if(/Validate this/.test(prompt)){if(timeout)throw new DOMException('slow','TimeoutError');return positive;}return draft;}});
  await f.step();await f.step();
  const error=await f.step();assert.equal(error.error.type,'timeout');assert.equal(error.stage,'review');
  assert.equal((await f.row()).planning.direction.draft.title,draft.title);
  timeout=false;assert.equal((await f.step({retry:true})).status,'complete');
  assert.equal(f.calls.filter(c=>/Validate this/.test(JSON.stringify(c))).length,2);
  assert.equal(f.calls.length,3);
});
test('concurrent duplicate requests share a lease; stale paper results cannot commit',async()=>{
  let release,arrive;const hold=new Promise(r=>release=r),arrived=new Promise(r=>arrive=r);
  const f=await fixture({model:async()=>{arrive();await hold;return draft;}});
  await f.step();const running=f.step();await arrived;
  assert.ok(Date.parse((await f.row()).planning.direction.lease_until)-Date.now()>300000);
  assert.equal((await f.step()).status,'running');assert.equal(f.calls.length,1);
  await db.query('update engelbart_onboardings set paper_id=$2 where id=$1',[f.id,crypto.randomUUID()]);
  release();await assert.rejects(running,/discarded/);assert.equal((await f.row()).direction,null);
});
test('expired leases resume; an old lease token cannot overwrite a newer draft',async()=>{
  const f=await fixture();await f.step();
  const r=await f.row(),args=[user.id,r.id,'direction',Plan.contextOf(r,'direction'),r.planning.direction,crypto.randomUUID(),null,{},false];
  const first=(await db.query('select engelbart_plan_transition($1,$2,$3,$4,$5,$6,$7,$8,$9) as j',args)).rows[0].j;
  assert.equal(first.status,'claimed');
  await db.query("update engelbart_onboardings set planning=jsonb_set(planning,'{direction,lease_until}',to_jsonb((now()-interval '1 minute')::text)) where id=$1",[r.id]);
  assert.equal((await f.step()).stage,'review');
  args[6]={...first.job,status:'complete',stage:'ready'};args[7]={direction:{title:'stale'}};
  const saved=(await db.query('select engelbart_plan_transition($1,$2,$3,$4,$5,$6,$7,$8,$9) as j',args)).rows[0].j;
  assert.equal(saved.status,'superseded');assert.equal((await f.row()).direction,null);
});
test('rejections allow one saved correction, then require a new proposal',async()=>{
  const f=await fixture({model:p=>/Validate this/.test(p)?{...positive,grounded:false,reason:'Unsupported outcome'}:draft});
  await f.step();await f.step();assert.equal((await f.step()).stage,'correction');
  await f.step();assert.equal((await f.step()).error.type,'rejected');
  const count=f.calls.length;assert.equal((await f.step({retry:true})).status,'error');assert.equal(f.calls.length,count);
  assert.equal((await f.step({regenerate:true,request_id:'new-proposal-1'})).stage,'draft');
});
test('SQL ownership prevents claiming another member’s job',async()=>{
  const f=await fixture();const r=await f.row();
  const out=await db.query('select engelbart_plan_transition($1,$2,$3,$4,$5,$6) as j',[crypto.randomUUID(),r.id,'direction',{}, {},crypto.randomUUID()]);
  assert.equal(out.rows[0].j.status,'superseded');
});
test('request budgets reserve persistence time and never extend a caller deadline',()=>{
  const now=Date.now();const options={deadlineAt:now+15000};assert.ok(Budget.timeout(options,90000)<=5000);
  assert.throws(()=>Budget.timeout({deadlineAt:now+9000}),{code:'STEP_TIMEOUT'});
  const controller=new AbortController();const signal=Budget.signal({...options,signal:controller.signal},90000);controller.abort();assert.equal(signal.aborted,true);
});

test('a real deadline abort leaves enough time to persist a retryable review',async()=>{
  const f=await fixture();await f.step();await f.step();
  const base=f.options.fetchImpl;
  f.options.deadlineAt=Date.now()+10100;
  f.options.fetchImpl=(url,init)=>url.endsWith('/v1/messages')?new Promise((resolve,reject)=>{
    if(init.signal.aborted)reject(init.signal.reason);
    else init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }):base(url,init);
  // Keep Node alive while AbortSignal's unreferenced timer runs.
  const keepAlive=setInterval(()=>{},1000);
  try { const out=await f.step();assert.equal(out.error.type,'timeout');assert.equal(out.stage,'review'); }
  finally {clearInterval(keepAlive);}
  const row=await f.row();assert.equal(row.planning.direction.status,'error');assert.equal(row.planning.direction.draft.title,draft.title);
});

test('changing the selected resource invalidates an in-flight draft',async()=>{
  let release,arrive;const hold=new Promise(r=>release=r),arrived=new Promise(r=>arrive=r);
  const f=await fixture({model:async()=>{arrive();await hold;return draft;}});
  await f.step();const running=f.step();await arrived;
  assert.ok(Date.parse((await f.row()).planning.direction.lease_until)-Date.now()>300000);
  await db.query('update engelbart_onboardings set asset_chosen=$2 where id=$1',[f.id,{title:'Other code',type:'code'}]);
  release();await assert.rejects(running,/discarded/);
  assert.equal((await f.row()).direction,null);
});


test('Subgoals and TODOs use the same persisted review boundary',async()=>{
  const subgoals = ['Reconstruct the loop','Change the repetition count','Compare the loop bounds'].map(label=>({label,description:'One observable result.',why:'A concrete next step.'}));
  const f=await fixture({model:p=>/Validate this/.test(p)?positive:/Write the TODO rows/.test(p)?{todos:['Render one instruction','Generate the loop'],name:'loop-workbench',paperBasis:basis}:{subgoals,paperBasis:basis}});
  await db.query('update engelbart_onboardings set direction=$2 where id=$1',[f.id,draft]);
  for(const kind of ['subgoals','todos']){
    for(const stage of ['review','ready']){
      const count=f.calls.length;const out=await f.step({kind});assert.equal(out.stage,stage);assert.ok(f.calls.length-count<=1);
    }
  }
  const row=await f.row();assert.equal(row.subgoals.length,3);assert.equal(row.todos.length,2);assert.equal(row.project_name,'loop-workbench');
});

test('the order migration keeps existing readers on their current screen',async()=>{
  const rows=[{id:crypto.randomUUID(),step:6,status:'open'},{id:crypto.randomUUID(),step:7,status:'open'},{id:crypto.randomUUID(),step:7,status:'created'}];
  for(const r of rows) await db.query('insert into engelbart_onboardings(id,user_id,status,step,interest) values($1,$2,$3,$4,$5)',[r.id,user.id,r.status,r.step,'Keep this interest']);
  await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260908060000_brainstorm_before_topics.sql'),'utf8'));
  for(const [i,r] of rows.entries()){
    const saved=(await db.query('select step,interest from engelbart_onboardings where id=$1',[r.id])).rows[0];
    assert.equal(saved.step,[7,6,7][i]);assert.equal(saved.interest,'Keep this interest');
  }
});

test('planning gets 200-second model calls inside a bounded 300-second hosting window',async(t)=>{
 const ordinary=Budget.forAction({},'analysis'),planning=Budget.forAction({},'plan');
 assert.ok(planning.deadlineAt-ordinary.deadlineAt>=159000);
 const earlier={deadlineAt:Date.now()+30000};assert.equal(Budget.forAction(earlier,'plan').deadlineAt,earlier.deadlineAt);
 const config=require('../vercel.json');assert.equal(config.functions['api/engelbart-onboarding.js'].maxDuration,300);
 const durations=[],original=AbortSignal.timeout;
 t.mock.method(AbortSignal,'timeout',ms=>{durations.push(ms);return original(ms);});
 const f=await fixture({grounded:false});await f.step();await f.step();await f.step();
 assert.equal(durations.filter(ms=>ms===200000).length,2,'draft and review each allow 200 seconds');
 assert.ok(Budget.PLANNING_REQUEST_MS<300000);
});

for (const status of ['pending','error','running']) test('saved legacy grounding stage resumes: '+status,async()=>{
  const f=await fixture({grounded:false}); await f.step();
  await db.query("update engelbart_onboardings set planning=jsonb_set(planning,'{direction}',(planning->'direction') || $2::jsonb) where id=$1",[f.id,{stage:'grounding',status,error:{type:'timeout',message:'Old full-paper timeout'},lease_until:'2000-01-01'}]);
  assert.equal((await f.step({retry:true})).stage,'draft');
  assert.equal(f.calls.length,0);
  assert.equal((await f.step()).stage,'review');
  assert.equal((await f.step()).status,'complete');
  assert.equal(f.calls.length,2);
});
