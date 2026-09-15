import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/tmp/**'] } } });
await server.listen();
let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.waitForFunction(() => window.__director);
    const result = await page.evaluate(async () => {
        const { demoProject, entity, clip, clone, assertProject } = await import('/src/model.ts');
        const { includeMotionResources, insertBuiltinMotion } = await import('/src/animation/motion-presets.ts');
        const { builtinMotionRig, BUILTIN_MOTION_RESOURCE_ID } = await import('/src/animation/motion-catalog.ts');
        const { captureInitialPose } = await import('/src/scenes/initial-pose-runtime.ts');
        const { readSceneDocument } = await import('/src/scenes/sequence-project.ts');
        const api = window.__director, engine = api.getEngine();
        const check = (condition, message) => { if (!condition) throw Error(message); };
        const call = async (name, args) => { const result = await api.callTool(name, args); if (!result.ok) throw Error(result.error); return result.data; };
        let project = await includeMotionResources(demoProject());
        const actor = project.entities.find(e => e.kind === 'actor'); actor.clips = [];
        insertBuiltinMotion(project, actor.id, 'human-sit-idle-v1', 0, 4);
        actor.clips.push(clip('wave', 4, 8), clip('run', 8, 12));
        const crowd = entity('crowd', 'crowd', '测试群演', [3, 0, 0]); crowd.count = 4; crowd.clips = [];
        project.entities.push(crowd); insertBuiltinMotion(project, crowd.id, 'human-sit-idle-v1', 0, 4);
        const imported = entity('actor', 'external-model', '导入人形', [1, 0, 1]);
        imported.external = { resourceId: BUILTIN_MOTION_RESOURCE_ID, appearance: 'color', unitScale: 1, orientation: [0, 0, 0], rig: builtinMotionRig() };
        imported.clips = [clip('wave', 0, 4), clip('run', 4, 8)]; project.entities.push(imported);
        const prop = entity('prop', 'shape-box', '手持道具'); prop.scale = [.1, .1, .1];
        prop.handBinding = { actorId: actor.id, hand: 'right', offset: [0, .1, 0], rotation: [0, 0, .2] }; project.entities.push(prop);
        await engine.externalModels.prepare(project); api.replaceProject(project);
        engine.sample(2);
        const inherited = clone(project);
        inherited.entities.find(e => e.id === actor.id).initialPose = captureInitialPose(engine.models.get(actor.id), actor);
        inherited.entities.find(e => e.id === actor.id).clips = [clip('wave', 4, 8)];
        let frames = 0, edits = 0, seamPixels = 0;
        const compareFresh = p => {
            assertProject(p);
            engine.rebuild(p);
            const times = [0, 2, 3.99, 4, 5.5, 8, 11, 0];
            const capture = time => {
                const pixels = engine.renderOutput(time, 640, 360).toDataURL();
                const gl = engine.shotRenderer.getContext(), rgba = new Uint8Array(640 * 360 * 4);
                gl.readPixels(0, 0, 640, 360, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                const matrices = p.entities.map(e => {
                    const nodes = []; engine.models.get(e.id).traverse(n => nodes.push(n.matrixWorld.toArray().map(v => Math.round(v * 1e7) / 1e7)));
                    return nodes;
                });
                return { pixels, rgba, matrices, camera: engine.projectionSignature() };
            };
            const cached = times.map(capture);
            // Test-only cold reconstruction, using the same builders and output settings.
            engine.renderCache.invalidate(); engine.rebuild(p);
            times.forEach((t, i) => {
                const fresh = capture(t), before = cached[i];
                const changed = p.entities.filter((_, j) => JSON.stringify(fresh.matrices[j]) !== JSON.stringify(before.matrices[j])).map(e => e.name);
                let pixelChannels = 0, maxDelta = 0;
                fresh.rgba.forEach((v, j) => { const delta = Math.abs(v - before.rgba[j]); if (delta) { pixelChannels++; maxDelta = Math.max(delta, maxDelta); } });
                // Reusing meshes changes GPU draw order at equal-depth seams. Permit one RGB seam pixel,
                // while requiring all sampled world matrices and camera matrices to match exactly.
                const pixelsChanged = new Set();
                fresh.rgba.forEach((v, j) => { if (v !== before.rgba[j]) pixelsChanged.add(Math.floor(j / 4)); });
                check(!changed.length && pixelsChanged.size <= 1 && JSON.stringify(fresh.camera) === JSON.stringify(before.camera), `Incremental/cold mismatch at ${t}s, edit ${edits}: ${JSON.stringify({ changed, pixelChannels, maxDelta })}`);
                seamPixels += pixelsChanged.size; frames++;
            });
            engine.restorePreview(0); edits++;
        };
        for (const p of [project, inherited]) {
            engine.rebuild(p); engine.sample(2);
            const roots = new Map(engine.models), edited = p.entities.find(e => e.kind === 'prop' && !e.handBinding);
            edited.position[0] += .25;
            engine.rebuild(p);
            for (const e of p.entities) check(roots.get(e.id) === engine.models.get(e.id), 'Moving an object must reuse model instances');
            compareFresh(p);
            const named=p.entities.find(e=>e.id===actor.id),root=engine.models.get(named.id);
            named.name='重命名人物';named.locked=true;engine.rebuild(p);check(engine.models.get(named.id)===root,'Name/lock changes must not rebuild a model');compareFresh(p);named.locked=false;
            p.entities.find(e => e.id === crowd.id).count = 2; compareFresh(p);
            p.entities.find(e => e.id === prop.id).handBinding.hand = 'left'; compareFresh(p);
            const seated = p.entities.find(e => e.id === actor.id); seated.color = '#229966'; seated.height = 2; compareFresh(p);
            const external = p.entities.find(e => e.id === imported.id); external.external.appearance = 'white'; external.scale = [1.1, 1, 1]; compareFresh(p);
            p.entities = p.entities.filter(e => e.id !== imported.id); compareFresh(p);
        }
        // Switch through the actual UI and tool service; undo and replay use the same session.
        project = demoProject(); const doc = readSceneDocument(project);
        doc.scenes.push({ ...clone(doc.scenes[0]), id: 'second', name: '第二场' });
        doc.scenes[1].state.entities[0].position[0] += 3;
        api.replaceProject(doc);
        const read = await call('director_read', {});
        const args = { action: 'switch', sceneId: 'second', revision: read.revision, requestId: 'switch-reuse-test' };
        const switched = await call('director_scene', args);
        check(api.getDocument().activeSceneId === 'second', 'MCP switch failed');
        check(JSON.stringify(await call('director_scene', args)) === JSON.stringify(switched), 'Retry must return receipt');
        document.querySelector('[data-act="undo"]').click();
        check(api.getDocument().activeSceneId === 'scene-main', 'Switch undo failed');
        document.querySelector('[data-act="redo"]').click();
        check(api.getDocument().activeSceneId === 'second', 'Switch redo failed');
        const select = document.querySelector('#scene-switch'); select.value = 'scene-main'; select.dispatchEvent(new Event('change'));
        check(api.getDocument().activeSceneId === 'scene-main', 'UI switch failed');
        return { frames, edits, seamPixels, sceneNavigation: true };
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(result));
} finally { await browser?.close(); await server.close(); }
