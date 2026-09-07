'use strict';
// Optional real-provider evaluation using the production model boundary.
// No student invite codes, downloads, or project writes. Report contains no keys.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const OM=require('../api/_lib/onboarding-model');const P=require('../api/_lib/onboarding-prompts');
const cases=require('../tests/fixtures/paper-grounding/cases.json');
async function main(){
 let credentials;
 if(process.argv.includes('--installed-account')){
  const account=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.human-compact','auth.json'),'utf8'));
  const response=await fetch(account.apiBase+'/api/engelbart-credentials',{headers:{Authorization:`Bearer ${account.token}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`Existing account credentials unavailable (${response.status}); no invite code consumed`);
  credentials=await response.json();
 } else credentials={apiKey:process.env.ENGELBART_ANTHROPIC_API_KEY||process.env.LITELLM_API_KEY,baseUrl:process.env.LITELLM_BASE_URL||'https://api.anthropic.com',models:['all-proxy-models']};
 if(!credentials.apiKey)throw Error('No model credential available; no live evaluation performed');
 const output=process.argv.find(a=>a.endsWith('.json'))||'/private/tmp/paper-grounding-evaluation.json';
 const reports=[];
 for(const c of cases.filter(c=>!process.env.PAPER_EVAL_CASE || c.id===process.env.PAPER_EVAL_CASE)){
  const started=Date.now();
  try{
   const grounding=await OM.paperGrounding({pdfText:c.paperText},credentials);
   // Quotes are checked against this fixture's source, independently of the model review.
   const evidenceFaithful=grounding.evidence.every(e=>c.paperText.replace(/\s+/g,' ').includes(e.quote));
   const input={reader:{name:'Student',depth:'everyday',knowledge:[]},paper:{title:c.id,one_liner:grounding.contribution},asset:c.asset,interest:'I barely understand the paper; make an important part tangible.',assessment:{areas:[]},turns:[],leveled:null};
   const before=OM.normalizeDirection(await OM.callModel({purpose:'paper_grounding_before',family:'sonnet',content:[{type:'text',text:P.directionPrompt(input)+(c.asset.fallbackOf?.kind==='synthetic_fallback'?'\n\nThe selected resource is a SYNTHETIC STAND-IN. Explicitly call it synthetic or a stand-in in the Direction description. Scope the first subgoals/todos to testing or learning the mechanism on invented examples. Never imply observations or research conclusions about the inaccessible original. Do not make acquiring the original a human prerequisite.':'')}]},credentials));
   input.paper.grounding=grounding;
   const direction=await OM.direction(input,credentials);
   const subgoals=await OM.subgoals({...input,direction},credentials);
   reports.push({id:c.id,domain:c.domain,source:c.paperText,grounding,evidenceFaithful,before,direction,subgoals,elapsedSeconds:(Date.now()-started)/1000});
   console.log(c.id+': generated; source quotes '+(evidenceFaithful?'match':'NEED REVIEW'));
  }catch(error){reports.push({id:c.id,error:String(error.message).slice(0,300)});console.log(c.id+': evaluation failed');}
  fs.writeFileSync(output,JSON.stringify(reports,null,2)+'\n',{mode:0o600});
 }
 if(reports.some(r=>r.error||!r.evidenceFaithful))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
