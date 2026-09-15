import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { verifyVideoFrames } from './verify-video-frames.mjs';
const output = 'tmp/continuous-shot'; await fs.mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/tmp/**'] } } }); await server.listen();
let browser; const errors = [];
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto('http://127.0.0.1:' + server.httpServer.address().port); await page.waitForFunction(() => window.__director);
    const camId = await page.evaluate(async () => {
        const { createScene } = await import('/src/scenes.ts'), { applyOperations } = await import('/src/automation/edits.ts');
        const p = applyOperations(createScene('blank'), [{ operation: 'add', id: 'lead', asset: 'human-adult', patch: {
            path: { smooth: false, points: [{ time: 0, position: [0, 0, 0] }, { time: 2, position: [4, 0, 0] }] },
            clips: [{ id: 'walk', action: 'walk', start: 0, end: 2, speed: 1 }] } }]);
        p.duration = 2; p.zones = [{ id: 'hall', name: '走廊', color: '#99bbcc', min: [-2, -.1, -3], max: [2, 3, 3], connectsTo: ['room'] },
            { id: 'room', name: '房间', color: '#ddbbaa', min: [2, -.1, -3], max: [6, 3, 3] }];
        const c = p.entities.find(e => e.camera); c.position = [0, 2, 6]; c.camera.mode = 'free'; c.camera.aim = 'target'; c.camera.targetId = '';
        c.path = { smooth: false, points: [{ time: 0, position: [0, 2, 6] }, { time: 2, position: [3, 2, 6] }] };
        c.camera.targetPath = { smooth: true, points: [{ time: 0, position: [0, 1, 0] }, { time: 2, position: [4, 1, 0] }] };
        window.__director.replaceProject(p); return c.id;
    });
    const sample = async time => page.evaluate(async ({ time, camId }) => {
        const { Vector3 } = await import('/node_modules/.vite/deps/three.js'); const api = window.__director, engine = api.getEngine(); api.setTime(time);
        const e = api.getProject().entities.find(e => e.id === camId), cam = engine.cameras.get(camId);
        const expected = engine.targetPosition(e).sub(cam.position).normalize(), actual = cam.getWorldDirection(new Vector3());
        const report = engine.spatialReport({ time, cameraId: camId });
        return { dot: expected.dot(actual), matrix: cam.matrixWorld.toArray(), zoneIds: report.objects.find(o => o.entityId === 'lead').zoneIds,
            editorOnly: engine.helpers.children.every(o => !o.layers.test(cam.layers)) };
    }, { time, camId });
    for (const time of [0, 1, 1.9, .4]) { const s = await sample(time); assert.ok(s.dot > .999999); assert.equal(s.editorOnly, true); }
    assert.deepEqual((await sample(0)).zoneIds, ['hall']); assert.deepEqual((await sample(1)).zoneIds, ['hall', 'room']); assert.deepEqual((await sample(1.9)).zoneIds, ['room']);
    const once = (await sample(.7)).matrix; await sample(1.8); assert.deepEqual((await sample(.7)).matrix, once);
    // Editor zone form, saved metadata, undo and connections.
    await page.locator('[data-side="scene"]').click(); await page.locator('[data-act="zone-open"]').click();
    const fit = () => page.locator('.modal-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
    assert.ok(await fit()); await page.locator('#zone-name').fill('入口走廊'); await page.locator('[data-act="zone-save"]').click();
    assert.equal(await page.evaluate(() => window.__director.getProject().zones[0].name), '入口走廊');
    await page.screenshot({ path: `${output}/zones.png` }); await page.locator('.modal-footer [data-act="close-modal"]').click();
    await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => window.__director.getProject().zones[0].name), '走廊');
    await page.locator(`#sidebar-content [data-select="${camId}"]`).click(); await page.locator('[data-inspect="camera"]').click();
    await page.locator('[data-inspector-section="motion"]').click(); await page.locator('[data-act="look-open"]').click(); assert.ok(await fit());
    await page.locator('#look-time').fill('1'); await page.locator('#look-0').fill('2'); await page.locator('[data-act="look-save"]').click();
    assert.equal(await page.evaluate(id => window.__director.getProject().entities.find(e => e.id === id).camera.targetPath.points.length, camId), 3);
    await page.screenshot({ path: `${output}/look.png` }); await page.locator('[data-act="look-remove"]').click();
    await page.locator('.modal-footer [data-act="close-modal"]').click();
    // Floating window state survives reload, with no clipped operation controls.
    await page.locator('#ai-toggle').click(); await page.locator('#ai-collapse').click(); assert.equal(Math.round((await page.locator('#ai-panel').boundingBox()).height), 58);
    const header = await page.locator('.ai-header').boundingBox(); await page.mouse.move(header.x + 40, header.y + 10); await page.mouse.down(); await page.mouse.move(300, 80); await page.mouse.up();
    const at = await page.locator('#ai-panel').boundingBox(); const saved = await page.evaluate(() => window.__director.getProject());
    await fs.writeFile(`${output}/saved.director`, JSON.stringify(saved)); await page.reload(); await page.waitForFunction(() => window.__director); await page.locator('#ai-toggle').click();
    assert.equal(await page.locator('#ai-collapse').getAttribute('aria-expanded'), 'false'); assert.equal((await page.locator('#ai-panel').boundingBox()).x, at.x);
    await page.locator('#ai-collapse').click(); await page.screenshot({ path: `${output}/floating.png` }); await page.locator('#ai-close').click();
    await page.locator('#project-file').setInputFiles(`${output}/saved.director`); await page.waitForFunction(() => window.__director.getProject().entities.some(e => e.id === 'lead'));
    assert.deepEqual((await sample(.7)).matrix, once);
    const modes = await page.evaluate(async camId => {
        const { Vector3 } = await import('/node_modules/.vite/deps/three.js'); const api = window.__director, original = api.getProject(), p = structuredClone(original);
        const c = p.entities.find(e => e.id === camId).camera; c.mode = 'follow'; c.targetId = 'lead'; c.offset = [0, 2, 6]; c.inheritRotation = false;
        api.replaceProject(p); const engine = api.getEngine(); engine.sample(1);
        const cam = engine.cameras.get(camId), target = engine.targetPosition(p.entities.find(e => e.id === camId));
        const followDot = cam.getWorldDirection(new Vector3()).dot(target.sub(cam.position).normalize()), followPosition = cam.position.toArray();
        c.mode = 'free'; c.aim = 'manual'; api.replaceProject(p); engine.sample(1);
        const before = engine.cameras.get(camId).matrixWorld.toArray(); c.targetPath = null; api.replaceProject(p); engine.sample(1);
        const after = engine.cameras.get(camId).matrixWorld.toArray(); api.replaceProject(original);
        return { followDot, followPosition, manualUnchanged: JSON.stringify(before) === JSON.stringify(after) };
    }, camId);
    assert.ok(modes.followDot > .999999); assert.deepEqual(modes.followPosition, [2, 2, 6]); assert.equal(modes.manualUnchanged, true);
    const beforeFraming = await page.evaluate(() => window.__director.getProject());
    await page.locator('[data-side="scene"]').click(); await page.locator(`#sidebar-content [data-select="${camId}"]`).click(); await page.locator('[data-inspect="camera"]').click();
    await page.locator('[data-inspector-section="lens"]').click(); await page.locator('[data-framing="中景"]').click();
    assert.equal(await page.evaluate(id => window.__director.getProject().entities.find(e => e.id === id).camera.targetPath, camId), null);
    await page.evaluate(p => window.__director.replaceProject(p), beforeFraming);
    // Continuation uses the actual last output frame and removes its old aim schedule.
    const continuation = await page.evaluate(async camId => {
        const { continueScene } = await import('/src/scenes/continue-scene.ts'), { readSceneDocument, projectForScene } = await import('/src/scenes/sequence-project.ts');
        const api = window.__director, e = api.getEngine(), original = structuredClone(api.getProject()); e.sample(47 / 24);
        const matrix = e.cameras.get(camId).matrixWorld.toArray();
        const doc = await continueScene(e, readSceneDocument(original), '接拍', 'continued'), p = projectForScene(doc);
        api.replaceProject(p); e.sample(0); const actual = e.cameras.get(camId).matrixWorld.toArray(); api.replaceProject(original);
        return { delta: Math.max(...matrix.map((x, i) => Math.abs(x - actual[i]))), zones: p.zones.length, path: p.entities.find(e => e.id === camId).camera.targetPath };
    }, camId); assert.ok(continuation.delta < 1e-7, JSON.stringify(continuation)); assert.equal(continuation.zones, 2); assert.equal(continuation.path, null);
    const frameTimes = [0, .5, 1, 1.5];
    for (const time of frameTimes) {
        const image = await page.evaluate(time => { const e = window.__director.getEngine(); e.exporting = true; const data = e.renderOutput(time, 1280, 720).toDataURL(); e.restorePreview(time); return data; }, time);
        await fs.writeFile(`${output}/frame-${time.toFixed(3)}.png`, Buffer.from(image.split(',')[1], 'base64'));
    }
    const video = Buffer.from(await page.evaluate(() => window.__director.exportForTest({ start: 0, end: 2, fps: 24, width: 1280, height: 720, cameraId: 'program', format: 'mp4', monochrome: false })));
    await fs.writeFile(`${output}/reference.mp4`, video); const decoded = await verifyVideoFrames(page, output, frameTimes); assert.deepEqual(errors, []);
    console.log({ passed: true, continuation, decoded });
} catch (error) { console.log(error.stack, errors); process.exitCode = 1; }
finally { await browser?.close(); await server.close(); }

