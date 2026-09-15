import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
const server=await createServer({server:{host:'127.0.0.1',port:0,watch:{ignored:['**/tmp/**','**/.local/**']}}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
 await page.evaluate(async()=>{
  const {demoProject,clone}=await import('/src/model.ts'),{includeMotionResources,insertBuiltinMotion}=await import('/src/animation/motion-presets.ts'),{readSceneDocument}=await import('/src/scenes/sequence-project.ts');
  const p=await includeMotionResources(demoProject()),actor=p.entities.find(e=>e.kind==='actor');actor.clips=[];insertBuiltinMotion(p,actor.id,'human-sit-idle-v1',0,4);
  const doc=readSceneDocument(p);for(let i=1;i<6;i++)doc.scenes.push({...clone(doc.scenes[0]),id:'maintenance-'+i,name:'测试戏段 '+i});
  await window.__director.getEngine().externalModels.prepare(p);window.__director.replaceProject(doc);
  const e=window.__director.getEngine();window.__draws=0;window.__samples=0;const sample=e.sample,frame=e.onFrame;
  e.sample=function(...args){window.__samples++;return sample.apply(this,args);};e.onFrame=function(){window.__draws++;return frame.call(this);};
 });
 await page.waitForTimeout(500);await page.evaluate(()=>{window.__samples=0;window.__draws=0;});await page.waitForTimeout(500);
 assert.deepEqual(await page.evaluate(()=>[window.__samples,window.__draws]),[0,0],'paused scene does not sample or draw repeatedly');
 const ids=await page.evaluate(()=>{const p=window.__director.getProject();return {actor:p.entities[0].id,cameras:p.entities.filter(e=>e.camera).map(e=>e.id)};});
 const redraw=async run=>{const before=await page.evaluate(()=>window.__draws);await run();await page.waitForFunction(n=>window.__draws>n,before);};
 await redraw(()=>page.evaluate(id=>window.__director.setPreview(id),ids.cameras[1]));
 await redraw(()=>page.evaluate(()=>window.__director.setTime(3)));
 await redraw(()=>page.locator('[data-view="shot"]').click());await redraw(()=>page.locator('[data-view="split"]').click());
 await redraw(()=>page.evaluate(()=>window.__director.getEngine().setPreviewQuality('draft')));
 await redraw(()=>page.evaluate(()=>window.__director.getEngine().setPreviewQuality('full')));
 await page.locator('#stage-canvas canvas').click({position:{x:40,y:80}});
 const beforeNavigation=await page.evaluate(()=>window.__director.getEngine().editorCamera.position.toArray());
 await page.keyboard.down('w');
 try {await page.waitForFunction(before=>window.__director.getEngine().editorCamera.position.distanceTo({x:before[0],y:before[1],z:before[2]})>.15,beforeNavigation);} finally {await page.keyboard.up('w');}
 const boundary=await page.locator('[data-boundary="split"]').boundingBox();
 await redraw(async()=>{await page.mouse.move(boundary.x+boundary.width/2,boundary.y+boundary.height/2);await page.mouse.down();await page.mouse.move(boundary.x+boundary.width/2+60,boundary.y+boundary.height/2,{steps:4});await page.mouse.up();});
 const edit=async operations=>page.evaluate(async operations=>{const api=window.__director,r=await api.callTool('director_read');const result=await api.callTool('director_apply',{revision:r.data.revision,requestId:crypto.randomUUID(),operations});if(!result.ok)throw Error(result.error);return result.data;},operations);
 await redraw(()=>edit([{operation:'project',patch:{referenceLabels:true}}]));
 await redraw(()=>edit([{operation:'update',id:ids.cameras[1],patch:{camera:{hideWalls:['ceiling','south']}}}]));
 const lighting=await page.evaluate(async()=>(await import('/src/lighting/model.ts')).defaultLighting());
 await redraw(()=>edit([{operation:'project',patch:{lighting:{...lighting,exposure:1.3}}}]));
 // Read-only revision queries must not serialize resource payloads.
 assert.equal(await page.evaluate(async()=>{const api=window.__director,p=api.getEngine().project,resource=p.resources[0];Object.defineProperty(resource.package,'toJSON',{configurable:true,value:()=>{throw Error('Unexpected source serialization');}});try{return (await api.callTool('director_read')).ok;}finally{delete resource.package.toJSON;}}),true);
 const read=await page.evaluate(()=>window.__director.callTool('director_read'));
 await edit([{operation:'update',id:ids.actor,patch:{name:'维护测试人物'}}]);
 const stale=await page.evaluate(async r=>window.__director.callTool('director_apply',{revision:r,requestId:'stale-maintenance',operations:[{operation:'project',patch:{duration:20}}]}),read.data.revision);
 assert.equal(stale.ok,false);assert.match(stale.error,/REVISION_CONFLICT/);
 await page.evaluate(async()=>{const {SceneWorkspace}=await import('/src/scenes/scene-workspace.ts');const method=SceneWorkspace.prototype.document;window.__captures=0;SceneWorkspace.prototype.document=function(){window.__captures++;return method.call(this);};});
 await page.locator('#timeline-zoom').selectOption('1');const bar=page.locator(`[data-entity="${ids.actor}"][data-clip-id]`).first();await bar.scrollIntoViewIfNeeded();const box=await bar.boundingBox();
 await page.mouse.move(box.x+70,box.y+9);await page.mouse.down();await page.mouse.move(box.x+100,box.y+9);await page.evaluate(()=>window.__captures=0);
 await page.waitForTimeout(750);assert.equal(await page.evaluate(()=>window.__captures),0,'pending gesture defers recovery snapshot capture');
 await page.mouse.up();await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='自动恢复已保存');
 const recovered=await page.evaluate(async()=>{const {recover}=await import('/src/storage.ts');return {saved:await recover(),current:window.__director.getDocument()};});assert.deepEqual(recovered.saved,recovered.current,'recovery retains all scenes and embedded resource data');
 // A prepared write must reject results if the document changed while awaiting resources.
 assert.equal(await page.evaluate(async()=>{const api=window.__director,e=api.getEngine(),prepare=e.externalModels.prepare;let release;const gate=new Promise(r=>release=r);e.externalModels.prepare=async()=>gate;
  try {const r=await api.callTool('director_read'),id=api.getProject().entities.find(e=>e.kind==='actor').id;const pending=api.callTool('director_apply',{revision:r.data.revision,requestId:'async-maintenance',operations:[{operation:'motion',id,asset:'basic-wave',time:6}]});await new Promise(r=>setTimeout(r,30));api.replaceProject(api.getDocument());release();return (await pending).error;}finally{e.externalModels.prepare=prepare;release?.();}}).then(error=>/REVISION_CONFLICT/.test(error??'')),true);
 assert.deepEqual(errors,[]);console.log('Verified paused redraw, live camera/lighting/labels, constant-size revisions, async conflicts, deferred and complete multi-scene recovery with real animation resources.');
} finally {await browser.close();await server.close();}
