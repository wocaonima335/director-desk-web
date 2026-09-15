import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

await fs.mkdir('tmp',{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0,watch:{ignored:['**/tmp/**','**/.local/**']}}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
    const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,2000));});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
    const result=await page.evaluate(async()=>{
        const {createScene}=await import('/src/scenes.ts'),{entity}=await import('/src/model.ts');
        const {defaultSurfaceLayer}=await import('/src/media/model.ts');
        const {VISUAL_PRESETS,FIELD_TYPES}=await import('/src/visuals/model.ts'),{WARP_TYPES}=await import('/src/visuals/warps.ts');
        const {Output,BufferTarget,CanvasSource,Mp4OutputFormat,Input,BlobSource,ALL_FORMATS,CanvasSink}=await import('/scripts/browser-media-deps.ts');
        const api=window.__director;
        const require=(condition,message)=>{if(!condition)throw Error(message);};
        const call=async(name,args)=>{const response=await api.callTool(name,args);require(response.ok,response.error);return response.data;};
        const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const paint=canvas.getContext('2d');
        const target=new BufferTarget(),output=new Output({format:new Mp4OutputFormat(),target}),source=new CanvasSource(canvas,{codec:'avc',bitrate:200000,keyFrameInterval:1});
        output.addVideoTrack(source,{frameRate:24});await output.start();
        for(let i=0;i<48;i++){paint.fillStyle=i<24?'#ff0000':'#0000ff';paint.fillRect(0,0,64,64);await source.add(i/24,1/24);}source.close();await output.finalize();
        const file=new Blob([target.buffer],{type:'video/mp4'});const data=await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(file);});
        const p=createScene('blank'),cube=entity('prop','cube','媒体承载',[0,0,0]);cube.scale=[2,2,2];p.entities.push(cube);p.duration=2;
        const camera=p.entities.find(e=>e.camera);camera.position=[4,3,5];camera.camera.target=[0,1,0];api.replaceProject(p);
        const before=await call('director_read',{});
        const imported=await call('director_media',{action:'import',revision:before.revision,requestId:'media-browser-import',name:'two-colors.mp4',mime:'video/mp4',data,entityId:cube.id});
        const importedAgain=await call('director_media',{action:'import',revision:before.revision,requestId:'media-browser-import',name:'two-colors.mp4',mime:'video/mp4',data,entityId:cube.id});
        require(imported.revision===importedAgain.revision,'repeat import changed revision');
        const q=api.getProject();q.entities.find(e=>e.id===cube.id).surface.layers[0].unlit=true;q.entities.find(e=>e.id===cube.id).surface.layers[0].mapping='box';
        for(let i=0;i<3;i++){const copy=structuredClone(q.entities.find(e=>e.id===cube.id));copy.id='copy-'+i;copy.position=[15+i*3,0,0];q.entities.push(copy);}api.replaceProject(q);
        const engine=api.getEngine();const pixel=()=>{const gl=engine.shotRenderer.getContext(),v=new Uint8Array(4);gl.readPixels(320,180,1,1,gl.RGBA,gl.UNSIGNED_BYTE,v);return [...v];};
        const samples=[];for(const t of [.25,1.25,.25]){api.setTime(t);await engine.prepareOutput(t);engine.renderOutput(t,640,360);samples.push(pixel());}
        require(samples[0][0]>samples[0][2]*2&&samples[1][2]>samples[1][0]*2,'video timestamp colors do not match');require(JSON.stringify(samples[0])===JSON.stringify(samples[2]),'rewind differs');
        const shared=engine.surfaces.textures.statistics();require(shared.sources===1&&shared.textures===1,'identical clocks failed to share textures');
        const {exportVideo}=await import('/src/export.ts');const blob=await exportVideo(engine,{start:0,end:1.8,fps:24,width:320,height:180,cameraId:'program',format:'mp4',monochrome:false},new AbortController().signal,()=>{});
        const encoded=new Input({source:new BlobSource(blob),formats:ALL_FORMATS});const track=await encoded.getPrimaryVideoTrack(),sink=new CanvasSink(track);const exportPixels=[];
        for(const t of [.25,1.25]){const frame=await sink.getCanvas(t);exportPixels.push([...frame.canvas.getContext('2d').getImageData(160,90,1,1).data]);}encoded.dispose();
        require(exportPixels[0][0]>exportPixels[0][2]*2&&exportPixels[1][2]>exportPixels[1][0]*2,'exported video texture frames are stale');
        const copyProject=api.getProject();copyProject.entities.find(e=>e.id==='copy-0').surface.layers[0].start=.5;api.replaceProject(copyProject);api.setTime(.75);await engine.prepareOutput(.75);
        require(engine.surfaces.textures.statistics().textures===2,'different video clocks were incorrectly merged');
        const revision=(await call('director_read',{})).revision;await call('director_scene',{action:'copy',revision,requestId:'copy-media-scene',newSceneId:'media-copy',name:'媒体副本'});
        const sceneDoc=api.getDocument();require(sceneDoc.media.length===1&&sceneDoc.scenes.every(s=>!s.state.media),'scene files duplicate source bytes');require(api.getProject().media.length===1,'switch lost shared media');
        const presets=[];for(const asset of [...Object.keys(VISUAL_PRESETS).map(k=>'visual-'+k),...Object.keys(FIELD_TYPES).map(k=>'field-'+k),...Object.keys(WARP_TYPES).map(k=>'warp-'+k)]){
            const scene=createScene('blank'),e=entity('prop',asset,asset,[0,1,0]);scene.entities.push(e);const c=scene.entities.find(e=>e.camera);c.position=[4,3,6];c.camera.target=[0,1,0];if(e.visual?.preset==='portal')e.visual.cameraId=c.id;
            api.replaceProject(scene);api.setTime(1);await engine.prepareOutput(1);engine.renderOutput(1,640,360);presets.push(asset);
        }
        api.replaceProject(createScene('abstract-stage'));api.setTime(4);await engine.prepareOutput(4);const showcase=engine.renderOutput(4,960,540).toDataURL();
        api.replaceProject(createScene('blank'));await engine.prepareOutput(0);const released=engine.surfaces.textures.statistics();require(released.sources===0&&released.textures===0&&released.pending===0,'unused media not released');
        return {samples,exportPixels,shared,released,presets,showcase,video:[...new Uint8Array(await blob.arrayBuffer())]};
    });
    await fs.writeFile('tmp/media-export-verification.mp4',Buffer.from(result.video));await fs.writeFile('tmp/abstract-showcase.png',Buffer.from(result.showcase.split(',')[1],'base64'));
    assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,video:undefined,showcase:undefined,errors},null,2));
}finally{await browser.close();await server.close();}
