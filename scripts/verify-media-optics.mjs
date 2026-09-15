import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

await fs.mkdir('tmp/media-optics',{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/.vite/deps/three.js');
  const {SurfaceRuntime}=await import('/src/media/surface-runtime.ts'),{importMedia}=await import('/src/media/source.ts'),{defaultSurfaceLayer}=await import('/src/media/model.ts');
  const {entity}=await import('/src/model.ts'),{createScene}=await import('/src/scenes.ts');
  const {makeVisual,sampleVisual,disposeVisual}=await import('/src/visuals/runtime.ts');
  const renderer=new T.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(320,320);renderer.shadowMap.enabled=true;renderer.setPixelRatio(1);
  const scene=new T.Scene();scene.background=new T.Color('#000000');const camera=new T.PerspectiveCamera(45,1,.1,100);camera.position.set(0,0,6);camera.lookAt(0,0,0);
  const pixel=()=>{const gl=renderer.getContext(),out=new Uint8Array(4);gl.readPixels(160,160,1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];};
  const render=()=>{renderer.render(scene,camera);return pixel();};
  const wall=new T.Mesh(new T.PlaneGeometry(8,8),new T.MeshStandardMaterial({color:'#ffffff'}));wall.receiveShadow=true;scene.add(wall);
  const projector=entity('prop','light-spot','投影'),root=new T.Group(),light=new T.SpotLight('#ffffff',60);light.name='director-light';light.position.set(2,0,4);light.angle=.7;light.penumbra=0;light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.target.position.set(0,0,0);root.add(light,light.target);scene.add(root);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const paint=canvas.getContext('2d');
  const make=async(color)=>{paint.fillStyle=color;paint.fillRect(0,0,64,64);return importMedia(new File([await new Promise(r=>canvas.toBlob(r,'image/png'))],'color.png',{type:'image/png'}));};
  const red=await make('#ff0000'),blue=await make('#0000ff');const project=createScene('blank');project.media=[red,blue];project.entities=[projector];projector.surface={layers:[defaultSurfaceLayer(red.id)]};const runtime=new SurfaceRuntime(()=>{}),models=new Map([[projector.id,root]]);
  const prepare=async()=>{runtime.sample(project,models,0);await runtime.prepare();runtime.sample(project,models,0);};
  await prepare();const projectedRed=render();projector.surface.layers[0].resourceId=blue.id;await prepare();const projectedBlue=render();
  const blocker=new T.Mesh(new T.BoxGeometry(.8,.8,.1),new T.MeshBasicMaterial({color:'#111111'}));blocker.position.set(1,0,2);blocker.castShadow=true;scene.add(blocker);const blocked=render();scene.remove(blocker);runtime.dispose();scene.remove(root,wall);
  const mirror=entity('prop','visual-mirror','镜面');mirror.color='#ffffff';mirror.visual.opacity=1;const mirrorRoot=makeVisual(mirror);scene.add(mirrorRoot);camera.position.set(2,0,5);camera.lookAt(0,0,0);
  const redObject=new T.Mesh(new T.SphereGeometry(.5,20,12),new T.MeshBasicMaterial({color:'#ff0000'}));redObject.position.set(-1.2,0,3);scene.add(redObject);sampleVisual(mirror,mirrorRoot,0,false);const reflected=render();scene.remove(redObject);const emptyMirror=render();scene.remove(mirrorRoot);disposeVisual(mirrorRoot);
  const portal=entity('prop','visual-portal','门户');portal.color='#ffffff';portal.visual.opacity=1;const portalRoot=makeVisual(portal),destination=new T.PerspectiveCamera(45,1,.1,100);destination.position.set(10,0,5);destination.lookAt(10,0,0);portalRoot.children[0].userData.portalCamera=destination;scene.add(portalRoot);redObject.position.set(10,0,0);scene.add(redObject);camera.position.set(0,0,5);camera.lookAt(0,0,0);sampleVisual(portal,portalRoot,0,false);const portalPixel=render();scene.remove(portalRoot);disposeVisual(portalRoot);
  renderer.dispose();
  return {projectedRed,projectedBlue,blocked,reflected,emptyMirror,portalPixel};
 });
 assert.ok(result.projectedRed[0]>result.projectedRed[2]+50,JSON.stringify(result));assert.ok(result.projectedBlue[2]>result.projectedBlue[0]+50,JSON.stringify(result));
 assert.ok(result.blocked[2]<result.projectedBlue[2]*.5,'projector shadow failed');assert.ok(result.reflected[0]>result.emptyMirror[0]+50,'mirror failed to reflect object');assert.ok(result.portalPixel[0]>150&&result.portalPixel[2]<50,'portal failed to show destination camera');
 assert.deepEqual(errors,[]);await fs.writeFile('tmp/media-optics/report.json',JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close();await server.close();}
