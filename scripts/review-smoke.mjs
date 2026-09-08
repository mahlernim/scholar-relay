// Focused regressions against the real popup, using only the existing fixture bridge.
export async function recoverySmoke({ popup, evaluate, reload, completedState }) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const failed = { ...completedState, runId: 'notification-job', status: 'error', step: 'error',
        failedStep: 'add_source', error: 'Source rejected by the service.' };
    await evaluate(popup, `globalThis.__smoke.setFixtureState(${JSON.stringify(failed)})`);
    const { identifier } = await popup.call('Page.addScriptToEvaluateOnNewDocument', {
        source: `history.replaceState(null, '', location.pathname + '?runId=notification-job');`,
    });
    try {
        await reload(popup);
        const view = await evaluate(popup, `({stage:document.querySelector('.step-indicator.error')?.closest('.pipeline-step')?.innerText,
            selected:document.getElementById('content').innerText,width:document.documentElement.scrollWidth})`);
        assert(view.stage?.includes('Add Source'), 'Error notification route lost the failed stage');
        assert(view.selected.includes('Source rejected') || view.selected.includes('needs attention'), 'Notification did not select its job');
        assert(view.width <= 360, 'Error detail route overflowed');
    } finally {
        await popup.call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        await evaluate(popup, `history.replaceState(null, '', location.pathname)`);
    }

    const held = { version: 1, paused: true, serviceBlock: { id: 'held-connection', code: 'SESSION_UNAVAILABLE',
        message: 'SESSION_UNAVAILABLE: The service is unavailable.' }, jobs: [{ ...completedState,
        runId: 'held-job', status: 'queued', step: 'queued', notebookId: null, notebookUrl: null, tasks: [] }] };
    await evaluate(popup, `chrome.storage.local.set({jobQueue:${JSON.stringify(held)}})`);
    await reload(popup);
    const before = await evaluate(popup, `({retry:document.getElementById('btn-retry-connection')?.textContent,
        hint:document.querySelector('.job-hint')?.textContent,width:document.documentElement.scrollWidth})`);
    assert(before.retry === 'Try connection' && before.hint?.includes('paper is saved'), 'Connection hold is not actionable');
    assert(before.width <= 360, 'Connection hold overflowed');
    await evaluate(popup, `document.getElementById('btn-retry-connection').click()`);
    let queue;
    for (let i = 0; i < 50; i++) {
        queue = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_QUEUE'})`);
        if (!queue.serviceBlock) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(!queue.serviceBlock && queue.paused && queue.jobs[0].status === 'queued', 'Connection resume changed the user pause or started work');
    console.log('Recovery popup smoke passed: job deep link, failed stage, connection hold and independent pause');
}

