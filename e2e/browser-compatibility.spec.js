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


test("Paper step accepts dataset files, folders and links and retains the attachment on reload", async ({page}) => {
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
    let release;const paused=new Promise(resolve=>{release=resolve;});
    await page.route('**/fixture/dataset-upload?*',async route=>{await paused;await route.continue();},{times:1});
    await page.getByLabel('Choose project dataset folder',{exact:true}).setInputFiles(folder);
    await expect(page.getByRole('button',{name:/^Continue/})).toBeEnabled();
    release();
    await expect(dataset).toContainText('Attached to project');
    expect(stack.row.dataset_resource.manifest.fileCount).toBe(2);
    expect(stack.row.dataset_resource.manifest.files.map(f=>f.path)).toContain('nested/測定.csv');
    expect(stack.datasetFiles.size).toBe(2);
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
    await expect(dataset).toContainText('Attached to project');
    await page.getByLabel('Choose project dataset file',{exact:true}).setInputFiles({name:'single.csv',mimeType:'text/csv',buffer:Buffer.from('x,y\n1,2\n')});
    await expect(dataset).toContainText('single.csv');
    await expect(dataset).toContainText('Attached to project');
    await page.getByRole('button',{name:'Remove dataset',exact:true}).click();
    await expect(dataset).not.toContainText('Attached to project');
    await page.getByLabel('Dataset or repository URL',{exact:true}).fill('https://data.example/metrics.csv');
    await page.getByRole('button',{name:'Attach link',exact:true}).click();
    await expect(dataset).toContainText('Attached to project');
    expect(stack.row.dataset_resource.source.url).toBe('https://data.example/metrics.csv');
  } finally {await stack.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('local dataset path is saved without a browser file upload',async({page})=>{
 const stack=new SimulationStack();await stack.start();
 try {
  await installBrowserSession(page);await page.goto(stack.url+'/engelbart/setup/?test=true');
  await page.locator('.ob-row').filter({hasText:'Paper'}).click();
  await page.getByText('Enter a path manually instead',{exact:true}).click();
    await page.getByLabel('Local dataset folder path',{exact:true}).fill('~/Desktop/Dataset/dataset');
  await page.getByRole('button',{name:'Use local folder',exact:true}).click();
  await expect(page.getByRole('region',{name:'Project dataset'})).toContainText('Inspected when Engelbart opens locally');
  expect(stack.datasetFiles.size).toBe(0);expect(stack.row.dataset_resource.source.provider).toBe('local_path');
  await page.reload();await page.locator('.ob-row').filter({hasText:'Paper'}).click();
  await expect(page.getByRole('region',{name:'Project dataset'})).toContainText('~/Desktop/Dataset/dataset');
 } finally {await stack.stop();}
});

test('Paper can queue a native dataset picker without typing a path',async({page})=>{
 const stack=new SimulationStack();await stack.start();
 try {
  await installBrowserSession(page);await page.goto(stack.url+'/engelbart/setup/?test=true');
  await page.locator('.ob-row').filter({hasText:'Paper'}).click();
  await page.getByRole('button',{name:'Choose local folder in Engelbart',exact:true}).click();
  await expect(page.getByRole('region',{name:'Project dataset'})).toContainText('Folder selection queued');
  expect(stack.row.dataset_resource.source.provider).toBe('local_picker');expect(stack.datasetFiles.size).toBe(0);
  await page.reload();await page.locator('.ob-row').filter({hasText:'Paper'}).click();
  await expect(page.getByRole('region',{name:'Project dataset'})).toContainText('Folder selection queued');
 } finally {await stack.stop();}
});
