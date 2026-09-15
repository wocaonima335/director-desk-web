import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const output = 'tmp/camera-motion-design';
await fs.mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null } });
await server.listen(); let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.waitForFunction(() => window.__director);
    const ids = await page.evaluate(async () => {
        const { demoProject, entity, assertProject } = await import('/src/model.ts');
        const p = demoProject(), camera = entity('camera', 'camera', 'QA 连贯机位', [0, 2, 10]);
        const actor = entity('actor', 'person', 'QA 目标', [0, 0, 0]);
        camera.camera.target = [0, 1.2, 0]; camera.camera.focal = 35;
        camera.path = { smooth: true, points: [{ time: 0, position: [0, 2, 10] }, { time: 2, position: [2, 3, 8], easing: 'ease-in' }, { time: 5, position: [-2, 2, 6], easing: 'ease-out' }, { time: 8, position: [0, 2, 4] }] };
        camera.camera.targetPath = { smooth: true, points: [{ time: 0, position: [0, 1, 0] }, { time: 3, position: [2, 1, -1], easing: 'ease-in' }, { time: 8, position: [-2, 1, 1], easing: 'ease-out' }] };
        actor.path = { smooth: false, points: [{ time: 0, position: [0, 0, 0] }, { time: 8, position: [2, 0, -2] }] };
        p.duration = 8; p.entities = [camera, actor]; p.cuts = [{ time: 0, cameraId: camera.id }];
        assertProject(p); window.__director.replaceProject(p);
        await window.__director.callTool('director_view', { time: 0, entityId: camera.id });
        return { camera: camera.id, actor: actor.id };
    });
    const camera = () => page.evaluate(id => window.__director.getProject().entities.find(e => e.id === id), ids.camera);
    const undo = async () => { await page.locator('[data-menu="edit"]').click(); await page.locator('[data-act="undo"]').click(); };
    const redo = async () => { await page.locator('[data-menu="edit"]').click(); await page.locator('[data-act="redo"]').click(); };
    const coordinates = points => points.map(({ time, position }) => ({ time, position }));
    const verifyReadOnlyCurve = async channel => {
        await page.locator('#curve-channel').selectOption(channel);
        assert.equal(await page.locator('[data-curve-handle]').count(), 0, 'continuous curves have no fictitious Bezier handles');
        assert.equal(await page.locator('#curve-preset').count(), 0, 'continuous curves have no segment easing control');
        assert.match(await page.locator('#curve-graph').getAttribute('aria-label'), /实际路程.*只读/);
        const progress = await page.evaluate(async ({ id, channel }) => {
            const { pathPosition } = await import('/src/timeline.ts');
            const { cameraLookAt } = await import('/src/animation/camera-look.ts');
            const entity = window.__director.getProject().entities.find(e => e.id === id);
            const path = channel === 'path' ? entity.path : entity.camera.targetPath;
            const index = Number(document.getElementById('curve-segment').value), start = path.points[index - 1].time, end = path.points[index].time;
            const sample = at => channel === 'path' ? pathPosition({ ...path, sections: undefined }, entity.position, at) : cameraLookAt(path, at);
            const plotted = document.querySelector('#curve-graph .curve-line').getAttribute('points').split(' ').map(pair => (150 - Number(pair.split(',')[1])) / 126);
            let previous = sample(start), length = 0; const distances = [0];
            for (let i = 1; i <= 400; i++) { const point = sample(start + (end - start) * i / 400); length += point.distanceTo(previous); distances.push(length); previous = point; }
            const errors = [25, 50, 75].map(i => Math.abs(plotted[i] - distances[i * 4] / length));
            return { samples: plotted.length, quarter: plotted[25], maximumProgressError: Math.max(...errors) };
        }, { id: ids.camera, channel });
        assert.equal(progress.samples, 101);
        assert.ok(progress.maximumProgressError < .0001, 'displayed progress matches independently denser actual-path samples: ' + JSON.stringify(progress));
        return progress;
    };

    await page.locator('[data-inspect="path"]').click();
    const originalPath = (await camera()).path;
    await page.locator('#path-interpolation').selectOption('continuous');
    assert.equal((await camera()).path.interpolation, 'continuous');
    assert.ok((await camera()).path.points.every(point => point.easing === undefined));
    assert.deepEqual(coordinates((await camera()).path.points), coordinates(originalPath.points));
    assert.equal(await page.locator('[data-field="path-smooth"]').count(), 0);
    assert.equal(await page.locator('#path-point-stop').inputValue(), 'stop');
    await undo(); assert.deepEqual((await camera()).path, originalPath, 'one undo restores all replaced speed curves');
    await redo();
    await page.locator('#path-point-stop').selectOption('pass');
    assert.equal((await camera()).path.points[0].stop, false);
    await undo(); assert.equal((await camera()).path.points[0].stop, undefined);
    await page.locator('#path-point-choice').selectOption('1');
    assert.equal(await page.locator('#path-point-stop').inputValue(), 'pass');
    await page.locator('#path-point-stop').selectOption('stop');
    assert.equal((await camera()).path.points[1].stop, true);
    await page.locator('#path-interpolation').selectOption('segmented');
    assert.equal((await camera()).path.interpolation, undefined);
    assert.equal(await page.locator('[data-field="path-smooth"]').count(), 1);
    assert.deepEqual(coordinates((await camera()).path.points), coordinates(originalPath.points));
    await page.locator('#path-interpolation').selectOption('continuous');
    await page.locator('[data-timeline-view="curves"]').click();
    const pathCurve = await verifyReadOnlyCurve('path');
    assert.ok(Math.abs(pathCurve.quarter - .25) > .03, 'continuous progress is not a placeholder diagonal');
    await page.locator('#path-interpolation').selectOption('segmented');
    assert.equal(await page.locator('[data-curve-handle]').count(), 2, 'legacy interpolation restores Bezier handles');
    assert.equal(await page.locator('#curve-preset').isDisabled(), false);
    await page.locator('#curve-preset').selectOption('ease-in');
    assert.equal((await camera()).path.points[1].easing, 'ease-in', 'restored curve controls edit the actual path');
    await page.locator('[data-curve-handle="0"]').press('ArrowUp');
    assert.ok(Array.isArray((await camera()).path.points[1].easing.bezier), 'restored handles support keyboard editing');
    await page.locator('#path-interpolation').selectOption('continuous');
    await verifyReadOnlyCurve('path');
    await page.waitForFunction(() => !document.querySelector('#toasts .toast'));
    const pathLayout = await page.locator('#inspector-content').evaluate(root => {
        root.scrollTop = 0; const bounds = root.getBoundingClientRect(), button = root.querySelector('[data-act="surface-open"]').getBoundingClientRect();
        return { panelBottom: bounds.bottom, surfaceButtonBottom: button.bottom };
    });
    assert.ok(pathLayout.surfaceButtonBottom <= pathLayout.panelBottom, 'surface check action fits the default 1440x900 inspector');
    await page.screenshot({ path: `${output}/path-ui.png` });
    await page.setViewportSize({ width: 1280, height: 720 });
    const hiddenBasicPathControls = await page.locator('#inspector-content').evaluate(root => {
        root.scrollTop = 0; const bounds = root.getBoundingClientRect();
        return [...root.querySelectorAll('#path-point-choice,#path-interpolation,#path-point-stop,[data-point],[data-act="append-point"],[data-act="hold-point"]')].filter(element => {
            const rect = element.getBoundingClientRect(); return rect.top < bounds.top || rect.bottom > bounds.bottom;
        }).map(element => element.id || element.dataset.act || element.dataset.axis);
    });
    assert.deepEqual(hiddenBasicPathControls, [], 'basic waypoint controls fit the default 1280x720 inspector');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-timeline-view="tracks"]').click();

    const continuousPath = (await camera()).path;
    await page.locator('[data-inspect="camera"]').click();
    const response = page.locator('[data-field="camera.aimResponse.duration"]');
    assert.equal(await response.isDisabled(), false);
    await response.fill('0.35'); await response.dispatchEvent('change');
    assert.equal((await camera()).camera.aimResponse.duration, .35);
    await undo(); assert.equal((await camera()).camera.aimResponse, undefined);
    await redo();
    await page.locator('[data-field="camera.aim"]').selectOption('manual');
    assert.equal(await response.isDisabled(), true);
    await page.locator('[data-field="camera.mode"]').selectOption('follow');
    assert.equal(await response.isDisabled(), false, 'follow looks at its target despite a stored manual aim');
    await page.locator('[data-field="camera.mode"]').selectOption('pov');
    assert.equal(await response.isDisabled(), true);
    await page.locator('[data-field="camera.mode"]').selectOption('free');
    await page.locator('[data-field="camera.aim"]').selectOption('target');
    await response.fill('0'); await response.dispatchEvent('change');
    assert.equal((await camera()).camera.aimResponse, undefined);
    await response.fill('0.35'); await response.dispatchEvent('change');

    await page.locator('[data-act="look-open"]').click();
    const originalLook = (await camera()).camera.targetPath;
    await page.locator('#look-0').fill('3.25'); await page.locator('#look-time').fill('1');
    await page.locator('#look-interpolation').selectOption('continuous');
    assert.equal(await page.locator('#look-0').inputValue(), '3.25', 'mode change keeps unsaved coordinates');
    assert.equal(await page.locator('#look-time').inputValue(), '1', 'mode change keeps unsaved time');
    assert.equal((await camera()).camera.targetPath.interpolation, 'continuous');
    assert.ok((await camera()).camera.targetPath.points.every(point => point.easing === undefined));
    assert.deepEqual(coordinates((await camera()).camera.targetPath.points), coordinates(originalLook.points));
    assert.equal(await page.locator('#look-stop').inputValue(), 'stop');
    assert.equal(await page.locator('#look-smooth').count(), 0);
    await page.locator('.modal [aria-label="关闭"]').click();
    await undo(); assert.deepEqual((await camera()).camera.targetPath, originalLook, 'look conversion is one undoable operation');
    await redo(); await page.locator('[data-act="look-open"]').click();
    await page.locator('#look-choice').selectOption('1');
    assert.equal(await page.locator('#look-stop').inputValue(), 'pass');
    await page.locator('#look-stop').selectOption('stop');
    assert.equal((await camera()).camera.targetPath.points[1].stop, true);
    await page.locator('#look-time').fill('4'); await page.locator('#look-0').fill('1.25');
    await page.locator('[data-act="look-save"]').click();
    assert.equal((await camera()).camera.targetPath.points.find(point => point.time === 4).position[0], 1.25);
    await page.locator('#look-interpolation').selectOption('segmented');
    assert.equal(await page.locator('#look-smooth').count(), 1);
    await page.locator('#look-interpolation').selectOption('continuous');
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
        await page.setViewportSize(viewport);
        const overflow = await page.locator('.modal').evaluate(modal => {
            const bounds = modal.getBoundingClientRect();
            return [...modal.querySelectorAll('input,select,button')].filter(e => e.getClientRects().length).filter(e => {
                const r = e.getBoundingClientRect();
                return r.left < bounds.left || r.right > bounds.right || r.top < bounds.top || r.bottom > bounds.bottom;
            }).map(e => e.id || e.textContent);
        });
        assert.deepEqual(overflow, [], 'look controls fit the dialog at ' + viewport.width + 'x' + viewport.height);
    }
    await page.waitForFunction(() => !document.querySelector('#toasts .toast'));
    await page.screenshot({ path: `${output}/look-ui.png` });
    await page.locator('.modal [aria-label="关闭"]').click();

    await page.locator('[data-timeline-view="curves"]').click();
    const lookCurve = await verifyReadOnlyCurve('look');
    await page.locator('[data-timeline-view="tracks"]').click();
    const continuousLook = (await camera()).camera.targetPath;
    await page.locator('[data-act="look-open"]').click();
    await page.locator('[data-act="look-clear"]').click();
    await page.locator('#look-interpolation').selectOption('continuous');
    await page.locator('#look-stop').selectOption('pass');
    await page.locator('#look-time').fill('0'); await page.locator('#look-0').fill('1.75');
    await page.locator('[data-act="look-save"]').click();
    const createdLook = (await camera()).camera.targetPath;
    assert.equal(createdLook.interpolation, 'continuous'); assert.equal(createdLook.points.length, 1);
    assert.equal(createdLook.points[0].stop, false); assert.equal(createdLook.points[0].position[0], 1.75);
    await page.locator('.modal [aria-label="关闭"]').click();
    await undo(); assert.equal((await camera()).camera.targetPath, null, 'first continuous look key undoes as one edit');
    await undo(); assert.deepEqual((await camera()).camera.targetPath, continuousLook);
    // Keep rendering/export integration in one reusable fixture for later encoded-video checks.
    const integration = await page.evaluate(async ({ camera: cameraId, actor: actorId, path }) => {
        const { assertProject } = await import('/src/model.ts');
        const { readSceneDocument, projectForScene } = await import('/src/scenes/sequence-project.ts');
        const api = window.__director, engine = api.getEngine(), p = api.getProject();
        const camera = p.entities.find(e => e.id === cameraId);
        camera.path = path; camera.camera.targetId = actorId; camera.camera.aimResponse = { duration: .35 };
        assertProject(p); api.replaceProject(p);
        const matrices = at => {
            engine.sample(at);
            const preview = engine.cameras.get(cameraId).matrixWorld.toArray();
            engine.renderOutput(at, 640, 360, cameraId);
            const output = engine.getShotCamera(cameraId).matrixWorld.toArray();
            const error = Math.max(...preview.map((value, i) => Math.abs(value - output[i])));
            if (error > 1e-10) throw Error('Preview/output camera matrix mismatch at ' + at + ': ' + error);
            return output;
        };
        const times = [0, 1 / 24, 1.1, 2, 2.001, 3.9, 5, 7.9, 8], baseline = times.map(matrices);
        const order = [8, 3, 1, 7, 0, 5, 2, 6, 4];
        for (const index of order) if (JSON.stringify(matrices(times[index])) !== JSON.stringify(baseline[index])) throw Error('Random seek changed camera at ' + times[index]);
        const saved = JSON.stringify(api.getDocument()), document = readSceneDocument(JSON.parse(saved));
        api.replaceProject(document);
        const reloaded = api.getProject().entities.find(e => e.id === cameraId);
        if (JSON.stringify(reloaded.path) !== JSON.stringify(camera.path) || JSON.stringify(reloaded.camera) !== JSON.stringify(camera.camera)) throw Error('Save/reload changed motion settings');
        for (const index of order) if (JSON.stringify(matrices(times[index])) !== JSON.stringify(baseline[index])) throw Error('Save/reload changed sample at ' + times[index]);
        assertProject(projectForScene(document));
        const frameRates = [24, 30, 60], outputFrames = times.map(at => engine.renderOutput(at, 320, 180, cameraId).toDataURL());
        for (const fps of frameRates) {
            const rateProject = structuredClone(p); rateProject.fps = fps; api.replaceProject(rateProject);
            for (const [index, at] of times.entries()) {
                if (JSON.stringify(matrices(at)) !== JSON.stringify(baseline[index])) throw Error('Frame rate changed camera matrix at ' + fps + 'fps / ' + at);
                if (engine.renderOutput(at, 320, 180, cameraId).toDataURL() !== outputFrames[index]) throw Error('Frame rate changed actual output pixels at ' + fps + 'fps / ' + at);
            }
        }
        api.replaceProject(document); engine.restorePreview(0);
        return { sampledTimes: times, randomSeekOrder: order, previewMatchesOutput: true, saveReload: true, frameRates, sameTimeOutputPixels: true, document: JSON.parse(saved) };
    }, { ...ids, path: continuousPath });
    await fs.writeFile(`${output}/fixture.director`, JSON.stringify(integration.document, null, 2));
    delete integration.document;
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ui: 'path/look mode conversion + undo, waypoint stop, target response mode gates, read-only actual progress + restored legacy Bezier editing passed', curves: { path: pathCurve, look: lookCurve }, integration }));
} finally { await browser?.close(); await server.close(); }
