'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const R = require('../api/_lib/project-resources');
const direct = (url='https://data.example/events.csv') => ({ title:'Events', type:'dataset', links:[{kind:'download',url}] });
function transport(routes) {
  const calls=[];
  return { calls, fetchImpl: async(url, init) => { calls.push({url,init}); if (!(url in routes)) throw Error('missing fixture '+url); return routes[url](); } };
}
const csv = () => new Response('timestamp,event\n1,edit\n', {headers:{'Content-Type':'text/csv','Content-Length':'23'}});
test('direct CSV, parquet and archive have actual plausible bounded bytes', async()=>{
  for (const [name,body] of [['events.csv','timestamp,event\n1,edit\n'],['events.parquet','PAR1binary-footer-later'],['events.zip',Buffer.from([80,75,3,4,1,2,3])]]) {
    const url='https://data.example/'+name;
    const opts=transport({[url]:()=>new Response(body)});
    const r=await R.probeAsset(direct(url),opts);
    assert.equal(r.state,'available'); assert.equal(r.downloadUrl,url);
    assert.match(opts.calls[0].init.headers.Range,/bytes=0-/);
  }
});
test('HTML landing page, dead target and redirect failure are not data',async()=>{
  for (const response of [()=>new Response('<html>Read about our dataset</html>',{headers:{'Content-Type':'text/html'}}),()=>new Response('gone',{status:404}),()=>new Response('',{status:302})]) {
    assert.equal((await R.probeAsset(direct(),transport({'https://data.example/events.csv':response}))).state,'unavailable');
  }
});
test('login redirects, author-request-only and interactive license are restricted',async()=>{
  assert.equal((await R.probeAsset(direct(),transport({'https://data.example/events.csv':()=>new Response('',{status:302,headers:{location:'/login'}})}))).state,'restricted');
  for (const description of ['Available upon request from the authors','Accept the dataset license before download']) {
    const r=await R.probeAsset({...direct(),description},{fetchImpl:()=>{throw Error('should not fetch');}});
    assert.equal(r.state,'restricted');
  }
  assert.equal((await R.probeAsset(direct(),transport({'https://data.example/events.csv':()=>new Response('denied',{status:403})}))).state,'restricted');
});
test('huge public files stop at headers and unknown-length bodies stay bounded',async()=>{
  let cancelled=false, pulled=0;
  const stream=new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(32768));},cancel(){cancelled=true;}});
  const r=await R.probeAsset(direct(),transport({'https://data.example/events.csv':()=>new Response(stream,{headers:{'Content-Length':String(3*1024**3)}})}));
  assert.equal(r.state,'too_large'); assert.equal(cancelled,true); assert.ok(pulled<=1);
});
test('a repository needs actual dataset bytes, not just a successful tree response',async()=>{
  for (const included of [true,false]) {
    const opts=transport({
      'https://api.github.com/repos/lab/study':()=>Response.json({default_branch:'main'}),
      'https://api.github.com/repos/lab/study/git/trees/main?recursive=1':()=>Response.json({tree:included?[{type:'blob',path:'data/events.csv'}]:[{type:'blob',path:'README.md'}]}),
      'https://raw.githubusercontent.com/lab/study/main/data/events.csv':csv,
    });
    const r=await R.probeAsset(direct('https://github.com/lab/study'),opts);
    assert.equal(r.state,included?'available':'unavailable');
    if(included) assert.match(r.downloadUrl,/raw.githubusercontent/);
  }
});
test('a public API with actual records is remote only; network failures remain truthful',async()=>{
  assert.equal((await R.probeAsset(direct('https://data.example/api/events'),transport({'https://data.example/api/events':()=>Response.json([{event:'edit'}])}))).state,'remote_only');
  assert.equal((await R.probeAsset(direct(),{fetchImpl:async()=>{throw Error('offline');}})).state,'unavailable');
});
test('official child fallback retains original truth and becomes the chosen resource',async()=>{
  const original={...direct(), title:'Clinical records',description:'Available upon request',children:[{...direct(),title:'Official public sample'}]};
  const chosen=await R.resolveChosen({...original,key:original.title},[original],transport({'https://data.example/events.csv':csv}));
  assert.equal(original.access.state,'restricted'); assert.equal(chosen.title,'Official public sample');
  assert.equal(chosen.access.state,'available'); assert.equal(chosen.fallbackOf.title,original.title);
  assert.doesNotThrow(()=>R.assertUsable({uses:[chosen.title]},chosen));
});
test('planning gate blocks unresolved data dependencies, not independent directions',()=>{
  for (const state of ['checking','unavailable','restricted','too_large','remote_only']) {
    const asset={...direct(),access:{state}};
    assert.throws(()=>R.assertUsable({uses:['Events']},asset),{statusCode:409});
    assert.doesNotThrow(()=>R.assertUsable({title:'Change the demo',uses:['Existing calculator']},asset));
  }
  assert.throws(()=>R.assertUsable({},direct()),{statusCode:409});
});
test('explicit data dependencies are gated even when the selected asset is a demo',()=>{
  const data={...direct(),access:{state:'restricted'}};
  const demo={title:'Calculator',type:'demo'};
  assert.throws(()=>R.assertUsable({uses:['Events']},demo,[data]),{statusCode:409});
  assert.doesNotThrow(()=>R.assertUsable({uses:['Calculator']},demo,[data]));
});

