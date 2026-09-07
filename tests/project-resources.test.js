'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const R = require('../api/_lib/project-resources');
const Storage = require('../api/_lib/storage');
test('only chosen dataset and paper enter durable claim references', () => {
  const row = {id:'setup', paper_id:'12345678-1234-1234-1234-123456789012', paper_title:'Research',
    asset_chosen:{key:'a',title:'Events',type:'dataset',availability:'usable',links:[{kind:'download',url:'https://example.org/events.csv'}]},
    assets:[{title:'Do not download'}]};
  const r=R.fromOnboarding(row); assert.equal(r.length,2); assert.equal(r[1].source.url,'https://example.org/events.csv');
  assert.equal(r[0].source.objectPath,'papers/'+row.paper_id+'.pdf'); assert.equal(r[1].status,'selected');
  assert.equal(R.fromOnboarding({...row,asset_chosen:null}).length,1);
});
test('ambiguous and gated resources retain access constraints', () => {
  const [r]=R.fromOnboarding({asset_chosen:{title:'Events',type:'dataset',availability:'unknown',links:[{kind:'download',url:'https://a.org/a.csv'},{kind:'download',url:'https://b.org/b.csv'}]}});
  assert.equal(r.source.gated,true); assert.equal(r.source.ambiguous,true);
});
test('claim signs the stored paper once and supports old payloads', async t => {
  const old=Storage.signedViewUrl; t.after(()=>Storage.signedViewUrl=old);
  Storage.signedViewUrl=async path=>({url:'https://storage.example/'+path+'?token=temporary'});
  const value=await R.forClaim({paper:{paper_id:'12345678-1234-1234-1234-123456789012',title:'Research'}});
  assert.match(value.resources[0].source.downloadUrl,/token=temporary/);
  assert.equal(value.resources[0].name,'Research');
  assert.equal(await R.forClaim(null),null);
  Storage.signedViewUrl=async()=>{throw Error('outage');};
  assert.equal((await R.forClaim(value)).resources[0].status,'failed');
});
test('failed access retains the original source and cannot become a human download chore',()=>{
  const [r]=R.fromOnboarding({asset_chosen:{title:'Missing data',type:'dataset',links:[],sourceLinks:[{kind:'download',url:'https://data.example/dead.csv'}],access:{state:'unavailable',reason:'Data target not found'}}});
  assert.equal(r.status,'failed'); assert.equal(r.source.url,'https://data.example/dead.csv');
  assert.equal(r.error,'Data target not found');
});