export async function compactProgressSmoke({ popup, evaluate, reload, root, origin }) {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { messageKey } = await import('../i18n.js');
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const fixedNow = Date.now();
    const started = new Date(fixedNow - 65000).toISOString();
    const tasks = [{ type: 'audio', status: 'completed' }, { type: 'video', status: 'in_progress' }];
    const jobs = [
        { runId: 'clock-queued', sourceTitle: 'Queued paper', status: 'queued', step: 'queued', queuedAt: started },
        { runId: 'clock-running', sourceTitle: 'Generating paper', status: 'running', step: 'wait_artifacts', startedAt: started,
            stepStartedAt: new Date(fixedNow).toISOString(), tasks, settings: { notificationEnabled: false } },
        { runId: 'clock-stopped', sourceTitle: 'Stopped paper', status: 'stopped', step: 'wait_artifacts', startedAt: started,
            completedAt: new Date(fixedNow - 5000).toISOString(), tasks },
    ];
    await evaluate(popup, `chrome.tabs.create({url:${JSON.stringify(origin + '/plain')},active:true})`);
    for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt_BR']) {
        const catalog = JSON.parse(await readFile(join(root, '_locales', locale, 'messages.json'), 'utf8'));
        const countText = catalog[messageKey('$1/$2 ready')].message.replace('$1', '1').replace('$2', '2');
        const { identifier } = await popup.call('Page.addScriptToEvaluateOnNewDocument', { source: `
            const catalog=${JSON.stringify(catalog)};
            chrome.i18n.getUILanguage=()=>${JSON.stringify(locale.replace('_', '-'))};
            chrome.i18n.getMessage=(key, values=[])=>catalog[key]?.message.replace(/\\$(\\d+)/g,(_,i)=>values[i-1]??'')||'';
            globalThis.__clockNow=${fixedNow}; Date.now=()=>globalThis.__clockNow;
        ` });
        try {
            await evaluate(popup, `chrome.storage.local.set({jobQueue:${JSON.stringify({ version: 1, paused: true, jobs })}})`);
            await reload(popup);
            const view = await evaluate(popup, `(() => {
                document.getElementById('finished-jobs').open=true;
                const phases=[...document.querySelectorAll('.job-phase')];
                return {width:document.documentElement.scrollWidth,noPdfHeight:document.querySelector('.no-pdf')?.getBoundingClientRect().height,
                    icon:!!document.querySelector('.no-pdf .icon'),actions:!!document.getElementById('btn-start-url')&&!!document.getElementById('btn-upload-manual'),
                    count:document.querySelector('[data-job="clock-running"] .job-ready-count')?.textContent,
                    clocks:[...document.querySelectorAll('[data-elapsed]')].map(el=>el.textContent),
                    phasesFit:phases.every(el=>el.scrollWidth<=el.clientWidth+1 && el.getBoundingClientRect().height<20),
                    active:[...document.querySelectorAll('.job-activity.is-active')].map(el=>el.closest('[data-job]').dataset.job)};
            })()`);
            assert(view.width <= 360 && view.phasesFit, `${locale} compact phase overflow`);
            assert(view.noPdfHeight > 0 && view.noPdfHeight < 85 && !view.icon && view.actions, `${locale} no-PDF state is not compact or lost its actions`);
            assert(view.count === countText, `${locale} artifact count not localized`);
            assert(JSON.stringify(view.clocks) === JSON.stringify(['01:05', '01:05', '01:00']), `${locale} persisted clocks are wrong`);
            assert(JSON.stringify(view.active) === JSON.stringify(['clock-running']), `${locale} inactive job animation`);
            if (locale === 'en') {
                await evaluate(popup, `(() => {
                    globalThis.__clockNode=document.querySelector('[data-elapsed="clock-queued"]');
                    globalThis.__clockButton=document.querySelector('[data-show="clock-queued"]'); __clockButton.focus();
                    globalThis.__clockHeight=__clockNode.closest('.job-card').getBoundingClientRect().height;
                    globalThis.__clockNow+=2000;
                })()`);
                await new Promise(resolve => setTimeout(resolve, 2200));
                assert(await evaluate(popup, `__clockNode===document.querySelector('[data-elapsed="clock-queued"]') &&
                    __clockNode.textContent==='01:07' && document.activeElement===__clockButton &&
                    __clockNode.closest('.job-card').getBoundingClientRect().height===__clockHeight &&
                    document.getElementById('finished-jobs').open && document.querySelector('[data-elapsed="clock-stopped"]').textContent==='01:00' &&
                    __clockNode.getAttribute('aria-live')==='off'`), 'Timer tick rebuilt markup, lost focus or expanded history, changed height, or advanced a stopped clock');
                await popup.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
                assert(await evaluate(popup, `getComputedStyle(document.querySelector('.job-activity.is-active')).animationName==='none'`), 'Reduced motion still animates');
                await popup.call('Emulation.setEmulatedMedia', { features: [] });
            }
        } finally { await popup.call('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
    }
    await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'idle'})`);
    await reload(popup);
    console.log('Compact progress smoke passed in seven locales: timers, counts, stable focus and height, reduced motion and no-PDF actions');
}
