import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
await fs.mkdir('tmp/feature-scenes',{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0,watch:{ignored:['**/tmp/**','**/.local/**']}}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
 assert.equal(await page.evaluate(()=>window.__director.getProject().name),'光影舞台');
 await page.locator('[data-act="project"]').click();await page.locator('[data-act="new-project"]').click();
 assert.equal(await page.locator('input[name="scene-template"]').count(),9);
 const layout=await page.locator('.modal').evaluate(el=>{const r=el.getBoundingClientRect(),back=el.querySelector('.modal-back').getBoundingClientRect();return {top:r.top,bottom:r.bottom,overflow:el.scrollHeight-el.clientHeight,right:r.right-back.right,bottomGap:r.bottom-back.bottom};});
 assert.ok(layout.top>=0&&layout.bottom<=720&&layout.overflow<=1,JSON.stringify(layout));
 assert.ok(layout.right<25&&layout.bottomGap<20,'nested return is at bottom right');
 await page.screenshot({path:'tmp/feature-scenes/templates.png'});await page.locator('.modal-header [data-act="close-modal"]').click();
 for(const name of ['light-stage','dolly-hall','neon-chase','bedroom','room','park','street','courtyard']) {
  const result=await page.evaluate(async name=>{
   const {createScene}=await import('/src/scenes.ts');const p=createScene(name),api=window.__director,e=api.getEngine();api.replaceProject(p);
   const frames=[];for(const t of [0,p.duration/2,p.duration-1/24]) {
    const canvas=e.renderOutput(t,960,540,'program'),gl=e.shotRenderer.getContext(),pixels=new Uint8Array(960*540*4);gl.readPixels(0,0,960,540,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let sum=0,lit=0;for(let i=0;i<pixels.length;i+=4){const l=(pixels[i]+pixels[i+1]+pixels[i+2])/3;sum+=l;if(l>40)lit++;}
    frames.push({time:t,image:canvas.toDataURL(),brightness:sum/(960*540),litFraction:lit/(960*540)});
   }return frames;
  },name);
  for(const [i,frame] of result.entries()) {assert.ok(frame.brightness>12&&frame.litFraction>.08,`${name} frame ${i} too dark`);await fs.writeFile(`tmp/feature-scenes/${name}-${i}.png`,Buffer.from(frame.image.split(',')[1],'base64'));}
  assert.notEqual(result[0].image,result[2].image,`${name} playback changes the shot`);
  console.log(name,result.map(({time,brightness,litFraction})=>({time,brightness,litFraction})));
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();await server.close();}
