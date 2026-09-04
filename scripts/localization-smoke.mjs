import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messageKey } from '../i18n.js';

// Deterministic locale fixtures exercise the real popup and shipped message bundles.
// Only the isolated test page overrides Chrome's locale, never the production extension.
export async function localizationSmoke({ popup, evaluate, reload, root, completedState }) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const report = [];
    const out = join(root, 'dist', 'localization-qa');
    await mkdir(out, { recursive: true });
    for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt_BR']) {
        const catalog = JSON.parse(await readFile(join(root, '_locales', locale, 'messages.json'), 'utf8'));
        const expected = source => catalog[messageKey(source)].message;
        const { identifier } = await popup.call('Page.addScriptToEvaluateOnNewDocument', { source: `
            const catalog=${JSON.stringify(catalog)};
            chrome.i18n.getUILanguage=()=>${JSON.stringify(locale.replace('_', '-'))};
            chrome.i18n.getMessage=(key, values=[])=>catalog[key]?.message.replace(/\\$(\\d+)/g,(_,index)=>values[index-1]??'')||'';
        ` });
        try {
            const title = 'Settings "<Source>" $1';
            await evaluate(popup, `chrome.storage.local.set({pipelineState:${JSON.stringify({ ...completedState, notebookTitle: title })}, userSettings:{language:'ko',generateAudio:false,generateInfographic:true,audioPrompt:'Keep my prompt $1'}})`);
            await reload(popup);
            const done = await evaluate(popup, `({title:document.querySelector('.nb-title').textContent,
                text:document.querySelector('.completed-box').innerText, width:document.documentElement.scrollWidth,
                bottom:document.querySelector('.completed-box').getBoundingClientRect().bottom})`);
            assert(done.title === title, `${locale} translated user content`);
            assert(done.text.includes(expected('Artifacts ready: $1!').replace('$1','2')), `${locale} completion not translated`);
            assert(done.width <= 360 && done.bottom <= 600, `${locale} completion overflow`);
            await popup.call('Page.bringToFront');
            const screen = await popup.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            await writeFile(join(out, `${locale}-complete.png`), Buffer.from(screen.data, 'base64'));
            await evaluate(popup, `document.getElementById('btn-gear').click()`);
            // loadSettings can await storage and collection IO. Wait on the loaded prompt.
            for (let n = 0; n < 50; n++) {
                if (await evaluate(popup, `document.getElementById('s-audioPrompt').value==='Keep my prompt $1'`)) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            const settings = await evaluate(popup, `({audio:document.querySelector('#sec-audio .s-section-title').textContent,
                language:document.getElementById('s-language').value,prompt:document.getElementById('s-audioPrompt').value,
                label:document.getElementById('s-generateAudio').getAttribute('aria-label'),
                width:document.documentElement.scrollWidth})`);
            assert(settings.audio === expected('🎧 Audio Overview'), `${locale} audio terminology mismatch`);
            assert(settings.label === settings.audio, `${locale} missing localized toggle label`);
            assert(settings.language === 'ko' && settings.prompt === 'Keep my prompt $1', `${locale} changed saved output language or prompt`);
            // Expand every group and inspect its scroll width, not just the visible top.
            const overflow = await evaluate(popup, `(() => {
                document.querySelectorAll('.s-section').forEach(el=>el.classList.add('expanded'));
                return [...document.querySelectorAll('.s-section-content,.s-field,.s-radio-group')]
                    .filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className);
            })()`);
            assert(settings.width <= 360 && overflow.length === 0, `${locale} settings overflow: ${overflow}`);
            const settingsScreen = await popup.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            await writeFile(join(out, `${locale}-settings.png`), Buffer.from(settingsScreen.data, 'base64'));
            await evaluate(popup, `document.getElementById('btn-save-close').click()`);
            for (let n = 0; n < 50; n++) {
                if (await evaluate(popup, `!document.getElementById('settings-panel').classList.contains('open')`)) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            const saved = await evaluate(popup, `chrome.storage.local.get('userSettings').then(r=>r.userSettings)`);
            assert(saved.language === 'ko' && saved.audioPrompt === 'Keep my prompt $1' && saved.generateAudio === false, `${locale} save altered preferences`);
            for (const fixture of [
                { status:'error', step:'add_source', error:'Mutation outcome unknown <raw diagnostic>' },
                { status:'running', step:'wait_pdf_access', stepDetail:'Permission needed' },
                { status:'running', step:'wait_artifacts', tasks:[{status:'completed'},{status:'in_progress'}] },
            ]) {
                await evaluate(popup, `chrome.storage.local.set({pipelineState:${JSON.stringify({ ...completedState, ...fixture })}})`);
                await reload(popup);
                const view = await evaluate(popup, `({text:document.getElementById('content').innerText,width:document.documentElement.scrollWidth,
                    error:document.querySelector('.pipeline-error-box')?.textContent,
                    resume:document.getElementById('btn-resume-pdf')?.textContent,
                    detail:document.querySelector('.step-detail')?.textContent})`);
                assert(view.width <= 360, `${locale} ${fixture.step} overflow`);
                if (fixture.status === 'error') assert(view.error === expected('The result could not be confirmed. Check Gemini Notebook before starting again.'), `${locale} unsafe error guidance`);
                if (fixture.step === 'wait_pdf_access') assert(view.resume === expected('Allow Download & Continue'), `${locale} permission action missing`);
                if (fixture.step === 'wait_artifacts') assert(view.text.includes(expected('$1 of $2 artifacts ready.').replace('$1','1').replace('$2','2')), `${locale} progress not translated`);
            }
            report.push({ locale, completedHeight: done.bottom, settingsWidth: settings.width, states: ['completed','settings','error','permission','polling'] });
        } finally { await popup.call('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
    }
    await reload(popup);
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)+'\n');
    console.log(`Localization smoke passed for seven locales: ${JSON.stringify(report)}`);
}
