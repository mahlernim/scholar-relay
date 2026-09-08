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
