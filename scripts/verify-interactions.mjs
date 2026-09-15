import assert from 'node:assert/strict';
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';

export async function verifyInteractions(page, baseline, ids) {
  const restore = () => page.evaluate(p => window.__director.replaceProject(p), baseline);
  await restore();
  await page.locator(`[data-select="${ids.actor}"]`).first().click();
  await page.locator('[data-inspect="pose"]').click();
  await page.locator('[data-joint="leftArm"]').evaluate(el => { el.value = '20'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('[data-act="pose-key"]').click();
  await page.waitForFunction(id => window.__director.getProject().entities.find(e => e.id === id).poseKeys.length === 1, ids.actor);
  await page.evaluate(() => window.__director.setTime(2));
  await page.locator('[data-joint="leftArm"]').evaluate(el => { el.value = '60'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const keys = await page.evaluate(id => window.__director.getProject().entities.find(e => e.id === id).poseKeys, ids.actor);
  assert.deepEqual(keys.map(k => [k.time, k.pose.leftArm]), [[0, 20], [2, 60]]);
  await page.locator('[data-act="pose-mirror"]').click();
  assert.equal(await page.evaluate(id => window.__director.getProject().entities.find(e => e.id === id).poseKeys[1].pose.rightArm, ids.actor), 60);

  await restore();
  await page.locator(`[data-select="${ids.actor}"]`).first().click();
  await page.locator('[data-inspect="path"]').click();
  await page.locator('[data-act="draw-path"]').click();
  await page.waitForFunction(() => document.querySelector('#viewports').classList.contains('stage'));
  console.log('Path canvas:', await page.evaluate(() => { const e=window.__director.getEngine(); e.render(); return {width:e.editorRenderer.domElement.clientWidth, stage:e.stage.clientWidth, exporting:e.exporting, drawing:e.drawingPath}; }));
  const ground = await page.evaluate(() => {
    const eng = window.__director.getEngine(); eng.render();
    const p = eng.editorCamera.position.clone().set(.2, 0, .7).project(eng.editorCamera);
    const rect = eng.editorRenderer.domElement.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 };
  });
  await page.mouse.click(ground.x, ground.y);
  await page.locator('[data-act="finish-path"]').click();
  const points = await page.evaluate(id => window.__director.getProject().entities.find(e => e.id === id).path.points, ids.actor);
  assert.equal(points.length, 2);
  assert.ok(Math.abs(points[1].position[0] - .2) < .01 && Math.abs(points[1].position[2] - .7) < .01);

  await restore();
  await page.locator(`[data-select="${ids.camera}"]`).first().click();
  await page.locator('[data-field="camera.aim"]').selectOption('manual');
  await page.locator('[data-field="rot.1"]').fill('45');
  await page.locator('[data-field="rot.1"]').press('Tab');
  const manual = await page.evaluate(id => {
    const eng = window.__director.getEngine();
    return { config: window.__director.getProject().entities.find(e => e.id === id).camera.aim, yaw: eng.cameras.get(id).rotation.y };
  }, ids.camera);
  assert.equal(manual.config, 'manual');
  assert.ok(Math.abs(manual.yaw - Math.PI / 4) < 1e-6);
  await restore();
  const pov = await page.evaluate(() => {
    const api = window.__director, id = api.getProject().entities.find(e => e.camera?.mode === 'pov').id;
    api.setPreview(id);
    return [3, 5, 7, 8].map(t => { api.setTime(t); return api.signature().world; });
  });
  assert.notDeepEqual(pov[0], pov[1], 'POV follows moving actor');
  assert.deepEqual(pov[2], pov[3], 'POV holds when actor holds');

  await restore();
  const formats = [];
  for (const fps of [24, 30, 50, 59, 60, 90, 120]) {
    const bytes = await page.evaluate(async ({fps, cameraId}) => window.__director.exportForTest({start: 1, end: 1 + 3 / fps, fps, width: 1920, height: 1080, cameraId, format: 'mp4', monochrome: false}), {fps, cameraId: ids.camera});
    const input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    assert.equal(track.displayWidth, 1920); assert.equal(track.displayHeight, 1080);
    let frames = 0; for await (const packet of new EncodedPacketSink(track).packets()) frames++;
    assert.equal(frames, 3); assert.ok(Math.abs(await input.computeDuration() - 3 / fps) < .001);
    input.dispose(); formats.push(fps);
    console.log(`Verified 1080p MP4 at ${fps} fps.`);
  }
  await restore();
  return { interactions: ['joint keyframes + mirror', 'draw ground path', 'manual camera rotation', 'POV movement + hold'], mp4FrameRates: formats };
}
