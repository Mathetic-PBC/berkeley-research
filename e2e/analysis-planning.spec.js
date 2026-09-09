"use strict";
const {test,expect}=require("@playwright/test");
const {SimulationStack,installBrowserSession}=require("./fixtures/simulation-stack");

test("Analysis and Assets stay parallel; reload and planning make no full-paper request",async({page})=>{
  const stack=new SimulationStack();await stack.start();
  let releaseAnalysis, starts=0, hunts=0;
  const row=stack.row;
  const direction=row.direction;
  const asset={title:"Reference code",type:"code",description:"A runnable reference",links:[],availability:"usable"};
  const analysis={title:"Inspectable intent",one_liner:"A mechanism for inspecting goals",areas:[{area:"Goal inference",project_role:"The mechanism",questions:[{level:0,question:"What would a goal describe?"}]}]};

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
    if(b.action==="paper_grounding"){starts++;return route.fulfill({status:400,json:{error:"Retired action"}});}
    if(b.action==="topics_done"){row.assessment=null;row.step=8;return route.fulfill({json:{assessment:null}});}
    if(b.action==="leveled"){row.leveled={assets:[asset]};row.leveled_status="done";return route.fulfill({json:{leveled_status:"done",leveled:row.leveled}});}
    if(b.action==="choose_asset"){row.asset_chosen={...asset,key:asset.title};row.step=9;return route.fulfill({json:{asset_chosen:row.asset_chosen}});}
    if(b.action==="plan"){
      return route.fulfill({json:{status:"complete",direction}});
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
    await expect.poll(()=>row.analysis_status).toBe("done");
    await page.reload();
    expect(starts).toBe(0);
    await page.locator(".ob-row").filter({hasText:"Brainstorm"}).click();
    await expect(page.getByText("What do you want to build?",{exact:true})).toBeVisible();
    await page.locator("#content .ob-cta").click();
    await expect(page.getByText("How familiar are you with the paper's concepts?",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Skip Topics",exact:true}).click();
    await expect(page.getByText("Select which resource to start with",{exact:true})).toBeVisible();
    await page.locator(".ob-as-row").first().click();
    await page.locator("#content .ob-cta").click();
    expect(starts).toBe(0);
    await expect(page.getByText(direction.title,{exact:true})).toBeVisible();
    expect(starts).toBe(0);
    expect(errors).toEqual([]);
  }finally{if(releaseAnalysis)releaseAnalysis();await stack.stop();}
});
