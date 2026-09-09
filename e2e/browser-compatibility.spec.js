"use strict";

const { expect, test } = require("@playwright/test");

const { SETUP_CODE, SimulationStack, installBrowserSession } = require("./fixtures/simulation-stack");

const CASES = [
  { os: "macOS", arch: "Apple Silicon", fragment: "install.sh | sh -s -- --code" },
  { os: "Windows", arch: "x64", fragment: "scriptblock]::Create" },
  { os: "Linux", arch: "x64", fragment: "install.sh | sh -s -- --code" },
];

test("the install handoff is operable for every supported desktop OS", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  try {
    await installBrowserSession(page);
    for (const item of CASES) {
      await page.goto(`${stack.url}/engelbart/setup/?test=true`);
      await page.evaluate(() => localStorage.removeItem("engelbart.install"));
      await page.reload();
      await page.locator(".ob-row").filter({ hasText: "Install" }).click();
      await page.getByText(item.os, { exact: true }).click();
      await page.getByText(item.arch, { exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      const command = await page.locator(".ob-cmd-text").textContent();
      expect(command).toContain(item.fragment);
      expect(command).toContain(SETUP_CODE);
      expect(command).toContain("--no-open");
    }
  } finally {
    await stack.stop();
  }
});


test("navigation collapses, remembers its width, and expands with the keyboard", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  try {
    await installBrowserSession(page);
    await page.goto(`${stack.url}/engelbart/setup/?test=true`);
    const rail = page.locator(".ob-rail");
    const before = await rail.boundingBox();
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await expect(rail).toHaveCSS("width", "64px");
    expect((await rail.boundingBox()).width).toBeLessThan(before.width / 2);
    await page.reload();
    await expect(rail).toHaveCSS("width", "64px");
    // Step names remain accessible while their labels are visually hidden.
    await page.getByRole("button", { name: "Paper", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Which paper are you building on?", { exact: true })).toBeVisible();
    const expand = page.getByRole("button", { name: "Expand navigation", exact: true });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Collapse navigation", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect((await rail.boundingBox()).width).toBe(before.width);
    await page.reload();
    await expect(page.getByRole("button", { name: "Collapse navigation", exact: true })).toBeVisible();
  } finally { await stack.stop(); }
});


test("Paper step accepts dataset folders and retains the selection on reload", async ({page}) => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'onboarding-dataset-'));
  const folder=path.join(root,'Research dataset');fs.mkdirSync(path.join(folder,'nested'),{recursive:true});
  fs.writeFileSync(path.join(folder,'nested','測定.csv'),'metric,value\nlatency,1\n');
  fs.writeFileSync(path.join(folder,'labels.json'),'[{"label":"yes"}]');
  const stack=new SimulationStack();await stack.start();
  try {
    await installBrowserSession(page);await page.goto(stack.url+'/engelbart/setup/?test=true');
    await page.locator('.ob-row').filter({hasText:'Paper'}).click();
    const dataset=page.getByRole('region',{name:'Project dataset'});
    await expect(dataset).toBeVisible();
    const chooserEvent=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'Choose dataset folder',exact:true}).click();
    const chooser=await chooserEvent;await chooser.setFiles(folder);
    await expect(dataset).toContainText('Research dataset');
    expect(stack.row.dataset_resource.manifest.fileCount).toBe(2);
    expect(stack.row.dataset_resource.manifest.files.map(f=>f.path)).toContain('nested/測定.csv');
    expect(stack.datasetFiles.size).toBe(0);
    await expect(dataset.locator('.ob-dataset-saved')).toContainText('2 files · Selection saved');
    await expect(page.getByRole('button',{name:'Choose dataset folder',exact:true})).not.toBeVisible();
    const replaceEvent=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'Replace dataset',exact:true}).click();await replaceEvent;
    await expect(dataset.locator('.ob-dataset-saved')).toContainText('Research dataset');
    await page.reload();await page.locator('.ob-row').filter({hasText:'Paper'}).click();
    await expect(dataset).toContainText('Research dataset');
    await page.evaluate(()=>{
      const file={name:'metrics.csv',isFile:true,file:ok=>ok(new File(['x,y\n1,2\n'],'metrics.csv'))};
      const folder={name:'Dropped data',isDirectory:true,createReader:()=>{let read=false;return {readEntries:ok=>{ok(read?[]:[file]);read=true;}}}};
      const event=new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(event,'dataTransfer',{value:{items:[{webkitGetAsEntry:()=>folder}]}});
      document.querySelector('.ob-dataset-drop').dispatchEvent(event);
    });
    await expect(dataset).toContainText('Dropped data');
    expect(stack.datasetFiles.size).toBe(0);
  } finally {await stack.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('dataset plus opens a folder chooser without saving a selection on click or cancel',async({page})=>{
 const stack=new SimulationStack();await stack.start();
 try {
  await installBrowserSession(page);await page.goto(stack.url+'/engelbart/setup/?test=true');
  await page.locator('.ob-row').filter({hasText:'Paper'}).click();
  const picker=page.getByRole('button',{name:'Choose dataset folder',exact:true});
  await expect(picker.locator('.ob-drop-title')).toHaveText('Add your dataset (optional)');
  const before=JSON.stringify(stack.row.dataset_resource);
  const event=page.waitForEvent('filechooser');await picker.click();await event;
  expect(JSON.stringify(stack.row.dataset_resource)).toBe(before);
  expect(stack.datasetFiles.size).toBe(0);
  const section=page.getByRole('region',{name:'Project dataset'});
  await expect(section).not.toContainText('Upload files instead');
  await expect(section).not.toContainText('Enter a path manually instead');
  await expect(section).not.toContainText('Folder selection queued');
  await expect(section).not.toContainText('Remove dataset');
 } finally {await stack.stop();}
});

test('setup loader uses the shared dots at the viewport center',async({page})=>{
 const stack=new SimulationStack();await stack.start();
 try {
  await installBrowserSession(page);
  await page.route('**/api/engelbart-onboarding',route=>route.request().postDataJSON().action==='open'?new Promise(()=>{}):route.continue());
  await page.goto(stack.url+'/engelbart/setup/?test=true');
  const loader=page.locator('.ob-loading');await expect(loader).toBeVisible();
  await expect(loader.locator('.ob-dot')).toHaveCount(9);
  for(const size of [{width:1280,height:900},{width:390,height:844}]){
   await page.setViewportSize(size);
   const box=await loader.locator('.ob-dots').boundingBox();
   expect(Math.abs(box.x+box.width/2-size.width/2)).toBeLessThan(2);
   expect(Math.abs(box.y+box.height/2-size.height/2)).toBeLessThan(2);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(loader.locator('.ob-dot').first()).toHaveCSS('animation-name','none');
 } finally {await stack.stop();}
});
