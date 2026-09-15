import assert from 'node:assert/strict';
import {createServer} from 'vite';import {chromium} from 'playwright-core';import fs from 'node:fs/promises';
await fs.mkdir('tmp/timeline-performance',{recursive:true});
const s=await createServer({server:{host:'127.0.0.1',port:0}});await s.listen();const b=await chromium.launch({channel:'chrome',headless:true});
try{const p=await b.newPage({viewport:{width:1600,height:1000}});await p.goto(`http://127.0.0.1:${s.httpServer.address().port}`);await p.waitForFunction(()=>window.__director);
await p.evaluate(()=>{const api=window.__director,p=api.getProject(),base=p.entities.find(e=>e.kind==='actor');for(let i=0;i<32;i++){const e=structuredClone(base);e.id='perf-'+i;e.name='测试 '+i;e.position=[i*2,0,0];e.path=null;e.clips=Array.from({length:48},(_,n)=>({id:`p${i}-${n}`,start:n*6,end:n*6+2,action:'idle',speed:1}));p.entities.push(e);}p.duration=300;api.replaceProject(p);});
await p.locator('#timeline-zoom').selectOption('1');const bar=p.locator('[data-clip-id="p0-0"]');await bar.scrollIntoViewIfNeeded();const box=await bar.boundingBox();
await p.evaluate(()=>{window.__perf={replacements:0,frames:[],last:0};const el=document.querySelector('#timeline-content');window.__observer=new MutationObserver(ms=>{window.__perf.replacements+=ms.filter(m=>m.target===el&&m.type==='childList').length;});window.__observer.observe(el,{childList:true});const tick=t=>{if(!window.__perf)return; if(window.__perf.last)window.__perf.frames.push(t-window.__perf.last);window.__perf.last=t;window.__perfRaf=requestAnimationFrame(tick);};requestAnimationFrame(tick);});
await p.mouse.move(box.x+70,box.y+10);
await p.evaluate(()=>{
 const bar=document.querySelector('[data-clip-id="p0-0"]'),root=document.querySelector('#timeline-content');let startX=0,startScroll=0;
 const project=window.__director.getEngine().project,clip=project.entities.find(e=>e.id==='perf-0').clips[0];let started=0;
 window.__perf.inputMs=[];window.__perf.immediate=0;window.__perf.moves=0;
 document.addEventListener('pointerdown',event=>{startX=event.clientX;startScroll=root.scrollLeft;},{capture:true,once:true});
 document.addEventListener('pointermove',()=>{started=performance.now();},{capture:true});
 window.addEventListener('pointermove',event=>{if(!(event.buttons&1))return;window.__perf.moves++;window.__perf.inputMs.push(performance.now()-started);const expected=Math.max(0,Math.round((event.clientX-startX+root.scrollLeft-startScroll)/60*project.fps)/project.fps);if(Math.abs(clip.start-expected)<1e-6 && bar.style.left.includes(String(clip.start)))window.__perf.immediate++;});
});
await p.mouse.down();for(let i=1;i<=24;i++){await p.mouse.move(box.x+70+i*5,box.y+10);await p.waitForTimeout(16);}
const result=await p.evaluate(()=>{const f=window.__perf.frames.sort((a,b)=>a-b),input=window.__perf.inputMs.sort((a,b)=>a-b);window.__observer.disconnect();cancelAnimationFrame(window.__perfRaf);return {timelineRootReplacements:window.__perf.replacements,frames:f.length,medianFrameMs:f[Math.floor(f.length*.5)],p95FrameMs:f[Math.floor(f.length*.95)],moves:window.__perf.moves,immediateUpdates:window.__perf.immediate,medianInputHandlerMs:input[Math.floor(input.length*.5)],p95InputHandlerMs:input[Math.floor(input.length*.95)]};});
await p.mouse.up();assert.equal(result.timelineRootReplacements,0,'dragging never replaces the entire timeline');assert.equal(result.immediateUpdates,result.moves,'each pointer move updates bars before returning; no extra animation frame');
assert.equal(await p.evaluate(()=>document.documentElement.hasAttribute('data-timeline-drag')),false,'release clears drag state');
assert.equal(await bar.evaluate(el=>getComputedStyle(el).cursor),'default','released clip shows arrow, not dragging hand');
console.log(result);await fs.writeFile('tmp/timeline-performance/result.json',JSON.stringify(result));
}finally{await b.close();await s.close();}
