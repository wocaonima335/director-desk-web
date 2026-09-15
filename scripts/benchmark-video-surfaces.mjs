import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

// Supply a synthetic, locally generated 1080p clip; no project or private media is scanned.
const bytes=[...await fs.readFile(process.argv[2]??'tmp/media-performance-fixture.mp4')];
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
 const result=await page.evaluate(async bytes=>{
  const {entity}=await import('/src/model.ts'),{createScene}=await import('/src/scenes.ts'),{importMedia}=await import('/src/media/source.ts'),{defaultSurfaceLayer}=await import('/src/media/model.ts');
  const resource=await importMedia(new File([new Uint8Array(bytes)],'synthetic.mp4',{type:'video/mp4'}));
  const p=createScene('blank');p.duration=3;p.media=[resource];
  const camera=p.entities.find(e=>e.camera);camera.position=[0,7,17];camera.camera.target=[0,3,0];
  for(let i=0;i<16;i++){const e=entity('prop','cube','屏幕 '+i,[(i%4-1.5)*3,Math.floor(i/4)*2,0]);e.scale=[2,1.5,.3];e.surface={layers:[{...defaultSurfaceLayer(resource.id),unlit:true,mapping:'box',timeOffset:(i%4)*.1}]};p.entities.push(e);}
  for(let i=0;i<60;i++){const e=entity('prop','cube','布景 '+i,[(i%10-5)*3,0,Math.floor(i/10)*3-14]);p.entities.push(e);}
  const dust=entity('prop','visual-dust','微粒',[0,4,0]);dust.visual.count=4000;dust.visual.spread=18;p.entities.push(dust);
  const api=window.__director;api.replaceProject(p);const engine=api.getEngine();engine.exporting=true;await engine.prepareOutput(0);engine.renderOutput(0,1280,720);
  const frames=[],timings=[],start=performance.now();for(let i=0;i<60;i++){const at=performance.now();await engine.prepareOutput(i/30);const ready=performance.now();engine.renderOutput(i/30,1280,720);const done=performance.now();timings.push({frame:i,decodeMs:ready-at,renderMs:done-ready});frames.push(done-at);}
  const runtime=engine.surfaces.textures.statistics();frames.sort((a,b)=>a-b);const stats={elapsedMs:performance.now()-start,medianMs:frames[30],p95Ms:frames[57],timings,entities:p.entities.length,sourceSize:[resource.width,resource.height],runtime};
  api.replaceProject(createScene('blank'));await engine.prepareOutput(0);stats.released=engine.surfaces.textures.statistics();engine.restorePreview(0);return stats;
 },bytes);
 assert.equal(result.runtime.sources,1);assert.equal(result.runtime.textures,4);assert.ok(result.runtime.seeks<=8,JSON.stringify(result));assert.deepEqual(result.runtime.errors,[]);assert.equal(result.released.textures,0);assert.deepEqual(errors,[]);
 await fs.writeFile('tmp/video-surfaces-benchmark.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await server.close();}
