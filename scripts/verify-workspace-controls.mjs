import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
await fs.mkdir('tmp/workspace-controls',{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0,watch:{ignored:['**/tmp/**','**/.local/**']}}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
 await page.evaluate(async()=>{const {demoProject}=await import('/src/model.ts');window.__director.replaceProject(demoProject());});
 assert.deepEqual(await page.locator('.header-actions').evaluate(el=>[...el.children].filter(el=>el.matches('#aspect,#fps,#ai-toggle,#ai-changes-toggle,[data-act=save],[data-act=export]')).map(el=>el.id||el.dataset.act)),['aspect','fps','ai-toggle','ai-changes-toggle','save','export']);
 assert.equal(await page.locator('[data-act=save]').count(),2);assert.equal(await page.locator('[data-act=export]').count(),2);
 for(const key of ['home','top'])assert.equal(await page.locator(`[data-act=${key}] svg`).count(),0);
 assert.equal(await page.locator('.key-tools > *').first().getAttribute('data-act'),'add-camera');
 await page.evaluate(async()=>{await window.__director.callTool('director_view',{entityId:window.__director.getProject().entities[0].id,time:0});});
 const selected=await page.evaluate(()=>window.__director.getEngine().selected);
 await page.locator('[data-inspector-scope=scene]').click();assert(await page.locator('#lighting-ambient').isVisible());
 assert.equal(await page.locator('#inspector-footer [data-act=inspector-return]').count(),0);
 await page.locator('[data-scene-room=width]').fill('10');await page.locator('[data-scene-room=width]').press('Tab');
 assert.equal(await page.evaluate(()=>window.__director.getProject().room.width),10);
 await page.screenshot({path:'tmp/workspace-controls/scene.png'});
 await page.locator('[data-inspector-scope=selection]').click();assert.equal(await page.evaluate(()=>window.__director.getEngine().selected),selected);
 await page.locator('[data-menu=edit]').click();await page.locator('#settings-toggle').click();
 assert.equal(await page.locator('.settings-grid').count(),0);assert(await page.locator('.setting-row').count()>=10);
 await page.locator('[data-preference=rotationSpeed]').fill('1.8');assert.equal(await page.evaluate(()=>window.__director.getEngine().orbit.rotateSpeed),1.8);
 await page.locator('[data-preference=navigationSpeed]').fill('6');
 await page.locator('[data-preference=viewDamping]').uncheck();assert.equal(await page.evaluate(()=>window.__director.getEngine().orbit.enableDamping),false);
 await page.locator('[data-settings-category=editing]').click();
 await page.locator('[data-preference=showNavigationHint]').uncheck();assert(await page.locator('#stage-hint').isHidden());
 await page.locator('[data-settings-category=navigation]').click();
 await page.screenshot({path:'tmp/workspace-controls/settings.png'});
 await page.setViewportSize({width:1280,height:720});
 assert(await page.locator('.preferences-modal').evaluate(root=>{const footer=root.querySelector('.modal-footer').getBoundingClientRect();return [...root.querySelectorAll('.modal-body input,.modal-body button')].every(el=>{const r=el.getBoundingClientRect();return !r.height || r.bottom<=footer.top;});}));
 await page.locator('[data-setting=help]').click();assert(await page.locator('.shortcut-reference').isVisible());assert((await page.locator('.shortcut-reference').textContent()).includes('Ctrl / ⌘ + B'));
 // A reload retains actual preferences and starts with the same navigation bindings.
 await page.reload();await page.waitForFunction(()=>window.__director);
 assert.equal(await page.evaluate(()=>window.__director.getEngine().orbit.rotateSpeed),1.8);
 assert.equal(await page.evaluate(()=>window.__director.getEngine().orbit.enableDamping),false);
 assert(await page.locator('#stage-hint').isHidden());
 await page.evaluate(async()=>{const {editorPreferences}=await import('/src/editor/preferences.ts');editorPreferences.reset();});
 assert.equal(await page.evaluate(()=>window.__director.getEngine().orbit.rotateSpeed),1);assert(await page.locator('#stage-hint').isVisible());
 const rows=()=>page.locator('#timeline-content [data-track-key]').evaluateAll(rows=>rows.map(el=>el.dataset.trackKey));
 const before=await rows(),row=page.locator('#timeline-content [data-track-key]').first(),grip=row.locator('[data-track-grip]');await grip.scrollIntoViewIfNeeded();
 const b=await grip.boundingBox(),r=await row.boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;
 await page.mouse.move(x,y);await page.mouse.down();
 for(const delta of [8,14,22,33]) {
  await page.mouse.move(x,y+delta);
  const ghost=await page.locator('.track-drag-ghost').boundingBox();assert(Math.abs(ghost.y-(r.y+delta))<1,'Lifted row follows every pointer update');
  assert.deepEqual(await rows(),before,'No row reshuffle while dragging');
 }
 assert(await page.locator('.track-drop-line').isVisible());await page.screenshot({path:'tmp/workspace-controls/drag.png'});
 await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('.track-drag-ghost,.track-drop-line').count(),0);assert.deepEqual(await rows(),before);
 assert.equal(await page.locator('html[data-track-reordering]').count(),0);
 await page.setViewportSize({width:1280,height:720});await page.screenshot({path:'tmp/workspace-controls/narrow.png'});
 assert.deepEqual(errors,[]);
 console.log('Workspace controls: visible action order, textual views, scene/selection scope, room edit, real preferences/persistence/reset, shortcut reference and exact drag ghost/cancel cleanup passed.');
}finally{await browser.close();await server.close();}
