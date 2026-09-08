'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const D=require('../api/_lib/onboarding-dataset'),R=require('../api/_lib/project-resources'),S=require('../api/_lib/dataset-storage');
const user={id:'11111111-1111-1111-1111-111111111111'},id='22222222-2222-2222-2222-222222222222';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'test-anon',SUPABASE_SERVICE_ROLE_KEY:'test-service'};
function fixture(){
 const row={id,user_id:user.id,status:'open',analysis:{title:'Retained'},dataset_resource:{id:'prior',kind:'dataset'},dataset_upload:null};
 const files=new Map(),calls=[];
 const options={env,trace:false,datasetStorage:{upload:async path=>({uploadUrl:'https://upload.example/'+path}),size:async path=>files.get(path)},fetchImpl:async(url,init)=>{
  calls.push({url,init});const query=new URL(url).searchParams;
  if(query.get('user_id')!=='eq.'+user.id)throw Error('missing owner');
  if(query.get('dataset_upload->>id') && query.get('dataset_upload->>id')!=='eq.'+row.dataset_upload?.id)return Response.json([]);
  if(query.get('dataset_upload->>revision') && query.get('dataset_upload->>revision')!=='eq.'+row.dataset_upload?.revision)return Response.json([]);
  Object.assign(row,JSON.parse(init.body));return Response.json([row]);
 }};return {row,files,calls,options};
}
test('hosted dataset upload attaches only after verified completion and automatically joins paper handoff',async()=>{
 const f=fixture();await D.handle(user,f.row,{op:'begin',name:'Research data',files:[{path:'nested/測定.csv',size:12},{path:'labels.json',size:10}]},f.options);
 const upload=f.row.dataset_upload;
 assert.equal(f.row.dataset_resource.id,'prior');assert.equal(upload.manifest.folderCount,1);
 await assert.rejects(D.handle(user,f.row,{op:'finish',id:upload.id},f.options),/incomplete/);
 for(let i=0;i<2;i++){
  assert.match((await D.handle(user,f.row,{op:'sign',id:upload.id,index:i},f.options)).uploadUrl,/upload.example/);
  f.files.set(upload.manifest.files[i].objectPath,upload.manifest.files[i].size);
  await D.handle(user,f.row,{op:'confirm',id:upload.id,index:i},f.options);
 }
 await D.handle(user,f.row,{op:'finish',id:upload.id},f.options);
 assert.equal(f.row.dataset_upload,null);assert.equal(f.row.dataset_resource.manifest.fileCount,2);
 assert.equal(f.row.analysis.title,'Retained');assert.equal(f.row.dataset_resource.source.provider,'supabase');
 const out=R.fromOnboarding({...f.row,paper_id:id,asset_chosen:{type:'dataset',title:'Discovered',links:[]}});
 assert.equal(out.length,3);assert.equal(out.at(-1).name,'Research data');
 const reloaded=JSON.parse(JSON.stringify(f.row));assert.equal(R.fromOnboarding(reloaded)[0].manifest.files[0].path,'nested/測定.csv');
});
test('failed transfers, superseded sessions, and stale writes preserve the attached dataset',async()=>{
 const f=fixture(),begin={op:'begin',name:'data',files:[{path:'a.csv',size:12}]};
 await D.handle(user,f.row,begin,f.options);const old=structuredClone(f.row);
 f.files.set(f.row.dataset_upload.manifest.files[0].objectPath,3);
 await assert.rejects(D.handle(user,f.row,{op:'confirm',id:f.row.dataset_upload.id,index:0},f.options),/does not match/);
 assert.equal(f.row.dataset_resource.id,'prior');
 await D.handle(user,f.row,begin,f.options);
 await assert.rejects(D.handle(user,f.row,{op:'finish',id:old.dataset_upload.id},f.options),/replaced/);
 await assert.rejects(D.handle(user,old,{op:'begin',name:'stale',files:[{path:'a.csv',size:12}]},f.options),/another tab/);
 assert.equal(f.row.dataset_resource.id,'prior');
});
test('manifest rejects unsafe and excessive paths, retains nested files, and leaves Paper limits separate',()=>{
 for(const path of ['../x.csv','/x.csv','a/../x.csv','C:/x.csv','a\\x.csv','NUL.csv'])assert.throws(()=>D.manifest([{path,size:1}],'d'),/Unsafe/);
 for(const paths of [['A.csv','a.csv'],['a.csv','a.csv/b.csv'],['é.csv','e\u0301.csv']])assert.throws(()=>D.manifest(paths.map(path=>({path,size:1})),'d'),/Duplicate|conflicts/);
 assert.throws(()=>D.manifest([{path:'a.csv',size:15}],'d',{HC_ONBOARDING_DATASET_MAX_BYTES:10}),/policy/);
 assert.equal(D.manifest([{path:'large.csv',size:60*1024**2}],'d').fileCount,1);
});
test('private dataset claim signs only the authenticated owner paths and never persists signed URLs',async()=>{
 const f=fixture();await D.handle(user,f.row,{op:'begin',name:'Data',files:[{path:'a.csv',size:10}]},f.options);
 const u=f.row.dataset_upload;f.files.set(u.manifest.files[0].objectPath,10);
 await D.handle(user,f.row,{op:'confirm',id:u.id,index:0},f.options);await D.handle(user,f.row,{op:'finish',id:u.id},f.options);
 const payload={resources:R.fromOnboarding(f.row)};let signs=0;
 const options={env,trace:false,userId:user.id,fetchImpl:async(url,init)=>{signs++;assert.ok(url.endsWith('/object/sign/engelbart-datasets'));return Response.json(JSON.parse(init.body).paths.map(path=>({path,signedURL:'/object/sign/engelbart-datasets/'+path+'?token=test-token'})));}};
 const claimed=await R.forClaim(payload,options);assert.match(claimed.resources[0].manifest.files[0].downloadUrl,/token=test-token/);
 assert.ok(!JSON.stringify(payload).includes('test-token'));assert.equal(signs,1);
 const blocked=await R.forClaim(payload,{...options,userId:id});assert.equal(blocked.resources[0].status,'needs_user');assert.equal(signs,1);
});
test('signed uploads are immutable and file verification uses HEAD rather than reading bytes',async()=>{
 const calls=[],options={env,trace:false,fetchImpl:async(url,init)=>{calls.push({url,init});return init.method==='HEAD'?new Response(null,{headers:{'content-length':'42'}}):Response.json({url:'/object/upload/sign/engelbart-datasets/path?token=test'});}};
 assert.equal((await S.upload('path',options)).anonKey,'test-anon');assert.equal(calls[0].init.headers['x-upsert'],'false');
 assert.equal(await S.size('path',options),42);assert.equal(calls[1].init.method,'HEAD');
});

test('project creation cannot silently drop an unfinished dataset upload',async()=>{
 const OB=require('../api/_lib/onboarding');
 await assert.rejects(OB.create(user,{status:'open',dataset_upload:{id:'pending'}},[],{},{}),/Finish or remove/);
});

test('the additive migration preserves existing onboardings and keeps the dataset bucket private',async()=>{
 const {PGlite}=require('@electric-sql/pglite');const fs=require('node:fs');
 const db=new PGlite();try {
  await db.exec("create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint); create table public.engelbart_onboardings(id text primary key,status text); insert into public.engelbart_onboardings values('existing','created');");
  const sql=fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20260908160000_onboarding_dataset_upload.sql'),'utf8');
  await db.exec(sql);await db.exec(sql);
  assert.deepEqual((await db.query('select * from public.engelbart_onboardings')).rows,[{id:'existing',status:'created',dataset_resource:null,dataset_upload:null}]);
  assert.equal((await db.query('select public from storage.buckets')).rows[0].public,false);
 } finally {await db.close();}
});
