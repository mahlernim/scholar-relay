import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Exercise the shipped popup with Arabic messages and mixed-direction user data.
export async function arabicRtlSmoke({ popup, evaluate, reload, root, completedState }) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const catalog = JSON.parse(await readFile(join(root, '_locales', 'ar', 'messages.json'), 'utf8'));
    const out = join(root, 'dist', 'rtl-qa');
    await mkdir(out, { recursive: true });
    const collectionName = '2026 - Trial (A)';
    const { identifier } = await popup.call('Page.addScriptToEvaluateOnNewDocument', { source: `
        const catalog=${JSON.stringify(catalog)};
        chrome.i18n.getUILanguage=()=> 'ar';
        chrome.i18n.getMessage=(key,values=[])=>catalog[key]?.message.replace(/\\$(\\d+)/g,(_,i)=>values[i-1]??'')||'';
        const send=chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage=message=>message.type==='LIST_COLLECTIONS'
            ?Promise.resolve({ok:true,collections:[{id:'rtl-collection',name:${JSON.stringify(collectionName)},notebookIds:['notebook-one']}]})
            :send(message);
    ` });
    const title = 'دراسة Gemini Notebook 2026 (المرحلة 2)';
    const latinTitle = 'Trial 2026 (المرحلة 2)';
    const url = 'https://example.org/paper-2026.pdf?trial=12#results';
    const prompt = 'Explain trial 2026 (المرحلة 2), keep PDF URLs unchanged.';
    const report = [];
    async function screenshot(name, width) {
        await evaluate(popup, 'window.scrollTo(0,0)');
        await popup.call('Page.bringToFront');
        const shot = await popup.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(out, `ar-${name}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    async function assertHorizontalFit(width, name) {
        const layout = await evaluate(popup, `({width:document.documentElement.scrollWidth,
            clipped:[...document.querySelectorAll('button,select,textarea,.paper-row,.job-phase,.pdf-url,.nb-title')]
                .filter(el=>el.getClientRects().length && (el.getBoundingClientRect().left < -1 || el.getBoundingClientRect().right > ${width + 1}))
                .map(el=>el.id||el.className)})`);
        assert(layout.width <= width && !layout.clipped.length, `Arabic ${name} overflow at ${width}px: ${JSON.stringify(layout)}`);
    }
    try {
        for (const width of [320, 360]) {
            await popup.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
            await evaluate(popup, `__smoke.setFixtureState(${JSON.stringify({ ...completedState, notebookTitle: title, sourceTitle: latinTitle, pdfUrl: url,
                collectionAssignment: { status: 'completed', name: collectionName, collectionId: 'rtl-collection' } })},
                {userSettings:${JSON.stringify({ language: 'ko', generateAudio: false, generateInfographic: true, audioPrompt: prompt, collectionId: 'rtl-collection' })}})`);
            await reload(popup);
            await evaluate(popup, `document.querySelector('[data-show]').click()`);
            const result = await evaluate(popup, `({
                direction:document.documentElement.dir,
                title:document.querySelector('.nb-title').textContent,
                titleDirection:getComputedStyle(document.querySelector('.nb-title')).direction,
                queueTitle:document.querySelector('.job-title').textContent,
                queueTitleDirection:getComputedStyle(document.querySelector('.job-title')).direction,
                url:document.querySelector('.pdf-url').textContent,
                urlDirection:getComputedStyle(document.querySelector('.pdf-url')).direction,
                collectionName:document.querySelector('.collection-status bdi').textContent,
                collectionDirection:getComputedStyle(document.querySelector('.collection-status bdi')).direction,
                headerMirrored:document.querySelector('.header-icon').getBoundingClientRect().left > document.getElementById('btn-gear').getBoundingClientRect().right,
                phaseMirrored:document.querySelector('.job-activity').getBoundingClientRect().left > document.querySelector('.job-elapsed').getBoundingClientRect().right
            })`);
            assert(result.direction === 'rtl' && result.headerMirrored && result.phaseMirrored, `Arabic controls were not mirrored at ${width}px`);
            assert(result.title === title && result.titleDirection === 'rtl', 'Arabic notebook title was changed or has the wrong direction');
            assert(result.queueTitle === latinTitle && result.queueTitleDirection === 'ltr', 'Latin paper title was changed or has the wrong direction');
            assert(result.url === url && result.urlDirection === 'ltr', 'Mixed-content URL was changed or is not LTR');
            assert(result.collectionName === collectionName && result.collectionDirection === 'ltr', 'Collection name was changed or not isolated from Arabic status text');
            await assertHorizontalFit(width, 'completed');
            await screenshot('completed', width);

            await evaluate(popup, `document.getElementById('btn-gear').click()`);
            for (let attempt = 0; attempt < 50; attempt++) {
                if (await evaluate(popup, `document.getElementById('s-audioPrompt').value===${JSON.stringify(prompt)}`)) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            // Loading saved false changes the initially checked control. Let
            // its existing 200 ms thumb transition finish before geometry QA.
            await new Promise(resolve => setTimeout(resolve, 250));
            const settings = await evaluate(popup, `(() => {
                document.querySelectorAll('.s-section').forEach(el=>el.classList.add('expanded'));
                const toggle=document.getElementById('s-generateAudio');
                const track=toggle.nextElementSibling;
                toggle.focus();
                return {prompt:document.getElementById('s-audioPrompt').value,
                    promptDirection:getComputedStyle(document.getElementById('s-audioPrompt')).direction,
                    language:document.getElementById('s-language').value,
                    collectionOption:[...document.getElementById('s-collectionId').options].find(option=>option.value==='rtl-collection')?.textContent,
                    collectionDirection:getComputedStyle([...document.getElementById('s-collectionId').options].find(option=>option.value==='rtl-collection')).direction,
                    focused:document.activeElement===toggle,checked:toggle.checked,
                    right:getComputedStyle(track,'::after').right,transform:getComputedStyle(track,'::after').transform,
                    overflow:[...document.querySelectorAll('.s-section-content,.s-field,.s-radio-group')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className)};
            })()`);
            assert(settings.prompt === prompt && settings.promptDirection === 'ltr' && settings.language === 'ko', 'Arabic UI changed the saved prompt or output language');
            assert(settings.collectionOption === `${collectionName} (1)` && settings.collectionDirection === 'ltr', 'Collection option lost its name, count, or automatic direction');
            assert(settings.focused && !settings.checked && settings.right === '2px' && settings.transform === 'none', `RTL toggle does not begin at its inline start: ${JSON.stringify(settings)}`);
            assert(!settings.overflow.length, `Arabic expanded settings overflow at ${width}px: ${settings.overflow}`);
            await popup.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
            await popup.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
            await new Promise(resolve => setTimeout(resolve, 250));
            const switched = await evaluate(popup, `(() => {const toggle=document.getElementById('s-generateAudio');
                return {checked:toggle.checked,focused:document.activeElement===toggle,
                    transform:getComputedStyle(toggle.nextElementSibling,'::after').transform,
                    outline:getComputedStyle(toggle.nextElementSibling).outlineStyle};})()`);
            assert(switched.checked && switched.focused && switched.transform === 'matrix(1, 0, 0, 1, -15, 0)' && switched.outline === 'solid', 'RTL toggle lost keyboard control, focus visibility, or mirrored movement');
            await assertHorizontalFit(width, 'settings');
            await screenshot('settings', width);
            await evaluate(popup, `document.getElementById('btn-save-close').click()`);
            for (let attempt = 0; attempt < 50; attempt++) {
                if (await evaluate(popup, `!document.getElementById('settings-panel').classList.contains('open')`)) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }

            await evaluate(popup, `__smoke.renderPaperSelection(${JSON.stringify({ pageUrl: 'https://example.org/rtl-review', sourceTitle: title,
                candidates: [{ id: 'rtl-arabic', sourceTitle: title, pdfUrl: url, pageUrl: 'https://example.org/rtl-review', featured: true },
                    { id: 'rtl-latin', sourceTitle: latinTitle, pdfUrl: 'https://arxiv.org/pdf/2601.04480', pageUrl: 'https://example.org/rtl-review', arxivId: '2601.04480' }] })})`);
            const papers = await evaluate(popup, `(() => {
                document.querySelector('[name="paper-mode"][value="one"]').click();
                return {titles:[...document.querySelectorAll('[data-paper-title]')].map(el=>({text:el.textContent,direction:getComputedStyle(el).direction,tag:el.tagName})),
                    inputDirection:getComputedStyle(document.getElementById('paper-title')).direction,
                    inputTitle:document.getElementById('paper-title').value,
                    rowsMirrored:[...document.querySelectorAll('.paper-row')].every(row=>row.querySelector('input').getBoundingClientRect().left > row.querySelector('a').getBoundingClientRect().right)};
            })()`);
            assert(papers.titles[0].text === title && papers.titles[0].direction === 'rtl' && papers.titles[0].tag === 'BDI', 'Arabic paper title was not isolated');
            assert(papers.titles[1].text === latinTitle && papers.titles[1].direction === 'ltr' && papers.titles[1].tag === 'BDI', 'Latin paper title was not isolated');
            assert(papers.rowsMirrored && papers.inputTitle === title && papers.inputDirection === 'rtl', 'Arabic paper controls or title input have the wrong direction');
            await assertHorizontalFit(width, 'papers');
            await screenshot('papers', width);
            report.push({ width, documentDirection: result.direction, mirroredHeader: result.headerMirrored,
                mirroredQueue: result.phaseMirrored, mixedTitlesPreserved: true, urlDirection: result.urlDirection,
                keyboardToggle: switched.checked && switched.focused, expandedSettingsFit: true });
        }
    } finally {
        await popup.call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        await popup.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
        await reload(popup);
    }
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Arabic RTL smoke passed at 320/360 px with mixed titles, URLs, mirrored controls and keyboard access.');
}
