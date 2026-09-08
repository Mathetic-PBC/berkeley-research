"use strict";
const {test,expect}=require("@playwright/test");
const {SimulationStack,installBrowserSession}=require("./fixtures/simulation-stack");

test("Analysis starts shared grounding before Direction; reload and the visible flow join it",async({page})=>{
  const stack=new SimulationStack();await stack.start();
  let releaseAnalysis, starts=0, polls=0, hunts=0, grounded=false;
  const row=stack.row;
  const direction=row.direction;
  const asset={title:"Reference code",type:"code",description:"A runnable reference",links:[],availability:"usable"};
  const analysis={title:"Inspectable intent",one_liner:"A mechanism for inspecting goals",areas:[{area:"Goal inference",project_role:"The mechanism",questions:[{level:0,question:"What would a goal describe?"}]}]};
  const evidence={contribution:"Infer editable goals",evidence:[{kind:"method",claim:"Infer goals from turns",quote:"Infer goals from turns",location:"Methods"}]};
  Object.assign(row,{step:4,analysis:null,analysis_status:"none",assessment:null,direction:null,asset_chosen:null,leveled:null,leveled_status:"none",planning:{}});
  await installBrowserSession(page);
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/api/engelbart-onboarding",async route=>{
    const b=route.request().postDataJSON();
    if(b.action==="sources") return route.fulfill({json:{ok:true,analysis_status:"none"}});
    if(b.action==="analysis"){
      row.analysis_status="running";
      if(b.run) await new Promise(resolve=>releaseAnalysis=resolve);
      row.analysis_status="done";row.analysis=analysis;
      return route.fulfill({json:{analysis_status:"done",analysis}});
    }
    if(b.action==="assets"){hunts++;return route.fulfill({json:{assets_status:"done",assets:{assets:[asset]}}});}
    if(b.action==="paper_grounding"){
      if(b.run){starts++;row.planning.paper_grounding={status:"running"};}else polls++;
      if(grounded){row.analysis={...analysis,grounding:evidence};row.planning.paper_grounding={status:"done"};}
      return route.fulfill({json:{grounding_status:grounded?"done":"running",...(grounded?{grounding:evidence}:{})}});
    }
    if(b.action==="topics_done"){row.assessment=null;row.step=8;return route.fulfill({json:{assessment:null}});}
    if(b.action==="leveled"){row.leveled={assets:[asset]};row.leveled_status="done";return route.fulfill({json:{leveled_status:"done",leveled:row.leveled}});}
    if(b.action==="choose_asset"){row.asset_chosen={...asset,key:asset.title};row.step=9;return route.fulfill({json:{asset_chosen:row.asset_chosen}});}
    if(b.action==="plan"){
      return route.fulfill({json:grounded?{status:"complete",direction}:{status:"running",stage:"grounding",message:"Reading the paper"}});
    }
    return route.continue();
  });
  try{
    await page.goto(stack.url+"/engelbart/setup/?test=true");
    await page.locator("#content .ob-cta").click();
    await expect(page.getByText("Which computer are you on?",{exact:true})).toBeVisible();
    await expect.poll(()=>hunts).toBe(1);
    expect(starts).toBe(0);
    releaseAnalysis();
    await expect.poll(()=>starts).toBe(1);
    await page.reload();
    await expect.poll(()=>polls).toBeGreaterThan(0);
    expect(starts).toBe(1);
    await page.locator(".ob-row").filter({hasText:"Brainstorm"}).click();
    await expect(page.getByText("What do you want to build?",{exact:true})).toBeVisible();
    await page.locator("#content .ob-cta").click();
    await expect(page.getByText("How familiar are you with the paper's concepts?",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Skip Topics",exact:true}).click();
    await expect(page.getByText("Select which resource to start with",{exact:true})).toBeVisible();
    await page.locator(".ob-as-row").first().click();
    await page.locator("#content .ob-cta").click();
    await expect(page.getByText("Reading the paper",{exact:true})).toBeVisible();
    expect(starts).toBe(1);
    grounded=true;
    await expect(page.getByText(direction.title,{exact:true})).toBeVisible();
    expect(starts).toBe(1);
    expect(errors).toEqual([]);
  }finally{if(releaseAnalysis)releaseAnalysis();await stack.stop();}
});
