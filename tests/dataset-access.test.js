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
