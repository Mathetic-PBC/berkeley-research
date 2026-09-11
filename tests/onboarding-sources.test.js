'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Sources=require('../api/_lib/onboarding-sources');
const Storage=require('../api/_lib/dataset-storage');
const ENV={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service'};
test('article files and links are readable, bounded, and never executed',async()=>{
 assert.deepEqual(await Sources.article({name:'Field notes.md',text:'# Finding\n\nEvidence'}),{name:'Field notes.md',text:'# Finding\n\nEvidence',url:''});
 const out=await Sources.article({url:'https://research.example/article'},{fetchImpl:async()=>new Response('<p>Actual content</p><script>alert(1)</script>')});
 assert.equal(out.text,'Actual content');
 await assert.rejects(Sources.article({text:' '}),/no readable text/);
 await assert.rejects(Sources.article({text:'x'.repeat(200001)}),/smaller/);
 await assert.rejects(Sources.article({url:'http://127.0.0.1/private'}),/public/);
});
test('dataset-only analysis reads a bounded sample owned by this member and setup',async()=>{
 const row={id:'setup',dataset_resource:{name:'Measures',source:{provider:'supabase',uploadId:'upload'},manifest:{files:[{path:'data.csv',format:'csv',objectPath:'user/setup/upload/0'}]}}};
 const paths=[];
 const value=await Sources.materials({id:'user'},row,{datasetStorage:{sample:async path=>{paths.push(path);return 'measure,value\na,1';}}});
 assert.deepEqual(paths,['user/setup/upload/0']);
 assert.match(value.pdfText,/measure,value/);assert.match(value.pdfText,/first 16 KiB/);assert.equal(value.pdfBase64,undefined);
 row.dataset_resource.manifest.files[0].objectPath='other/setup/upload/0';
 await assert.rejects(Sources.materials({id:'user'},row,{datasetStorage:{sample:async()=>assert.fail('Must not read another owner')}}),/Invalid dataset/);
});
test('binary datasets retain manifest context without fabricating contents',async()=>{
 const out=await Sources.materials({id:'user'},{dataset_resource:{name:'Events',source:{provider:'supabase'},manifest:{files:[{path:'events.parquet',format:'parquet',size:100}]}}});
 assert.match(out.pdfText,/events.parquet/);assert.match(out.pdfText,/not evidence of findings/);
});
test('replaced sources invalidate in-flight work, including dataset-only work',()=>{
 const row={paper_id:null,source_article:{text:'A'},dataset_resource:{id:'one'}};
 const old=Sources.key(row);row.source_article.text='B';assert.notEqual(Sources.key(row),old);
 const next=Sources.key(row);row.dataset_resource.id='two';assert.notEqual(Sources.key(row),next);
});
test('private sampling caps reads even when Storage ignores Range',async()=>{
 let cancelled=false,request;
 const sample=await Storage.sample('u/ob/upload/0',{env:ENV,fetchImpl:async(url,init)=>{
  request=init;
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(40000)));},cancel(){cancelled=true;}}));
 }});
 assert.equal(sample.length,16384);assert.equal(request.headers.Range,'bytes=0-16383');assert.equal(cancelled,true);
});
test('local dataset-only analysis uses metadata without reading or uploading files',async()=>{
 const row={dataset_resource:{name:'TutorTrace',source:{provider:'local_picker'},manifest:{files:[{path:'nested/events.parquet',format:'parquet',size:199*1024*1024}]}}};
 const out=await Sources.materials({id:'user'},row,{fetchImpl:async()=>assert.fail('Local selection must not fetch bytes'),datasetStorage:{sample:async()=>assert.fail('Local selection must not read Storage')}});
 assert.match(out.pdfText,/nested\/events.parquet/);
 assert.match(out.pdfText,/Dataset bytes are not available/);
 assert.equal(out.pdfBase64,undefined);
});
