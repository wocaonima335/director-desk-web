import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

await fs.mkdir('tmp/batch-export', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/tmp/**'] } } });
await server.listen(); let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
    const errors = [], downloads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('download', download => downloads.push(download));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.waitForFunction(() => window.__director);
    await page.evaluate(async () => {
        const { demoProject, entity, clone } = await import('/src/model.ts');
        const { readSceneDocument } = await import('/src/scenes/sequence-project.ts');
        const project = demoProject(); project.duration = 2; project.room.enabled = false;
        const camera = entity('camera', 'camera', '参考机位', [0, 2, 6]); camera.camera.target = [0, 1, 0];
        const prop = entity('prop', 'shape-box', '画面主体', [0, 0, 0]); prop.scale = [2, 2, 2]; prop.color = '#d66363';
        project.entities = [camera, prop]; project.cuts = [{ time: 0, cameraId: camera.id }];
        const doc = readSceneDocument(project); doc.name = '批量导出验收';
        for (let i = 1; i <= 4; i++) {
            const scene = clone(doc.scenes[0]); scene.id = `scene-${i}`; scene.name = `第${i + 1}场`;
            scene.state.duration = 3; scene.state.fps = 30; scene.state.aspect = '9:16';
            scene.state.entities[1].color = '#6372d6'; doc.scenes.push(scene);
        }
        window.__director.replaceProject(doc); window.__director.setTime(.75);
        window.__beforeBatch = JSON.stringify(window.__director.getDocument());
        window.__beforeSignature = window.__director.signature();
    });
    await page.locator('[data-menu="file"]').click();await page.locator('[data-act="export"]').click();
    await page.locator('#export-name').fill('自定义文件名.mp4');
    assert.match(await page.locator('#export-summary').innerText(), /自定义文件名.mp4/);
    const fits = async () => {
        const overflow = await page.locator('.export-modal').evaluate(root => {
            const bounds = root.getBoundingClientRect();
            return [...root.querySelectorAll('input,select,button')].filter(e => e.getClientRects().length)
                .filter(e => { const r = e.getBoundingClientRect(); return r.left < bounds.left || r.right > bounds.right || r.bottom > bounds.bottom || r.top < 0 || r.bottom > innerHeight; })
                .map(e => e.id || e.textContent);
        });
        assert.deepEqual(overflow, []);
    };
    await fits();
    await page.locator('#export-scope').selectOption('batch');
    await fits();
    await page.locator('[data-pick="all"]').click();
    assert.match(await page.locator('[data-act="export-start"]').innerText(), /5/);
    await page.locator('[data-scene-name="scene-main"]').fill('追逐-开场');
    await page.locator('[data-pick="next"]').click();
    await page.locator('[data-scene-name="scene-4"]').fill('追逐-尾声');
    await page.locator('[data-pick="prev"]').click();
    assert.equal(await page.locator('[data-scene-name="scene-main"]').inputValue(), '追逐-开场');
    await page.locator('[data-pick="none"]').click();
    assert.equal(await page.locator('[data-act="export-start"]').isDisabled(), true);
    await page.locator('[data-scene-check="scene-main"]').check();
    await page.locator('[data-scene-check="scene-1"]').check();
    await page.locator('[data-scene-name="scene-1"]').fill('追逐-开场');
    await page.locator('#export-size').selectOption('640');
    await page.locator('#export-save').selectOption('download');
    await page.screenshot({ path: 'tmp/batch-export/dialog.png' });
    await page.locator('[data-act="export-start"]').click();
    await page.waitForSelector('.export-modal', { state: 'detached', timeout: 120000 });
    assert.equal(downloads.length, 2);
    assert.deepEqual(downloads.map(d => d.suggestedFilename()), ['追逐-开场.mp4', '追逐-开场 (2).mp4']);
    for (let i = 0; i < downloads.length; i++) {
        const file = `tmp/batch-export/${i + 1}.mp4`; await downloads[i].saveAs(file);
        const bytes = Array.from(await fs.readFile(file));
        const metadata = await page.evaluate(async bytes => {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
            const video = document.createElement('video'), url = URL.createObjectURL(blob); video.muted = true; video.src = url;
            await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
            video.currentTime = video.duration / 2;
            await new Promise(resolve => video.onseeked = resolve);
            const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
            const pixel = [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
            const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, pixel };
            URL.revokeObjectURL(url); video.remove(); return result;
        }, bytes);
        assert.deepEqual([metadata.width, metadata.height], i === 0 ? [640, 360] : [360, 640]);
        assert.ok(Math.abs(metadata.duration - (i === 0 ? 2 : 3)) < .05);
        assert.ok(i === 0 ? metadata.pixel[0] > metadata.pixel[2] : metadata.pixel[2] > metadata.pixel[0], 'video belongs to its scene: ' + JSON.stringify({ i, ...metadata }));
    }
    const restoration = await page.evaluate(() => ({
        document: window.__beforeBatch === JSON.stringify(window.__director.getDocument()),
        signature: JSON.stringify(window.__beforeSignature) === JSON.stringify(window.__director.signature()),
    }));
    assert.deepEqual(restoration, { document: true, signature: true });
    // A real cancellation must release the renderer and leave the editor usable.
    await page.locator('[data-menu="file"]').click();await page.locator('[data-act="export"]').click();
    await page.locator('#export-scope').selectOption('batch'); await page.locator('[data-pick="all"]').click();
    await page.locator('#export-save').selectOption('download');
    await page.locator('[data-act="export-start"]').click();
    await page.locator('[data-act="cancel-export"]').click();
    await page.waitForSelector('[data-act="export-start"]', { timeout: 30000 });
    assert(await page.locator('.export-modal').isVisible());
    await page.locator('.modal-footer [data-act="close-modal"]').click();
    assert.equal(await page.evaluate(() => window.__director.getEngine().exporting), false);
    assert.equal(await page.evaluate(() => window.__beforeBatch === JSON.stringify(window.__director.getDocument())), true);
    await page.setViewportSize({ width: 1000, height: 680 });
    await page.locator('[data-menu="file"]').click();await page.locator('[data-act="export"]').click(); await page.locator('#export-scope').selectOption('batch');
    await fits();
    await page.locator('.modal-footer [data-act="close-modal"]').click();
    assert.deepEqual(errors, []);
    console.log('Batch UI: paging, selection, renaming, duplicate filenames, actual MP4s with independent aspect/duration/content, restoration and cancellation passed.');
} finally { await browser?.close(); await server.close(); }
