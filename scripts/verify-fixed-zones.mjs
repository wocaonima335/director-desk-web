import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

await fs.mkdir('tmp/fixed-zones',{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0,watch:{ignored:['**/tmp/**','**/.local/**']}}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.waitForFunction(()=>window.__director);
    await page.evaluate(async()=>{
        const {createScene}=await import('/src/scenes.ts');const p=createScene('abstract-stage');window.__director.replaceProject(p);
        const c=p.entities.find(e=>e.camera&&e.path?.points.length>1);await window.__director.callTool('director_view',{entityId:c.id,time:2});return c.id;
    });
    assert.equal(await page.locator('#scrubber').count(),0);
    assert.equal(await page.locator('.topbar #scene-switch').count(),1);
    assert.equal(await page.locator('.sidebar .side-tabs #creation-mode').count(),1);
    for(const menu of ['file','edit','scene','help']) {
        await page.locator(`[data-menu="${menu}"]`).click();
        assert(await page.locator(`#application-menu-${menu}`).isVisible());
        await page.keyboard.press('Escape');assert(!await page.locator(`#application-menu-${menu}`).isVisible());
    }
    await page.locator('[data-menu=scene]').focus();await page.keyboard.press('ArrowDown');
    assert(await page.locator('#application-menu-scene').isVisible());await page.keyboard.press('Escape');
    for(const [width,height] of [[1600,1000],[1280,720]]) {
        await page.setViewportSize({width,height});
        const problems=await page.evaluate(()=>{
            const issues=[];
            for(const selector of ['.topbar','.view-toolbar','.monitor-strip','.transport']){
                const root=document.querySelector(selector),bounds=root.getBoundingClientRect();
                const controls=[...root.querySelectorAll('button,select,input')].filter(e=>e.checkVisibility());
                controls.forEach((a,i)=>{
                    const r=a.getBoundingClientRect();
                    if(r.left<bounds.left-1||r.right>bounds.right+1||r.bottom>bounds.bottom+1)issues.push(`${selector}: outside ${a.id||a.dataset.act}`);
                    for(const b of controls.slice(i+1)){const s=b.getBoundingClientRect();if(Math.min(r.right,s.right)-Math.max(r.left,s.left)>1&&Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)>1)issues.push(`${selector}: overlap ${a.id||a.dataset.act} / ${b.id||b.dataset.act}`);}
                });
            }
            return issues;
        });
        assert.deepEqual(problems,[],`${width} × ${height}`);
        await page.locator('[data-timeline-view="curves"]').click();
        await page.locator('#curve-channel').selectOption('path');
        assert.equal(await page.locator('#inspector-content #curve-graph').count(),0);
        assert(await page.locator('#timeline-curves #curve-graph').isVisible());
        const outside=await page.locator('#timeline-curves').evaluate(root=>{
            const b=root.getBoundingClientRect();return [...root.querySelectorAll('button,select,svg')].filter(e=>{const r=e.getBoundingClientRect();return r.height&&(r.bottom>b.bottom+1||r.top<b.top-1||r.right>b.right+1);}).map(e=>e.id||e.textContent);
        });assert.deepEqual(outside,[]);
        const ruler=await page.locator('.ruler').boundingBox();await page.mouse.click(ruler.x+180,ruler.y+8);
        assert.equal(await page.evaluate(()=>window.__director.getEngine().time),3);
        await page.screenshot({path:`tmp/fixed-zones/curves-${width}.png`});
        await page.locator('[data-timeline-view="tracks"]').click();assert(!await page.locator('#timeline-curves').isVisible());
        assert(await page.locator('#timeline-content .timeline-row:not(.ruler-row)').first().isVisible());
        await page.screenshot({path:`tmp/fixed-zones/workspace-${width}.png`});
    }
    // Curves follow the current object without changing its right-hand parameter tab.
    await page.locator('[data-timeline-view="curves"]').click();
    await page.evaluate(async()=>{const api=window.__director;const lamp=api.getProject().entities.find(e=>e.light);const result=await api.callTool('director_view',{entityId:lamp.id,time:3});if(!result.ok)throw Error(result.error);});
    assert(await page.locator('[data-inspect="light"].active').isVisible());
    await page.locator('#ai-toggle').click();assert(await page.locator('#ai-panel').isVisible());await page.locator('#ai-close').click();
    await page.locator('[data-timeline-view="tracks"]').click();
    await page.locator('[data-act="production-prompt"]').click();assert(await page.locator('#modal-root').textContent());
    assert.deepEqual(errors,[]);
    console.log('Fixed zones: two desktop sizes, toolbar bounds, shared ruler seeking, track/curve switching, selection and AI/prompt entries passed.');
} finally {await browser.close();await server.close();}
