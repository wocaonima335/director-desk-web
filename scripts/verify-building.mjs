import assert from 'node:assert/strict';

export async function verifyBuilding(page, baseline) {
    const stage = structuredClone(baseline);
    stage.room.enabled = false;
    const actor = structuredClone(stage.entities[1]); actor.position = [-2, 0, 1]; actor.path = null; actor.clips = []; actor.poseKeys = []; actor.pose = {};
    const camera = structuredClone(stage.entities.find(e => e.kind === 'camera')); camera.path = null; camera.camera.mode = 'free'; camera.camera.targetId = '';
    const prop = (id, asset, position) => ({ ...structuredClone(stage.entities.find(e => e.kind === 'prop')), id, name:id, asset, position, rotation:[0,0,0], scale:[1,1,1], path:null, locked:false });
    stage.entities = [actor, camera, prop('fixed-box', 'cube', [.33,0,3]), prop('moving-box','cube',[2,0,3]), prop('test-stairs','stairs',[0,0,0]), prop('test-table','table',[3,0,0])];
    stage.cuts = [{time:0,cameraId:camera.id}];
    await page.evaluate(p => window.__director.replaceProject(p), stage);
    await page.locator('[data-side="scene"]').click(); await page.locator('[data-view="stage"]').click();
    await page.locator('[data-select="moving-box"]').first().click(); await page.locator('[data-act="translate"]').click();
    await page.locator('#placement-snap').selectOption('0'); await page.locator('#object-snap').check();
    await page.evaluate(() => { const e=window.__director.getEngine(); e.editorCamera.position.set(5,5,10); e.orbit.target.set(1,.5,3); e.orbit.update(); e.render(); });
    const drag = async delta => {
        const points = await page.evaluate(delta => {
            const e=window.__director.getEngine(); e.render();
            const gizmo=e.gizmo.getHelper().children.find(c=>c.picker);
            const x=gizmo.picker.translate.children.find(c=>c.name==='X');
            x.geometry.computeBoundingBox(); const center=x.geometry.boundingBox.getCenter(e.editorCamera.position.clone()).applyMatrix4(x.matrixWorld);
            const rect=e.editorRenderer.domElement.getBoundingClientRect();
            const screen=p=>{p.project(e.editorCamera);return {x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2};};
            return {start:screen(center.clone()),end:screen(center.clone().add({x:delta,y:0,z:0}))};
        }, delta);
        await page.mouse.move(points.start.x,points.start.y); await page.mouse.down();
        await page.mouse.move(points.end.x,points.end.y,{steps:12}); await page.mouse.up();
    };
    await drag(-.55);
    let moved = await page.evaluate(()=>window.__director.getProject().entities.find(e=>e.id==='moving-box').position);
    assert.ok(Math.abs(moved[0]-1.33)<.015, `Actual X handle drag should join boxes; got ${moved}`);
    assert.ok(Math.abs(moved[1])<1e-8 && Math.abs(moved[2]-3)<1e-8);
    assert.ok((await page.locator('#object-snap-status').textContent()).includes('fixed-box'));
    await page.screenshot({path:'tmp/smoke/08-object-snap.png'});
    await page.locator('[data-act="undo"]').click(); await page.locator('#object-snap').uncheck();
    await drag(-.55);
    moved = await page.evaluate(()=>window.__director.getProject().entities.find(e=>e.id==='moving-box').position);
    assert.ok(Math.abs(moved[0]-1.45)<.025, `Off should preserve free drag; got ${moved}`);
    await page.locator('[data-act="undo"]').click();

    await page.locator(`[data-select="${actor.id}"]`).first().click(); await page.locator('[data-inspect="path"]').click();
    await page.locator('#placement-snap').selectOption('0.5');
    await page.locator('#path-surface-mode').selectOption('surface'); await page.locator('[data-act="draw-path"]').click();
    await page.evaluate(() => { const e=window.__director.getEngine();e.editorCamera.position.set(5,8,7);e.orbit.target.set(1,.4,-.5);e.orbit.update();e.render(); });
    const clickWorld = async position => {
        const at=await page.evaluate(position=>{const e=window.__director.getEngine();e.render();const p=e.editorCamera.position.clone().set(...position).project(e.editorCamera),r=e.editorRenderer.domElement.getBoundingClientRect();return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};},position);
        await page.mouse.click(at.x,at.y);
    };
    await clickWorld([0,.36,-.28]); await clickWorld([0,.9,-1.12]);
    let points = await page.evaluate(id=>window.__director.getProject().entities.find(e=>e.id===id).path.points,actor.id);
    assert.equal(points.length,3); assert.ok(Math.abs(points[1].position[1]-.36)<.006); assert.ok(Math.abs(points[2].position[1]-.9)<.006);
    // The active grid must not flatten the 18 cm steps.
    await page.locator('[data-act="finish-path"]').click();
    await page.screenshot({path:'tmp/smoke/09-stairs-path.png'});
    await page.locator('[data-act="undo"]').click();
    await page.locator('#path-surface-mode').selectOption('ground'); await page.locator('[data-act="draw-path"]').click();
    await clickWorld([0,.9,-1.12]); await page.locator('[data-act="finish-path"]').click();
    points=await page.evaluate(id=>window.__director.getProject().entities.find(e=>e.id===id).path.points,actor.id);
    assert.equal(points[1].position[1],0);
    await page.locator('#path-surface-mode').selectOption('surface'); await page.locator('#placement-snap').selectOption('0');
    await page.evaluate(p=>window.__director.replaceProject(p),baseline);
    console.log('Verified real handle object snap on/off, axis constraint and stair surface paths with grid enabled.');
}
