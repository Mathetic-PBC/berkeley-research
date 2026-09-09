'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const OM=require('../api/_lib/onboarding-model');const G=require('../api/_lib/plan-evidence');const R=require('../api/_lib/project-resources');
const credentials={apiKey:'fixture',baseUrl:'https://fixture.invalid',models:['all-proxy-models']};
const positive={grounded:true,actionable:true,mechanismFirst:true,resourceHonest:true,progression:true};
const grounding=G.normalize({contribution:'Map therapist instructions to rehabilitation software.',evidence:[
 {kind:'method',claim:'An instruction is decomposed into action and repetition parameters to generate software.',quote:'We map the action and repetition count to the exercise template.',location:'Methods §3'},
 {kind:'variable',claim:'The instruction repetition count controls the generated loop.',quote:'Changing the requested repetitions changes the loop bound.',location:'Example 2'},
 {kind:'artifact',claim:'The paper includes a worked instruction and generated program.',quote:'Raise the right arm five times; for i in range(5): raise_right_arm().',location:'Figure 4'}],limits:'The proprietary full generator is unavailable; reconstruct the worked template, not its empirical evaluation.'});
const paperBasis={evidenceIds:['p1','p2','p3'],reproduce:'Reconstruct the Figure 4 instruction-to-loop transformation.',interrogate:'Change the repetition phrase and compare the loop bound.',extend:'After comparing, test an unseen repetition phrase.',limitation:grounding.limits};
const direction={title:'Reconstruct one instruction-to-software example',what_you_would_make:'Run the Figure 4 template reconstruction, compare the generated loop with the paper, then change repetitions.',uses:['Released examples'],why_it_fits:'Make the actual transformation tangible.',first_visible_result:'The instruction produces an executable five-repetition loop.',paperBasis};
function input(extra={}) {return {reader:{},paper:{title:'Instruction mapping',one_liner:'Instructions generate exercises',grounding},asset:{type:'dataset',title:'Released examples',access:{state:'available'},links:[]},...extra};}
function boundary(replies,calls=[]) {return {fetchImpl:async(url,init)=>{calls.push(JSON.parse(init.body));assert.ok(replies.length,'bounded expected model calls');return {ok:true,status:200,json:async()=>({content:[{type:'text',text:JSON.stringify(replies.shift())}]})};}};}

test('Analysis stays lightweight and no separate full-paper extractor exists',async()=>{
 const q=[0,25,50,75,100].map(level=>({level,question:'Question',sample_response:'Answer'}));
 const calls=[];const out=await OM.analyze({pdfText:'Methods §3: We map the action and repetition count to the exercise template.',familiarityLabel:'Unfamiliar',depthLabel:'Everyday'},credentials,boundary([{title:'Instructions',one_liner:'Mapping',areas:[{area:'Templates',questions:q},{area:'Programming',questions:q}],grounding}],calls));
 assert.equal(out.grounding,undefined);
 assert.doesNotMatch(calls[0].messages[0].content.at(-1).text,/short verbatim supporting passage/);
 assert.equal(OM.paperGrounding,undefined);
 assert.equal(calls.length,1);
 assert.deepEqual(R.fromOnboarding({paper_id:'paper',analysis:{...out,grounding}})[0].metadata.grounding,grounding);
 assert.ok(JSON.stringify(G.normalize({...grounding,evidence:Array(100).fill(grounding.evidence[0])})).length<10000);
});
test('paper-dependent Direction uses paper mechanism and actual verified resource',async()=>{
 const calls=[];const out=await OM.direction(input(),credentials,boundary([direction,positive],calls));
 assert.deepEqual(out.paperBasis,paperBasis);assert.equal(calls.length,2);
 assert.match(calls[0].messages[0].content[0].text,/Figure 4/);assert.match(calls[0].messages[0].content[0].text,/Released examples/);
 assert.match(calls[1].messages[0].content[0].text,/do not demand missing quotes or evidence IDs/);
});
test('topic-adjacent browser is rejected even with superficially valid paper citations; one bounded correction',async()=>{
 const weak={...direction,title:'Build an instruction/code browser',what_you_would_make:'Navigate examples and highlight metadata.'};
 const calls=[];const out=await OM.direction(input(),credentials,boundary([weak,{...positive,mechanismFirst:false,reason:'No instruction is transformed into software'},direction,positive],calls));
 assert.equal(out.title,direction.title);assert.equal(calls.length,4);assert.match(calls[2].messages[0].content[0].text,/No instruction is transformed/);
});
for(const title of ['Build a generic topic dashboard','Build a chatbot about this paper','Visualize unrelated metadata'])test('refuses persistent drift: '+title,async()=>{
 const weak={...direction,title};const bad={...positive,mechanismFirst:false};
 const calls=[];await assert.rejects(OM.direction(input(),credentials,boundary([weak,bad,weak,bad],calls)),{statusCode:502});assert.equal(calls.length,4);
});
test('unsupported evidence cannot be blessed by review; passive goals rejected',async()=>{
 for(const weak of [{...direction,paperBasis:{...paperBasis,evidenceIds:['invented']}},{...direction,title:'Understand the method'}]){
  const calls=[];await assert.rejects(OM.direction(input(),credentials,boundary([weak,weak],calls)),{statusCode:502});assert.equal(calls.length,2);
 }
});
test('synthetic structural reconstruction is explicit; no empirical reproduction claims',async()=>{
 const synthetic=input({asset:{type:'dataset',title:'Synthetic instructions',access:{state:'available'},fallbackOf:{kind:'synthetic_fallback',title:'Restricted clinical dataset',reason:'Requires approval'}}});
 const honest={...direction,what_you_would_make:'Reconstruct the template on synthetic stand-in instructions, then change repetitions; these are not empirical findings.',paperBasis:{...paperBasis,limitation:'Invented examples; no claims about real patients.'}};
 const calls=[];const out=await OM.direction(synthetic,credentials,boundary([honest,positive],calls));assert.match(out.what_you_would_make,/synthetic/);
 const dishonest={...honest,what_you_would_make:'Use synthetic data to reproduce the reported clinical improvement.'};
 await assert.rejects(OM.direction(synthetic,credentials,boundary([dishonest,{...positive,resourceHonest:false},dishonest,{...positive,resourceHonest:false}])),{statusCode:502});
});
test('Subgoal footholds remain actionable, ordered, and tied to an actual manipulation',async()=>{
 const subgoals=['Load the Figure 4 instruction and its reference output','Reconstruct the instruction-to-loop transformation','Change repetitions and compare the generated loop'].map(label=>({label,description:'Observable output matches the worked example or its stated variation.',why:'One concrete dependency.'}));
 const out=await OM.subgoals(input({direction}),credentials,boundary([{subgoals,paperBasis},positive]));assert.deepEqual(out.subgoals,subgoals);
});
test('early Brainstorm does not require an extension idea or invent earned observations',async()=>{
 const calls=[];await OM.brainstorm(input({turns:[],assessment:{},brief:[]}),credentials,boundary([{say:'Let us make the transformation tangible.',card:'none',ready:false,interest:''}],calls));
 assert.match(calls[0].messages[0].content[0].text,/need not invent an extension upfront/);assert.match(calls[0].messages[0].content[0].text,/never invented observations/);
});
module.exports={grounding,paperBasis,direction,positive};

