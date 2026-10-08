import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const out=resolve(process.argv[2] || '/tmp/perabyte-production-design');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PW_EXECUTABLE || undefined});
const results=[];
try {
 for(const width of [375,768,1280,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(resolve('docs/production/preview.html')).href);
  for(const stage of ['project','story','shots','review','finish']) {
   await page.locator(`.step[data-page="${stage}"]`).click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}/${stage} overflow`);
   assert.equal(await page.locator('.page-panel.active').count(),1);
  }
  await page.locator('.step[data-page="review"]').click();
  await page.screenshot({path:resolve(out,`review-${width}.png`),fullPage:true});
  for(let i=0;i<6;i++) {
   await page.locator(`.shot-card[data-shot="${i}"]`).click();
   if(await page.locator('#approveButton').isEnabled()) await page.locator('#approveButton').click();
  }
  await page.locator('#saveErrorButton').click();
  await page.locator('#rejectButton').click();
  assert.equal(await page.locator('#approveButton').isDisabled(),true,'save failure must block approval');
  await page.locator('#saveErrorButton').click();
  await page.locator('#approveButton').click();
  await page.locator('.step[data-page="finish"]').click();
  await page.locator('.finish-tab[data-tab="export"]').click();
  assert.equal(await page.locator('#exportButton').isDisabled(),true,'illustrations alone cannot export');
  assert.equal(errors.length,0,errors.join('\n'));
  results.push({width,stages:5,overflow:false,saveFailureBlocksApproval:true,illustrationOnlyExportBlocked:true,pageErrors:errors});
  await page.close();
 }
 await writeFile(resolve(out,'report.json'),JSON.stringify({scope:'standalone design prototype only; not application or film validation',results},null,2)+'\n');
 console.log(JSON.stringify({passed:true,viewports:results.length,output:out}));
} finally {await browser.close();}