const blocked = (extra={}) => ({...direct('https://lab.example/records'),title:'ICU records',description:'Available upon request',...extra});
const alternative = (url, title='Released ICU subset', kind='authors_example') => ({...direct(url),title,fallbackKind:kind,compatible:true,compatibilityReason:'Preserves patient trajectories and timestamped measurements'});
const synthetic = {reason:'No released records could be verified',compatibilityReason:'Test grouping measurements by session using invented values',columns:['session_id','timestamp','measurement'],rows:[['demo-1',1,4],['demo-1',2,7]]};
test('available original remains selected without fallback search',async()=>{
  const opts=transport({'https://data.example/events.csv':csv});
  opts.discoverFallback=()=>{throw Error('must not search');};
  const got=await R.resolveChosen(direct(),[],opts);
  assert.equal(got.title,'Events'); assert.equal(got.fallbackOf,undefined);
});
test('restricted official page can expose a separate public sample, preserving original truth',async()=>{
  const original=blocked();
  const opts=transport({
    'https://lab.example/records':()=>new Response('<html>Available upon request <a href="/sample.csv">Official sample</a></html>',{headers:{'Content-Type':'text/html'}}),
    'https://lab.example/sample.csv':csv,
  });
  opts.discoverFallback=()=>{throw Error('official sample should win');};
  const got=await R.resolveChosen(original,[original],opts);
  assert.equal(original.access.state,'restricted');
  assert.equal(got.access.state,'available');
  assert.equal(got.fallbackOf.kind,'official_sample');
  assert.equal(got.fallbackOf.source[0].url,'https://lab.example/records');
  assert.equal(got.fallbackOf.fallbackSource[0].url,'https://lab.example/sample.csv');
});
test('no children: bounded discovery finds authors subset or compatible public replacement',async()=>{
  for (const kind of ['authors_example','compatible_substitute']) {
    const original=blocked(); let discoveries=0;
    const opts=transport({'https://public.example/subset.csv':csv});
    opts.discoverFallback=async input=>{discoveries++;assert.equal(input.children.length,0);assert.equal(input.original.access.state,'restricted');return {candidates:[alternative('https://public.example/subset.csv','Public ICU subset',kind)]};};
    const got=await R.resolveChosen(original,[original],opts);
    assert.equal(discoveries,1); assert.equal(got.access.state,'available'); assert.equal(got.fallbackOf.kind,kind);
    assert.equal(original.children[0].title,got.title,'fallback persists in existing asset list');
  }
});
test('failed candidate is skipped and a verified real alternative beats synthetic',async()=>{
  const opts=transport({'https://public.example/bad.csv':()=>new Response('dead',{status:404}),'https://public.example/good.csv':csv});
  opts.discoverFallback=async()=>({candidates:[alternative('https://public.example/bad.csv'),alternative('https://public.example/good.csv','Compatible records','compatible_substitute')],synthetic});
  const got=await R.resolveChosen(blocked(),[],opts);
  assert.equal(got.title,'Compatible records');assert.equal(got.inlineCsv,undefined);
});
test('pedagogical child alone is not proof of compatibility; synthetic is last and explicit',async()=>{
  const original=blocked({children:[{...direct(),title:'Easy unrelated spreadsheet',access:{state:'available'}}]});
  let searched=false;
  const opts=transport({'https://public.example/bad.csv':()=>new Response('dead',{status:404})});
  opts.discoverFallback=async()=>{searched=true;return {candidates:[alternative('https://public.example/bad.csv')],synthetic};};
  const got=await R.resolveChosen(original,[original],opts);
  assert.equal(searched,true);assert.equal(got.fallbackOf.kind,'synthetic_fallback');
  assert.match(got.title,/Synthetic stand-in/);assert.equal(got.access.state,'available');
  assert.match(got.inlineCsv,/session_id/);assert.equal(got.fallbackOf.generatedStructure.rowCount,2);
  assert.throws(()=>R.assertUsable({uses:[got.title],title:'Analyze patient outcomes'},got),{statusCode:409});
  assert.doesNotThrow(()=>R.assertUsable({uses:[got.title],title:'Test grouping on a synthetic stand-in'},got));
  const manifest=R.fromOnboarding({asset_chosen:got})[0];
  assert.equal(manifest.source.inlineCsv,got.inlineCsv);
  assert.equal(manifest.provenance.fallbackOf.kind,'synthetic_fallback');
  assert.equal(manifest.metadata.fallbackOf.access.state,'restricted');
});
test('invalid or incompatible fallbacks cannot bypass the planning gate',async()=>{
  const opts=transport({'https://public.example/anything.csv':csv});
  opts.discoverFallback=async()=>({candidates:[{...alternative('https://public.example/anything.csv'),compatible:false}],synthetic:{...synthetic,columns:['run shell code()']}});
  const got=await R.resolveChosen(blocked(),[],opts);
  assert.equal(got.access.state,'restricted');
  assert.throws(()=>R.assertUsable({uses:['ICU records']},got),{statusCode:409});
  assert.doesNotThrow(()=>R.assertUsable({uses:['Independent simulator'],title:'Change the simulator'},got));
});


test('a sample-only landing page resolves with explicit subset provenance, including release downloads',async()=>{
  const original=direct('https://lab.example/data');
  const opts=transport({
    'https://lab.example/data':()=>new Response('<html><a href="https://github.com/lab/study/releases/download/v1/sample.csv">Official subset</a></html>',{headers:{'Content-Type':'text/html'}}),
    'https://github.com/lab/study/releases/download/v1/sample.csv':csv,
  });
  const got=await R.resolveChosen(original,[original],opts);
  assert.equal(original.access.state,'unavailable');
  assert.equal(got.access.state,'available');
  assert.equal(got.fallbackOf.kind,'official_sample');
  assert.match(got.access.downloadUrl,/releases\/download/);
});