test('missing synthetic disclosure gets one correction before an inaccessible plan can persist',async()=>{
 const synthetic=input({asset:{title:'Invented examples',type:'dataset',access:{state:'available'},fallbackOf:{kind:'synthetic_fallback',title:'Private records'}}});
 const missing={...direction,uses:['Invented examples']};const honest={...missing,what_you_would_make:'Reconstruct the template using synthetic stand-in examples; compare repetitions without empirical claims.'};
 const calls=[];const out=await OM.direction(synthetic,credentials,boundary([missing,honest,positive],calls));
 assert.match(out.what_you_would_make,/synthetic/);assert.equal(calls.length,3);assert.match(calls[1].messages[0].content[0].text,/access validation failure/);
});

test('captured ML, HCI and biology plans cite real fixture passages and retain a concrete comparison',()=>{
 const generated=require('./fixtures/paper-grounding/generated.json').cases;
 assert.equal(generated.length,3);
 for(const c of generated){
  assert.equal(c.evidenceFaithful,true,c.id);
  for(const evidence of c.grounding.evidence)assert.ok(c.source.replace(/\s+/g,' ').includes(evidence.quote),c.id+': '+evidence.id);
  const fixtureInput={paper:{grounding:c.grounding}};
  assert.ok(G.basis(c.direction,fixtureInput));assert.ok(G.basis(c.subgoals,fixtureInput));
  assert.equal(G.structuralIssue(c.subgoals,'subgoals',fixtureInput),'');
  assert.match(c.direction.paperBasis.interrogate,/vary|change|compare/i);
  assert.ok(c.direction.paperBasis.extend.length>20);
 }
});

test('Analysis-only planning retains review without requiring invented citations',async()=>{
 const summary={title:'Instruction mapping',one_liner:'Map action and repetition count to an exercise template.'};
 const args=input({paper:summary}),calls=[];
 const made=await OM.planStage('direction','draft',args,null,'',credentials,boundary([direction],calls));
 assert.equal(made.reason,''); assert.equal(made.draft.paperBasis,null);
 const reviewed=await OM.planStage('direction','review',args,made.draft,'',credentials,boundary([positive],calls));
 assert.equal(reviewed.passed,true);assert.equal(calls.length,2);
 assert.match(calls[1].messages[0].content[0].text,/Map action and repetition count/);
 assert.match(calls[1].messages[0].content[0].text,/do not demand missing quotes or evidence IDs/);
 assert.equal(G.structuralIssue({...direction,title:'Read the paper'},'direction',args),'Use concrete research actions, not studying or infrastructure prerequisites');
});
