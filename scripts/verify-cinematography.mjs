import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
await fs.mkdir('tmp/cinematography', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/tmp/**'] } } });
await server.listen(); let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`); await page.waitForFunction(() => window.__director);
    await page.evaluate(() => {window.__qaToastErrors=[];new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element && node.matches('.toast.error'))window.__qaToastErrors.push(node.textContent);}).observe(document.querySelector('#toasts'),{childList:true});});
    const result = await page.evaluate(async () => {
        const { demoProject, entity, assertProject, clone } = await import('/src/model.ts');
        const engine = window.__director.getEngine(), p = demoProject();
        p.room.enabled = false; p.entities = []; p.duration = 8;
        const camera = entity('camera', 'camera', '镜头效果测试', [0, 2.2, 10]); camera.camera.target = [0, 1.4, 0]; camera.camera.focal = 28;
        p.entities.push(camera); p.cuts = [{ time: 0, cameraId: camera.id }];
        for (let z = -10; z <= 4; z += 3.5) for (let x = -7; x <= 7; x += 2) {
            const prop = entity('prop', 'shape-box', 'QA grid', [x, 1.5, z]); prop.scale = [.3, 3, .3]; prop.color = z < -3 ? '#799dba' : x < 0 ? '#d89e66' : '#aa6372'; p.entities.push(prop);
        }
        assertProject(p);
        const shots = [], capture = () => {
            const canvas = engine.renderOutput(2, 960, 540, camera.id), gl = engine.shotRenderer.getContext(), bytes = new Uint8Array(960 * 540 * 4);
            gl.readPixels(0, 0, 960, 540, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            return { image: canvas.toDataURL(), bytes };
        };
        for (const type of ['none', 'barrel', 'pincushion', 'fisheye', 'blur', 'bloom']) {
            camera.camera.effects = type === 'none' ? undefined : ['blur', 'bloom'].includes(type) ? { channels: { [type]: 1, focusDistance: 6 } } : { distortionType: type, channels: { distortion: 1 } };
            engine.rebuild(clone(p)); const a = capture(); engine.sample(7); const b = capture();
            if (a.image !== b.image) throw Error('Effect is not deterministic: ' + type);
            if (type !== 'none' && a.image === shots[0].image) throw Error('Effect did not change pixels: ' + type);
            shots.push({ type, image: a.image, brightness: a.bytes.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0) / (960 * 540 * 3) });
        }
        const { defaultLighting } = await import('/src/lighting/model.ts');
        camera.camera.effects = undefined;
        const floor = entity('prop', 'shape-box', 'QA floor', [0, -.1, 0]); floor.scale = [20, .1, 20];
        const box = entity('prop', 'shape-box', 'QA subject', [0, 0, 0]); box.scale = [2, 2, 2];
        p.entities = [camera, floor, box]; camera.position = [6, 4, 10]; camera.camera.target = [0, 1, 0];
        p.lighting = { ...defaultLighting(), defaultLights: false, ambient: .03, background: '#101010', quality: 'low' };
        const lights = [];
        for (const asset of ['light-point', 'light-spot', 'light-area', 'light-sun']) {
            const lamp = entity('prop', asset, 'QA light', [2, 4, 4]), aiming = engine.editorCamera.clone(); aiming.position.fromArray(lamp.position); aiming.lookAt(0, 0, 0);
            lamp.rotation = [aiming.rotation.x, aiming.rotation.y, aiming.rotation.z]; lamp.light.intensity = asset === 'light-area' ? 8 : asset === 'light-sun' ? 3 : 300;
            const current = clone(p); current.entities.push(lamp); engine.rebuild(current); const lit = capture();
            engine.models.get(lamp.id).userData.lightMarker.visible = false;
            if (capture().image !== lit.image) throw Error('Light editor marker leaked into camera: ' + asset);
            const dark = clone(current); dark.entities.at(-1).visible = false; engine.rebuild(dark); const unlit = capture();
            if (lit.image === unlit.image) throw Error('Light did not illuminate scene: ' + asset);
            lights.push({ type: asset, image: lit.image });
        }
        window.__director.replaceProject(p); engine.restorePreview(0);
        return { shots, lights };
    });
    for (const shot of [...result.shots, ...result.lights]) await fs.writeFile(`tmp/cinematography/${shot.type}.png`, Buffer.from(shot.image.split(',')[1], 'base64'));
    const selectCamera = async () => page.evaluate(async () => {const api=window.__director; await api.callTool('director_view',{time:0,entityId:api.getProject().entities.find(e=>e.camera).id});});
    const fits = async label => {
        const overflow = await page.locator('#inspector-content').evaluate(root => {const bounds=root.getBoundingClientRect(); return [...root.querySelectorAll('input,select,button')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left<bounds.left-1||r.right>bounds.right+1||r.bottom>bounds.bottom+1;}).map(e=>e.id||e.textContent);});
        if(overflow.length){await page.screenshot({path:'tmp/cinematography/ui-overflow.png'});console.log(await page.locator('#inspector-content').evaluate(e=>({height:e.clientHeight,width:e.clientWidth,window:[innerWidth,innerHeight],scroll:e.scrollHeight})));} assert.deepEqual(overflow,[],label+' controls overflow'); assert.equal(await page.locator('.modal').count(),0,'Settings opened an overlay');
    };
    await selectCamera(); await page.locator('[data-inspect="effects"]').click();
    await page.locator('#cinema-preset').selectOption('dolly-zoom'); await page.locator('[data-act="cinema-generate"]').click();
    assert.equal(await page.evaluate(() => !!window.__director.getProject().entities[0].camera.effects.dollyZoom), true);
    for(const viewport of [{width:1440,height:900},{width:1280,height:720}]) {
        await page.setViewportSize(viewport);
        for (const tab of ['preset', 'channels', 'shake', 'lens']) {await page.locator('[data-cinema-tab="'+tab+'"]').click(); await fits('Camera '+tab);}
    }
    await page.screenshot({ path: 'tmp/cinematography/ui-camera.png' });
    await page.locator('.sidebar-tools-trigger').click(); await page.locator('[data-act="lighting-open"]').click();
    await page.locator('#lighting-preset').selectOption('dusk');
    assert.equal(await page.evaluate(()=>window.__director.getProject().lighting.sunColor),'#ffaf70');
    await page.locator('#lighting-new-type').selectOption('light-spot'); await page.locator('[data-act="lighting-add"]').click();
    assert.equal(await page.evaluate(() => window.__director.getProject().entities.at(-1).asset), 'light-spot');
    await page.locator('#lighting-intensity').fill('450'); await page.locator('#lighting-intensity').dispatchEvent('change');
    assert.equal(await page.evaluate(() => window.__director.getProject().entities.at(-1).light.intensity), 450);
    await page.locator('#lighting-through-walls').selectOption('true');
    assert.equal(await page.evaluate(()=>window.__director.getProject().entities.at(-1).light.throughWalls),true);
    await page.locator('[data-act="undo"]').click();
    assert.equal(await page.evaluate(()=>window.__director.getProject().entities.at(-1).light.throughWalls ?? false),false);
    await page.locator('#lighting-intensity').fill('451'); await page.locator('#lighting-intensity').press('Tab');
    assert.equal(await page.evaluate(()=>window.__director.getProject().entities.at(-1).light.intensity),451);
    await page.locator('[data-act="undo"]').click();
    assert.equal(await page.evaluate(()=>window.__director.getProject().entities.at(-1).light.intensity),450);
    await page.locator('[data-light-tab="keys"]').click(); await page.locator('#lighting-time').fill('4'); await page.locator('#lighting-value').fill('800'); await page.locator('[data-act="lighting-key-save"]').click();
    assert.equal(await page.evaluate(() => window.__director.getProject().entities.at(-1).light.intensity.keys.at(-1).value), 800);
    for (const tab of ['main', 'shape', 'atmosphere', 'keys']) {await page.locator('[data-light-tab="'+tab+'"]').click(); await fits('Light '+tab);}
    await page.locator('[data-light-tab="main"]').click();
    await page.screenshot({ path: 'tmp/cinematography/ui-light.png' });
    await page.setViewportSize({width:1440,height:900});
    const integration = await page.evaluate(async () => {
        const { demoProject, entity, clone } = await import('/src/model.ts');
        const { readSceneDocument, projectForScene } = await import('/src/scenes/sequence-project.ts');
        const { continueScene } = await import('/src/scenes/continue-scene.ts');
        const { defaultLighting } = await import('/src/lighting/model.ts');
        const { exportVideo } = await import('/src/export.ts');
        const api = window.__director, engine = api.getEngine(), checks = [];
        const check = (value, message) => { if (!value) throw Error(message); };
        const call = async (name, args) => { const r = await api.callTool(name, args); check(r.ok, r.error); return r.data; };
        const p = demoProject(); p.duration = 2; p.room.enabled = false;
        const camera = entity('camera', 'camera', 'QA optics', [4, 3, 8]), actor = entity('actor', 'person', 'QA actor', [0, 0, 0]);
        const floor = entity('prop', 'shape-box', 'QA floor', [0, -.1, 0]); floor.scale = [30, .1, 30];
        const backdrop = entity('prop', 'shape-box', 'QA background', [0, 0, -6]); backdrop.scale = [16, 5, 1]; backdrop.color = '#598d80';
        const lamp = entity('prop', 'light-point', 'QA animated light', [0, 3, 2]);
        lamp.light.intensity = { keys: [{ time: 0, value: 50 }, { time: 2, value: 700 }] };
        lamp.light.temperature = { keys: [{ time: 0, value: 3200 }, { time: 2, value: 7200 }] };
        lamp.light.colorKeys = [{ time: 0, color: '#ee7755' }, { time: 2, color: '#5588ee' }];
        lamp.light.flicker = { strength: .3, frequency: 2, seed: 4 };
        lamp.path = { smooth: false, points: [{ time: 0, position: [-2, 3, 2] }, { time: 2, position: [2, 3, 2] }] };
        actor.path = { smooth: false, points: [{ time: 0, position: [0, 0, 0] }, { time: 2, position: [1, 0, 1], easing: 'ease-out' }] };
        camera.camera.targetId = actor.id; camera.camera.targetHeight = 1.1;
        camera.camera.effects = { channels: { roll: 9, pan: 3, tilt: -2, frameX: .25, offsetY: .1, distortion: .6, blur: .25, bloom: .3, focal: { keys: [{ time: 0, value: 28 }, { time: 2, value: 35 }] } }, distortionType: 'barrel', followLag: .2, shake: { preset: 'pov', amount: 1, frequency: 1, seed: 42, start: 0, end: 2 } };
        p.entities = [camera, actor, floor, backdrop, lamp]; p.cuts = [{ time: 0, cameraId: camera.id }];
        p.lighting = { ...defaultLighting(), ambient: { keys: [{ time: 0, value: .2 }, { time: 2, value: .5 }] }, quality: 'low', fog: { color: '#334455', density: .004 } };
        const pixels = (at, width = 640, height = 360) => {
            engine.renderOutput(at, width, height, camera.id); const gl = engine.shotRenderer.getContext(), bytes = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return bytes;
        };
        const delta = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
        for (const mode of ['free', 'follow', 'pov']) {
            const scene = clone(p); scene.entities[0].camera.mode = mode; scene.entities[0].camera.offset = mode === 'pov' ? [0, 1.6, .15] : [3, 2.2, 5];
            engine.rebuild(scene); const at = 47 / 24, before = pixels(at), beforeMatrix = engine.getShotCamera(camera.id).matrixWorld.toArray();
            const document = readSceneDocument(scene), saved = JSON.stringify(document), next = await continueScene(engine, document, 'QA continuation');
            check(JSON.stringify(document) === saved, 'Continue modified source scene');
            engine.rebuild(projectForScene(next)); const after = pixels(0), error = delta(before, after);
            const matrixError = Math.max(...engine.getShotCamera(camera.id).matrixWorld.toArray().map((v, i) => Math.abs(v - beforeMatrix[i])));
            check(matrixError < 1e-7, 'Camera continuation pose mismatch ' + mode + ': ' + matrixError);
            check(error < .1, 'Camera/light continuation pixels mismatch ' + mode + ': ' + error);
            checks.push({ continuity: mode, pixelMAE: error, matrixError });
        }
        api.replaceProject(p);
        const beforeTool = JSON.stringify(api.getProject());
        let state = await call('director_read', {});
        const applied = await call('director_apply', { revision: state.revision, requestId: 'cinema-qa-apply', operations: [{ operation: 'camera-motion', id: camera.id, asset: 'arc-push', time: 0, duration: 2 }, { operation: 'lighting-preset', asset: 'dusk' }] });
        check(applied.committed, 'Live tool did not commit');
        const current = api.getProject(); check(current.entities[0].path.points.length === 25 && current.lighting.sunColor === '#ffaf70', 'Live tool values not stored');
        await call('director_history', { revision: applied.revision, action: 'undo' });
        check(JSON.stringify(api.getProject()) === beforeTool, 'Camera/light tool undo mismatch');
        checks.push({ liveTools: 'shared apply + undo passed' });
        const expected = engine.renderOutput(1, 1920, 1080, camera.id).toDataURL();
        engine.setPreviewQuality('draft');
        check(engine.renderOutput(1, 1920, 1080, camera.id).toDataURL() === expected, 'Preview quality changed export');
        engine.setPreviewQuality('full');
        const blob = await exportVideo(engine, { start: 0, end: 2, fps: 24, width: 1920, height: 1080, cameraId: camera.id, format: 'mp4', monochrome: false }, new AbortController().signal, () => {});
        const url = URL.createObjectURL(blob), video = document.createElement('video'); video.muted = true; video.src = url;
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
        check(Math.abs(video.duration - 2) < .05 && video.videoWidth === 1920, 'Encoded duration/resolution mismatch');
        video.currentTime = 1; await new Promise(resolve => video.onseeked = resolve);
        const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
        const decoded = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const direct = engine.renderOutput(1, 1920, 1080, camera.id); ctx.drawImage(direct, 0, 0);
        const error = delta(decoded, ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        check(error < 5, 'Decoded video does not match sampled frame: ' + error);
        checks.push({ video: '1080p MP4, 48 frames, decoded t=1', bytes: blob.size, pixelMAE: error });
        URL.revokeObjectURL(url); video.remove();
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        // Rendering repeatedly reuses target textures and geometries.
        pixels(0); const before = { ...engine.shotRenderer.info.memory };
        const started = performance.now(); for (let i = 0; i < 48; i++) pixels(i / 24);
        check(engine.shotRenderer.info.memory.textures === before.textures && engine.shotRenderer.info.memory.geometries === before.geometries, 'Effects leak renderer resources per frame');
        checks.push({ renderLoopMs: performance.now() - started, stableMemory: before });
        engine.restorePreview(0);
        const { Engine } = await import('/src/engine.ts');
        const stage = document.createElement('div'), shot = document.createElement('div'), noop = () => {};
        const isolated = new Engine(clone(p), stage, shot, { select: noop, point: noop, ground: noop, transform: noop, transformStart: noop, transformEnd: noop });
        isolated.renderOutput(.5, 320, 180, camera.id);
        let released = 0; isolated.shotEffects.target.addEventListener('dispose', () => released++);
        isolated.dispose(); isolated.dispose();
        check(released === 1 && isolated.models.size === 0 && shot.childElementCount === 0, 'Renderer/effect disposal mismatch');
        checks.push({ disposal: 'render target, scene lights and engine released' });
        return { checks, bytes };
    });
    await fs.writeFile('tmp/cinematography/animated-optics.mp4', Buffer.from(integration.bytes));
    console.log(JSON.stringify(integration.checks));
    const ceiling = await page.evaluate(async () => {
        const {demoProject, entity, clone} = await import('/src/model.ts');
        const {defaultLighting} = await import('/src/lighting/model.ts');
        const api = window.__director, engine = api.getEngine(), p = demoProject();
        p.lighting = {...defaultLighting(), defaultLights:false, ambient:.05, quality:'low'};
        const lamp = entity('prop','light-spot','QA ceiling obstruction',[0,3,0]); lamp.rotation[0] = -Math.PI/4; lamp.light.intensity = 300; p.entities.push(lamp);
        const camera = p.entities.find(e=>e.camera), capture=()=>engine.renderOutput(0,640,360,camera.id).toDataURL();
        api.replaceProject(p); const blocked=capture();
        const open=clone(p); open.entities.find(e=>e.id===camera.id).camera.hideWalls=['ceiling']; engine.rebuild(open); const uncovered=capture();
        if (blocked===uncovered) throw Error('Ceiling test did not reproduce blocked spotlight');
        api.replaceProject(p); engine.restorePreview(0);
        return {blocked,uncovered,id:lamp.id};
    });
    for(const key of ['blocked','uncovered']) await fs.writeFile(`tmp/cinematography/ceiling-${key}.png`,Buffer.from(ceiling[key].split(',')[1],'base64'));
    await page.evaluate(async id=>{await window.__director.callTool('director_view',{time:0,entityId:id});},ceiling.id);
    await page.locator('#lighting-through-walls').selectOption('true');
    await fits('Light transmission');
    const fixed=await page.evaluate(id=>{const api=window.__director,e=api.getProject().entities.find(e=>e.id===id);return {y:e.position[1],enabled:e.light.throughWalls,image:api.getEngine().renderOutput(0,640,360,api.getProject().cuts[0].cameraId).toDataURL()};},ceiling.id);
    assert.equal(fixed.y,3); assert.equal(fixed.enabled,true); assert.notEqual(fixed.image,ceiling.blocked);
    await fs.writeFile('tmp/cinematography/ceiling-fixed.png',Buffer.from(fixed.image.split(',')[1],'base64'));
    const shadowCheck=await page.evaluate(id=>{const api=window.__director,engine=api.getEngine(),shot=()=>engine.renderOutput(0,640,360,api.getProject().cuts[0].cameraId).toDataURL();
        const through=shot(); engine.walls.forEach(root=>root.traverse(m=>m.castShadow=false)); const physical=shot();
        engine.models.forEach((root,key)=>{if(key!==id)root.traverse(m=>m.castShadow=false)}); const noObjects=shot();
        return {matchesOnlyWalls:through===physical,objectsStillShadow:through!==noObjects};
    },ceiling.id);
    assert.deepEqual(shadowCheck,{matchesOnlyWalls:true,objectsStillShadow:true});
    console.log('Enclosed room: per-light wall transmission matches skipping wall shadows, preserves object shadows and lamp position.');
    errors.push(...await page.evaluate(()=>window.__qaToastErrors));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ effects: result.shots.map(({ type, brightness }) => ({ type, brightness })), lightTypes: result.lights.map(s => s.type), ui: 'presets, settings, light creation and keyframes passed' }));
} finally { await browser?.close(); await server.close(); }
