import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// Synthetic scenes only; never opens the user's desktop profile or recovery copy.
const label = process.argv[2] || 'current';
assert.match(label, /^[a-z0-9-]+$/i);
await fs.mkdir('tmp/editing-performance', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/tmp/**'] } } });
await server.listen();
let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.waitForFunction(() => window.__director);
    const results = [];
    for (const [objects, scenes, resources] of [[80, 1, false], [240, 1, false], [240, 12, false], [80, 6, true]]) {
        results.push(await page.evaluate(async ({ objects, scenes, resources }) => {
            const { demoProject, entity, clone } = await import('/src/model.ts');
            const { readSceneDocument } = await import('/src/scenes/sequence-project.ts');
            const { SceneSession } = await import('/src/scenes/sequence-session.ts');
            const api = window.__director; let p = demoProject();
            p.room.enabled = false; p.entities = p.entities.filter(e => e.kind === 'camera').slice(0, 1);
            p.cuts = [{ time: 0, cameraId: p.entities[0].id }];
            for (let i = 0; i < objects; i++) {
                const e = entity(i % 12 === 0 ? 'actor' : 'prop', i % 12 === 0 ? 'person' : 'shape-box', `对象${i}`, [(i % 16) * 2 - 16, 0, Math.floor(i / 16) * 2 - 12]);
                e.id = `object-${i}`; p.entities.push(e);
            }
            if(resources) {
                const {includeMotionResources,insertBuiltinMotion}=await import('/src/animation/motion-presets.ts');
                p=await includeMotionResources(p);
                const actor=p.entities.find(e=>e.kind==='actor');actor.clips=[];insertBuiltinMotion(p,actor.id,'human-sit-idle-v1',0,4);
                await api.getEngine().externalModels.prepare(p);
            }
            const doc = readSceneDocument(p);
            for (let i = 1; i < scenes; i++) doc.scenes.push({ ...clone(doc.scenes[0]), id: `scene-${i}`, name: `戏段${i}` });
            const session = new SceneSession(doc);
            const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
            const measure = (fn, count = 7) => { const values = []; for (let i = 0; i < count; i++) { const start = performance.now(); fn(i); values.push(performance.now() - start); } return median(values); };
            const readMs = measure(() => session.project());
            const commitMs = measure(i => { const t = session.begin(); t.project.entities[1].position[0] += .01; session.commit(t); });
            api.replaceProject(doc);
            const engine = api.getEngine();
            const rebuildMs = measure(() => engine.rebuild(engine.project));
            const sampleMs = measure(i => engine.sample(i / 24), 24);
            const edits = [];
            for (let i = 0; i < 5; i++) {
                const read = await api.callTool('director_read', {});
                const start = performance.now();
                const result = await api.callTool('director_apply', { revision: read.data.revision, requestId: `perf-${objects}-${scenes}-${i}`, operations: [{ operation: 'update', id: 'object-1', patch: { position: [i, 0, 0] } }] });
                if (!result.ok) throw Error(result.error);
                edits.push(performance.now() - start);
            }
            let switchMs = null;
            if (scenes > 1) switchMs = measure(i => {
                const select = document.querySelector('#scene-switch'); select.value = i % 2 ? 'scene-main' : 'scene-1';
                select.dispatchEvent(new Event('change', { bubbles: true }));
                if (api.getDocument().activeSceneId !== select.value) throw Error('Scene switch failed');
            });
            const screenshot = engine.renderOutput(1, 640, 360).toDataURL(); engine.restorePreview(0);
            return { objects, scenes, resources, resourceBytes:JSON.stringify(p.resources??[]).length,readMs, commitMs, rebuildMs, sampleMs, editMs: median(edits), switchMs, screenshot };
        }, { objects, scenes, resources }));
        const result = results.at(-1);
        await fs.writeFile(`tmp/editing-performance/${label}-${objects}-${scenes}.png`, Buffer.from(result.screenshot.split(',')[1], 'base64'));
        delete result.screenshot;
        result.playback = await page.evaluate(() => new Promise(resolve => {
            const engine = window.__director.getEngine();
            const gl = engine.shotRenderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
            document.querySelector('[data-act="play"]').click();
            const intervals = []; let start, previous;
            const frame = now => {
                if (start === undefined) { start = previous = now; requestAnimationFrame(frame); return; }
                intervals.push(now - previous); previous = now;
                if (now - start < 1500) { requestAnimationFrame(frame); return; }
                document.querySelector('[data-act="play"]').click();
                intervals.sort((a, b) => a - b);
                resolve({ fps: intervals.length * 1000 / (now - start), p95FrameMs: intervals[Math.floor(intervals.length * .95)],
                    renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                    drawCalls: { stage: engine.editorRenderer.info.render.calls, shot: engine.shotRenderer.info.render.calls } });
            }; requestAnimationFrame(frame);
        }));
        result.idle=await page.evaluate(()=>new Promise(resolve=>{
            const engine=window.__director.getEngine(),sample=engine.sample,render=engine.render,onFrame=engine.onFrame;let samples=0,renders=0,painted=0;
            engine.sample=function(...args){samples++;return sample.apply(this,args);};engine.render=function(...args){renders++;return render.apply(this,args);};
            engine.onFrame=function(){painted++;return onFrame.call(this);};
            setTimeout(()=>{engine.sample=sample;engine.render=render;engine.onFrame=onFrame;resolve({samples,renders,painted,intervalMs:500});},500);
        }));
        console.log(JSON.stringify(result));
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(`tmp/editing-performance/${label}.json`, JSON.stringify(results, null, 2));
} finally { await browser?.close(); await server.close(); }
