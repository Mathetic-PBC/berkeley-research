'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const R=require('../api/_lib/project-resources'), C=require('../api/_lib/dataset-collections');
function github(tree, extras={}) {
 const calls=[];
 return {calls,fetchImpl:async url=>{calls.push(url);if(extras[url])return extras[url]();
 if(url.endsWith('/commits/main'))return Response.json({sha:'a'.repeat(40),commit:{tree:{sha:'tree-sha'}}});
 if(url.includes('/git/trees/'))return Response.json(tree);
 if(url.endsWith('/org/research-repo'))return Response.json({default_branch:'main'});
 throw Error('unexpected '+url);}};
}
const files=['dataset/metrics.csv','dataset/labels.csv','dataset/raw/events.parquet'];
test('GitHub folder preserves complete structure, pinned provenance, and selected-resource handoff',async()=>{
 const opts=github({tree:[...files,'README.md'].map(path=>({type:'blob',mode:'100644',path,size:50}))});
 const url='https://github.com/org/research-repo/tree/main/dataset';
 const access=await R.probeUrl(url,opts);assert.equal(access.state,'available',access.reason);
 const c=access.collection;assert.equal(c.source.rootPath,'dataset');assert.equal(c.source.commit,'a'.repeat(40));
 assert.deepEqual(c.manifest.files.map(f=>f.path),['metrics.csv','labels.csv','raw/events.parquet']);
 assert.equal(c.manifest.folderCount,1);assert.equal(c.manifest.totalBytes,150);
 const [r]=R.fromOnboarding({asset_chosen:{type:'dataset',title:'Research data',access,links:[{url}]}});
 assert.equal(r.source.provider,'github');assert.equal(r.manifest.fileCount,3);assert.equal(r.source.gated,false);
 assert.ok(!opts.calls.some(u=>u.includes('raw.githubusercontent')));
});
test('a recursive tree greater than 32 KB parses completely; truncated provider trees stay explicit',async()=>{
 const tree={tree:Array.from({length:1500},(_,i)=>({path:`dataset/nested/table-${i}.csv`,type:'blob',size:20}))};
 assert.ok(JSON.stringify(tree).length>32768);
 const r=await R.probeUrl('https://github.com/org/research-repo',github(tree));
 assert.equal(r.state,'available');assert.equal(r.collection.manifest.fileCount,1500);
 const truncated=await R.probeUrl('https://github.com/org/research-repo',github({...tree,truncated:true}));
 assert.equal(truncated.state,'remote_only');assert.match(truncated.reason,/truncated/);
 assert.ok(JSON.stringify(C.compact(r)).length<12000);
});
test('rate limits and provider failures are not private repositories',async()=>{
 for(const [status,body,headers,expected] of [[403,'API rate limit exceeded',{'x-ratelimit-remaining':'0'},'rate_limited'],[403,'Resource forbidden',{},'restricted'],[401,'Bad credentials',{},'restricted'],[503,'Unavailable',{},'unavailable']]){
  const r=await R.probeUrl('https://github.com/org/research-repo',{fetchImpl:async()=>new Response(body,{status,headers})});assert.equal(r.state,expected);
 }
});
test('Anonymous GitHub uses its public listing, including nested directories, without shell auth heuristics',async()=>{
 const calls=[];
 const r=await R.probeUrl('https://anonymous.4open.science/r/IDETrace',{fetchImpl:async url=>{
  calls.push(url);
  if(url.endsWith('/files'))return Response.json([{name:'dataset',path:''},{name:'README.md',path:'',size:10}]);
  if(url.endsWith('?path=dataset'))return Response.json([{name:'metrics.csv',path:'dataset',size:100}]);
  throw Error('unexpected shell fetch');
 }});
 assert.equal(r.state,'available');assert.equal(r.collection.source.provider,'anonymous_github');assert.equal(r.collection.manifest.fileCount,2);
 assert.ok(calls.every(u=>u.includes('/api/repo/IDETrace/files')));
});
test('generic shell sign-in text does not gate a linked public dataset',async()=>{
 const r=await R.probeUrl('https://example.org/data',{fetchImpl:async url=>url.endsWith('.csv')?new Response('a,b\n1,2\n'):new Response('<html><nav>Sign in</nav><a href="/table.csv">Data</a></html>',{headers:{'content-type':'text/html'}})});
 assert.equal(r.state,'available');
});
test('slash-containing GitHub refs and canonical collection identity survive URL variants',async()=>{
 const opts=github({tree:files.map(path=>({type:'blob',path,size:20}))},{
  'https://api.github.com/repos/org/research-repo/commits/feature':()=>new Response('Not Found',{status:404}),
  'https://api.github.com/repos/org/research-repo/commits/feature%2Fresearch':()=>Response.json({sha:'a'.repeat(40),commit:{tree:{sha:'tree-sha'}}}),
 });
 const r=await R.probeUrl('https://github.com/org/research-repo/tree/feature/research/dataset',opts);
 assert.equal(r.state,'available');assert.equal(r.collection.source.ref,'feature/research');assert.equal(r.collection.source.rootPath,'dataset');
 const same=await R.probeUrl('https://github.com/org/research-repo/tree/main/dataset/',github({tree:files.map(path=>({type:'blob',path,size:20}))}));
 assert.equal(r.collection.id,same.collection.id);
});

test('GitHub release-file URLs retain the single-file path',async()=>{
 const r=await R.probeUrl('https://github.com/org/research-repo/releases/download/v1/metrics.csv',{fetchImpl:async()=>new Response('metric,label\n1,yes\n')});
 assert.equal(r.state,'available');assert.equal(r.format,'csv');
});
