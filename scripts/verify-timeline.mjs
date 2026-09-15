import assert from 'node:assert/strict';
export async function verifyTimeline(page,baseline) {
 const project=()=>page.evaluate(()=>window.__director.getProject());
 await page.evaluate(p=>window.__director.replaceProject(p),baseline);baseline=await project();
 const restore=async()=>{await page.evaluate(p=>window.__director.replaceProject(p),baseline);await page.locator('#timeline-mode').selectOption('edit');await page.locator('#timeline-zoom').selectOption('1');await page.evaluate(()=>{document.querySelector('#timeline-content').scrollLeft=0;});};
 const ruler=()=>page.locator('.ruler').boundingBox();
 for(const zoom of ['0.25','1','4','16']) {
  await restore();await page.locator('#timeline-zoom').selectOption(zoom);
  await page.evaluate(()=>window.__director.setTime(12));await page.locator('#timeline-center').click();
  const r=await ruler(),v=await page.locator('#timeline-content').boundingBox(),x=v.x+v.width*.5;
  await page.mouse.move(x,r.y+8);await page.mouse.down();
  const t0=await page.evaluate(()=>window.__director.getEngine().time);
  await page.mouse.move(x+180,r.y+8,{steps:6});await page.mouse.up();
  const t1=await page.evaluate(()=>window.__director.getEngine().time);
  assert.ok(Math.abs((t1-t0)*60*Number(zoom)-180)<=60*Number(zoom)/24+.1,`1:1 playhead movement at zoom ${zoom}`);
  assert.deepEqual(await project(),baseline);
 }
 await restore();
 let r=await ruler();const v=await page.locator('#timeline-content').boundingBox();
 await page.mouse.move(r.x+4*60,r.y+8);await page.mouse.down();await page.mouse.move(v.x+v.width-5,r.y+8);
 await page.waitForFunction(()=>document.querySelector('#timeline-content').scrollLeft>200);
 const a=await page.evaluate(()=>window.__director.getEngine().time);await page.waitForTimeout(400);const b=await page.evaluate(()=>window.__director.getEngine().time);
 assert.ok(b>a+1,'stationary pointer at edge keeps scrolling');await page.mouse.up();assert.deepEqual(await project(),baseline);
 await restore();r=await ruler();await page.mouse.click(r.x+19*60,r.y+8);assert.equal(await page.evaluate(()=>window.__director.getEngine().time),19);assert.equal((await project()).duration,15);
 // Isolated action: moving should match the mouse and extend the project.
 const p=structuredClone(baseline),actor=p.entities[0];actor.clips=[{id:actor.clips[0].id,start:2,end:4,action:'walk',speed:1}];
 await page.evaluate(p=>window.__director.replaceProject(p),p);await page.evaluate(()=>document.querySelector('#timeline-content').scrollLeft=0);
 let bar=page.locator(`[data-clip-id="${actor.clips[0].id}"]`),box=await bar.boundingBox();
 await page.mouse.move(box.x+20,box.y+10);await page.mouse.down();await page.mouse.move(box.x+320,box.y+10,{steps:5});await page.mouse.up();
 assert.equal((await project()).entities[0].clips[0].start,7);
 await page.locator('[data-act="undo"]').click();assert.deepEqual(await project(),p);
 await bar.click();assert.equal(await page.locator('[data-inspector-section="clips"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#basic-clip-choice').inputValue(),actor.clips[0].id);await page.evaluate(()=>window.__director.setTime(3));await page.locator('#timeline-content').focus();await page.keyboard.press('Control+b');
 assert.equal((await project()).entities[0].clips.length,2);assert.equal(await page.locator('.clip-selected').count(),1);
 await page.keyboard.press('Delete');assert.equal((await project()).entities[0].clips.length,1);assert.equal((await project()).entities.length,p.entities.length);
 await restore();
 const path=page.locator(`[data-path-id="${baseline.entities[1].id}"]`);await path.scrollIntoViewIfNeeded();await path.click();await page.evaluate(()=>window.__director.setTime(3));await page.locator('#timeline-content').focus();await page.keyboard.press('Control+b');
 assert.equal((await project()).entities[1].path.sections.length,2);
 await page.locator('#timeline-trim').click();await page.locator('#clip-start').fill('20');await page.locator('#clip-end').fill('23');await page.locator('#apply-clip-time').click();
 assert.equal((await project()).entities[1].path.sections[1].start,20);assert.equal((await project()).duration,23);
 const edited=await project(),savedDocument=await page.evaluate(()=>window.__director.getDocument());const download=page.waitForEvent('download');await page.locator('[data-act="save"]').click();const file=await download;const stream=await file.createReadStream();let json='';for await(const chunk of stream)json+=chunk;assert.deepEqual(JSON.parse(json),savedDocument);
 await page.locator('[data-act="undo"]').click();assert.equal((await project()).entities[1].path.sections[1].start,3);
 await page.locator('[data-act="redo"]').click();assert.deepEqual(await project(),edited);
 // Cancel a drag after edge scrolling: no partial project mutation survives.
 await page.evaluate(()=>{document.querySelector('#timeline-content').scrollLeft=0;});
 const first=page.locator(`[data-path-id="${baseline.entities[1].id}"][data-section="0"]`);await first.scrollIntoViewIfNeeded();box=await first.boundingBox();
 await page.mouse.move(box.x+8,box.y+6);await page.mouse.down();await page.mouse.move(1670,box.y+6);await page.waitForTimeout(200);await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await project(),edited);

 await restore();await page.locator('[data-cut="2"]').dblclick();await page.locator('#clip-duration').fill('8');await page.locator('#apply-clip-time').click();
 assert.equal((await project()).duration,18);assert.deepEqual((await project()).entities,baseline.entities);
 await page.locator('[data-cut="2"] .resize-handle').scrollIntoViewIfNeeded();box=await page.locator('[data-cut="2"] .resize-handle').boundingBox();
 await page.mouse.move(box.x+3,box.y+8);await page.mouse.down();await page.mouse.move(box.x+123,box.y+8);await page.mouse.up();assert.equal((await project()).duration,20);
 // Overlap is resolved during the drag, rather than rejected when releasing it.
 await restore();
 const crowded=structuredClone(baseline),owner=crowded.entities[0];
 owner.clips=[{id:'drag-overlap',start:0,end:2,action:'walk',speed:1},{id:'occupied',start:3,end:6,action:'idle',speed:1}];
 await page.evaluate(p=>window.__director.replaceProject(p),crowded);
 bar=page.locator('[data-clip-id="drag-overlap"]');await bar.scrollIntoViewIfNeeded();box=await bar.boundingBox();
 await page.mouse.move(box.x+15,box.y+8);await page.mouse.down();await page.mouse.move(box.x+255,box.y+8,{steps:8});await page.mouse.up();
 assert.equal((await project()).entities[0].clips[0].start,6);
 assert.deepEqual((await project()).entities[0].clips[1],owner.clips[1]);
 await page.locator('[data-act="undo"]').click();assert.deepEqual(await project(),crowded);
 // Resize at the right edge continues with a stationary pointer, including past scene end.
 // Exercise action, actor path, camera path and final cut using the same interaction.
 for(const kind of ['action','actor-path','camera-path','cut']) for(const zoom of ['0.25','4']) {
  await restore();const fixture=structuredClone(baseline);fixture.duration=2;fixture.cuts=fixture.cuts.slice(0,1);
  const entity=fixture.entities.find(e=>e.kind===(kind==='camera-path'?'camera':'actor'));
  let selector;
  if(kind==='action'){entity.clips=[{id:'edge-resize',start:0,end:1,action:'walk',speed:1}];selector='[data-clip-id="edge-resize"]';}
  else if(kind==='cut')selector='[data-cut="0"]';
  else {if(entity.camera)entity.camera.mode='free';entity.path={points:[{time:0,position:[0,0,0]},{time:1,position:[1,0,0]}],smooth:false};selector=`[data-path-id="${entity.id}"]`;}
  await page.evaluate(p=>window.__director.replaceProject(p),fixture);await page.locator('#timeline-zoom').selectOption(zoom);
  await page.evaluate(()=>document.querySelector('#timeline-content').scrollLeft=0);
  const handle=page.locator(`${selector} .resize-handle`);await handle.scrollIntoViewIfNeeded();box=await handle.boundingBox();
  const viewport=await page.locator('#timeline-content').boundingBox();
  await page.mouse.move(box.x+3,box.y+6);await page.mouse.down();await page.mouse.move(viewport.x+viewport.width-8,box.y+6,{steps:6});
  const scroll0=await page.evaluate(()=>document.querySelector('#timeline-content').scrollLeft);
  await page.waitForFunction(n=>document.querySelector('#timeline-content').scrollLeft>n+200,scroll0);
  await page.mouse.up();
  const edited=await project();assert.ok(edited.duration>2,`${kind} resize extends scene at zoom ${zoom}`);
  if(kind==='action')assert.equal(edited.entities.find(e=>e.id===entity.id).clips[0].start,0);
  await page.locator('[data-act="undo"]').click();assert.deepEqual(await project(),fixture,`${kind} resize is one undo`);
 }
 // Wheel panning with a held resize handle must update the endpoint even without pointermove.
 await restore();const wheelFixture=structuredClone(baseline);wheelFixture.entities[0].clips=[{id:'wheel-resize',start:0,end:2,action:'walk',speed:1}];
 await page.evaluate(p=>window.__director.replaceProject(p),wheelFixture);
 const handle=page.locator('[data-clip-id="wheel-resize"] .resize-handle');await handle.scrollIntoViewIfNeeded();box=await handle.boundingBox();
 await page.mouse.move(box.x+3,box.y+6);await page.mouse.down();await page.mouse.wheel(0,180);
 await page.waitForFunction(()=>window.__director.getProject().entities[0].clips[0].end===5);
 await page.mouse.wheel(0,-60);await page.waitForFunction(()=>window.__director.getProject().entities[0].clips[0].end===4);
 await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await project(),wheelFixture);
 // A narrow clip must retain its actual time width, with distinct body and end-handle hits.
 await restore();const narrow=structuredClone(baseline);
 narrow.entities[0].clips=[{id:'narrow-hit',start:2,end:3,action:'walk',speed:1}];
 await page.evaluate(p=>window.__director.replaceProject(p),narrow);await page.locator('#timeline-zoom').selectOption('0.25');
 await page.evaluate(()=>document.querySelector('#timeline-content').scrollLeft=0);
 const narrowBar=page.locator('[data-clip-id="narrow-hit"]');await narrowBar.scrollIntoViewIfNeeded();box=await narrowBar.boundingBox();
 assert.ok(Math.abs(box.width-15)<.1,'short clip width follows time, without padding inflation');
 const grip=await narrowBar.locator('.resize-handle').boundingBox(),y=box.y+6;
 assert.equal(await page.evaluate(({x,y})=>getComputedStyle(document.elementFromPoint(x,y)).cursor,{x:box.x+box.width*.3,y}),'default');
 assert.equal(await page.evaluate(({x,y})=>getComputedStyle(document.elementFromPoint(x,y)).cursor,{x:grip.x+grip.width/2,y}),'ew-resize');
 await page.mouse.move(box.x+box.width*.3,y);await page.mouse.down();await page.mouse.move(box.x+100,y,{steps:5});
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.resize-handle')).cursor),'grabbing','move cursor stays fixed across redraws and handles');
 await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await project(),narrow);
 await page.mouse.move(grip.x+grip.width/2,y);await page.mouse.down();await page.mouse.move(grip.x+100,y,{steps:5});
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.timeline-clip span')).cursor),'ew-resize','resize cursor stays fixed over clip bodies');
 await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await project(),narrow);
 assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-timeline-drag')),false);
 // Moving the first shot past the second keeps both durations and follows the selected shot.
 await restore();const lengths=p=>p.cuts.map((c,i)=>({camera:c.cameraId,duration:(p.cuts[i+1]?.time??p.duration)-c.time})).sort((a,b)=>a.camera.localeCompare(b.camera));
 bar=page.locator('[data-cut="0"]');box=await bar.boundingBox();
 await page.mouse.move(box.x+40,box.y+8);await page.mouse.down();await page.mouse.move(box.x+40+6*60,box.y+8,{steps:8});await page.mouse.up();
 const reordered=await project();assert.notEqual(reordered.cuts[0].cameraId,baseline.cuts[0].cameraId);
 assert.deepEqual(lengths(reordered),lengths(baseline));assert.deepEqual(reordered.entities,baseline.entities);
 assert.equal(Number(await page.locator('.cut.clip-selected').getAttribute('data-cut')),reordered.cuts.findIndex(c=>c.cameraId===baseline.cuts[0].cameraId));
 await page.locator('[data-act="undo"]').click();assert.deepEqual(await project(),baseline);
 // A middle shot's resize moves subsequent starts but never shortens the next shot.
 const middle=page.locator('[data-cut="1"] .resize-handle');await middle.scrollIntoViewIfNeeded();box=await middle.boundingBox();
 await page.mouse.move(box.x+3,box.y+6);await page.mouse.down();await page.mouse.move(box.x+123,box.y+6,{steps:6});await page.mouse.up();
 const resized=await project();assert.equal(resized.duration,baseline.duration+2);
 assert.equal(resized.cuts[1].time,baseline.cuts[1].time);assert.equal(resized.cuts[2].time,baseline.cuts[2].time+2);
 assert.deepEqual(resized.entities,baseline.entities);await page.locator('[data-act="undo"]').click();assert.deepEqual(await project(),baseline);
 // Release outside the viewport / lost capture must stop both the edit and global cursor.
 for(const end of ['capture','buttons','mouseup','cancel']) {
  const fixture=structuredClone(baseline);fixture.entities[0].clips=[{id:'release-test',start:1,end:3,action:'walk',speed:1}];
  await page.evaluate(p=>window.__director.replaceProject(p),fixture);await page.locator('#timeline-zoom').selectOption('1');
  await page.evaluate(()=>{document.querySelector('#timeline-content').scrollLeft=0;document.addEventListener('pointerdown',e=>window.__testPointerId=e.pointerId,{once:true,capture:true});});
  const releaseBar=page.locator('[data-clip-id="release-test"]');await releaseBar.scrollIntoViewIfNeeded();const r=await releaseBar.boundingBox();
  await page.mouse.move(r.x+20,r.y+8);await page.mouse.down();await page.mouse.move(r.x+80,r.y+8);
  await page.evaluate(({end,x,y})=>{
   const timeline=document.querySelector('#timeline-content'),pointerId=window.__testPointerId;
   if(end==='capture')timeline.releasePointerCapture(pointerId);
   if(end==='buttons')document.dispatchEvent(new PointerEvent('pointermove',{pointerId,buttons:0,clientX:x,clientY:y,bubbles:true}));
   if(end==='mouseup')window.dispatchEvent(new MouseEvent('mouseup',{button:0,bubbles:true}));
   if(end==='cancel')document.dispatchEvent(new PointerEvent('pointercancel',{pointerId,bubbles:true}));
  },{end,x:r.x+90,y:r.y+8});
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-timeline-drag'));
  const released=await project();await page.mouse.move(r.x+150,r.y+8);await page.mouse.up();
  assert.deepEqual(await project(),released,`${end}: movement after release cannot keep editing`);
  assert.equal(await page.locator('[data-clip-id="release-test"]').evaluate(el=>getComputedStyle(el).cursor),'default');
  if(end==='cancel')assert.deepEqual(released,fixture);else{assert.equal(released.entities[0].clips[0].start,2);await page.locator('[data-act="undo"]').click();assert.deepEqual(await project(),fixture,`${end}: one undo restores drag`);}
 }
 await page.screenshot({path:'tmp/smoke/10-timeline-editing.png'});
 console.log('Verified 1:1 drag at four zooms, stationary edge scrolling, browsing 19s, clip movement/undo, Ctrl+B, deletion, split path retiming, direct shot duration and edge resize.');
 await restore();
}
