import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messageKey } from '../i18n.js';

// Controlled queue fixtures verify presentation without making remote requests.
export async function queueStatusSmoke({ popup, evaluate, reload, root }) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const out = join(root, 'dist', 'queue-status-qa');
    await mkdir(out, { recursive: true });
    const now = Date.now();
    const base = { sourceTitle: 'Queue status check', startedAt: new Date(now - 65000).toISOString(),
        stepStartedAt: new Date(now).toISOString(), settings: { notificationEnabled: false } };
    const active = { type: 'audio', taskId: 'known-audio', status: 'in_progress' };
    const uncertain = { type: 'video', taskId: null, status: 'uncertain' };
    const completed = { type: 'audio', taskId: 'ready-audio', status: 'completed' };
    const failed = { type: 'video', taskId: null, status: 'failed' };
    const fixtures = [
        { ...base, runId: 'status-mixed', status: 'running', step: 'wait_artifacts', tasks: [active, uncertain] },
        { ...base, runId: 'status-uncertain', status: 'running', step: 'wait_artifacts', tasks: [{ ...uncertain, type: 'audio' }, uncertain] },
        { ...base, runId: 'status-failed', status: 'completed', step: 'done', tasks: [completed, failed], completedAt: new Date(now).toISOString() },
    ];
    const unknownHint = 'Some requests may still be running in Gemini Notebook. Check this notebook for the result.';
    const failedHint = 'Some requests failed. Check this notebook for details.';
    const results = [];
    for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt_BR', 'zh_CN', 'it', 'zh_TW', 'hi']) {
        const catalog = JSON.parse(await readFile(join(root, '_locales', locale, 'messages.json'), 'utf8'));
        const expected = (source, values = []) => catalog[messageKey(source)].message.replace(/\$(\d+)/g, (_, i) => values[i - 1] ?? '');
        const { identifier } = await popup.call('Page.addScriptToEvaluateOnNewDocument', { source: `
            const catalog=${JSON.stringify(catalog)};
            chrome.i18n.getUILanguage=()=>${JSON.stringify(locale.replace('_', '-'))};
            chrome.i18n.getMessage=(key,values=[])=>catalog[key]?.message.replace(/\\$(\\d+)/g,(_,i)=>values[i-1]??'')||'';
        ` });
        try {
            for (const width of [320, 360]) {
                await popup.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
                const seeded = await evaluate(popup, `chrome.runtime.sendMessage({type:'SMOKE_SET_QUEUE',queue:${JSON.stringify({ version: 1, paused: true, jobs: fixtures })}})`);
                assert(seeded?.ok, `${locale} status queue fixture was not committed`);
                await reload(popup);
                const view = await evaluate(popup, `(async () => {
                    await globalThis.__smoke.refreshQueue();
                    document.getElementById('finished-jobs').open=true;
                    return { width:document.documentElement.scrollWidth, cards:[...document.querySelectorAll('[data-job]')].map(card=>({
                        id:card.dataset.job, phase:card.querySelector('.job-phase-label').textContent,
                        count:card.querySelector('.job-ready-count')?.textContent,
                        hint:card.querySelector('.job-hint').textContent,
                        active:!!card.querySelector('.job-activity.is-active'),
                        phaseFits:card.querySelector('.job-phase').scrollWidth<=card.querySelector('.job-phase').clientWidth+1,
                        labelFits:card.querySelector('.job-phase-label').scrollWidth<=card.querySelector('.job-phase-label').clientWidth+1,
                        hintFits:card.querySelector('.job-hint').scrollWidth<=card.querySelector('.job-hint').clientWidth+1
                    }))};
                })()`);
                assert(view.width <= width, `${locale} ${width}px status queue overflow`);
                assert(view.cards.length === fixtures.length, `${locale} status queue lost a job`);
                for (const card of view.cards) {
                    const mixed = card.id === 'status-mixed';
                    const failedOnly = card.id === 'status-failed';
                    assert(card.phase === expected(mixed ? 'Generating' : 'Needs checking'), `${locale} ${card.id} phase contradicts the task outcomes`);
                    assert(card.active === mixed, `${locale} ${card.id} activity contradicts the task outcomes`);
                    assert(card.hint === expected(failedOnly ? failedHint : unknownHint), `${locale} ${card.id} handoff hint contradicts the task outcomes`);
                    assert(card.count === expected('$1/$2 ready', [failedOnly ? 1 : 0, 2]), `${locale} ${card.id} lost the ready count`);
                    assert(card.phaseFits && card.labelFits && card.hintFits, `${locale} ${width}px ${card.id} status text is clipped`);
                }
                results.push({ locale, width, ...view });
                await evaluate(popup, `document.getElementById('job-queue').scrollIntoView({block:'start'})`);
                await popup.call('Page.bringToFront');
                const screenshot = await popup.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                await writeFile(join(out, `${locale}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
            }
            if (locale === 'en') {
                const priorityJobs = [
                    { ...fixtures[2], runId: 'status-limit', tasks: [completed, { ...failed, code: 'RATE_LIMITED' }], nextEligibleAt: now + 3600000 },
                    { ...fixtures[2], runId: 'status-retry', nextEligibleAt: now + 3600000 },
                    { ...fixtures[2], runId: 'status-ready', tasks: [completed] },
                    { ...fixtures[2], runId: 'status-source', tasks: [] },
                ];
                await evaluate(popup, `chrome.runtime.sendMessage({type:'SMOKE_SET_QUEUE',queue:${JSON.stringify({ version: 1, paused: true, jobs: priorityJobs })}})`);
                await reload(popup);
                const priority = await evaluate(popup, `(async () => {
                    await globalThis.__smoke.refreshQueue();
                    return Object.fromEntries([...document.querySelectorAll('[data-job]')].map(card=>[card.dataset.job,{
                        phase:card.querySelector('.job-phase-label').textContent,hint:card.querySelector('.job-hint').textContent,
                        active:!!card.querySelector('.job-activity.is-active'),count:card.querySelector('.job-ready-count')?.textContent
                    }]));
                })()`);
                assert(priority['status-limit'].hint.startsWith('Generation is limited for '), 'Generation-limit hint lost priority over retry and failure hints');
                assert(priority['status-retry'].hint.startsWith('Server wait until '), 'Server wait lost priority over the failure hint');
                assert(priority['status-ready'].phase === 'Ready' && !priority['status-ready'].active && priority['status-ready'].count === '1/1 ready', 'Complete result lost Ready or still animates');
                assert(priority['status-source'].phase === 'Ready' && !priority['status-source'].count && priority['status-source'].hint === 'Source imported. No artifacts requested.', 'Source-only completion claims artifact generation');
            }
        } finally {
            await popup.call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        }
    }
    await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'idle'})`);
    await popup.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
    await reload(popup);
    console.log('Queue status smoke passed in eleven locales at 320/360 px with consistent phases, hints, activity, ready counts and hint priority.');
}
