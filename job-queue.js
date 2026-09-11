export const MAX_QUEUED_JOBS = 20;
export const MAX_GENERATING_JOBS = 3;
export const MAX_HISTORY_JOBS = 50;
export const MAX_QUEUED_PDF_BYTES = 100 * 1024 * 1024;

export const isUnfinishedJob = job => ['queued', 'running', 'stopping'].includes(job.status);
export const isPreparingJob = job => job.status === 'running' &&
    !['wait_artifacts', 'wait_pdf_access', 'queued_pdf'].includes(job.step);

export function canStartNextJob(queue) {
    return !queue.paused && !queue.serviceBlock && !queue.jobs.some(isPreparingJob) &&
        queue.jobs.filter(job => job.status === 'running' && job.step === 'wait_artifacts').length < MAX_GENERATING_JOBS;
}

export function jobHandoff(job) {
    if (job.status === 'queued' || job.step === 'queued_pdf') return 'saved';
    if (job.status === 'completed') return job.tasks?.some(task => task.status !== 'completed') ? 'check' : 'ready';
    if (job.status === 'error' || job.step === 'wait_pdf_access') return 'attention';
    if (job.step === 'wait_artifacts' && job.tasks?.length &&
        job.tasks.every(task => task.taskId && ['in_progress', 'completed'].includes(task.status))) return 'accepted';
    if (job.step === 'wait_artifacts' || job.status === 'stopped') return 'check';
    return 'preparing';
}

// Presentation helpers read persisted timestamps. They never poll or write state.
export function jobElapsedText(job, now = Date.now()) {
    const waiting = job.status === 'running' && job.step === 'wait_pdf_access';
    const start = Date.parse(waiting ? job.attentionSince : job.status === 'queued' ? job.queuedAt : job.startedAt || job.queuedAt);
    const end = isUnfinishedJob(job) ? now : Date.parse(job.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    const seconds = Math.floor(Math.max(0, end - start) / 1000);
    const pad = value => String(value).padStart(2, '0');
    if (seconds < 3600) return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
    return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export function jobReadyCount(job) {
    // During submission, tasks contains only requests attempted so far.
    if (!['wait_artifacts', 'done'].includes(job.failedStep || job.step) || !job.tasks?.length) return null;
    return { ready: job.tasks.filter(task => task.status === 'completed').length, total: job.tasks.length };
}

export function hasJobActivity(job) {
    return job.status === 'running' && !['wait_pdf_access', 'queued_pdf'].includes(job.step);
}

// One serialized writer for the whole queue. A late callback may update only
// its own running job, with the same step checks used by the original pipeline.
export function createJobQueue({ read, write }) {
    let tail = Promise.resolve();
    function transact(operation) {
        const apply = async () => {
            const queue = await read();
            const result = await operation(queue);
            if (!result) return { applied: false };
            const finished = queue.jobs.filter(job => !isUnfinishedJob(job));
            const obsolete = new Set(finished.filter(job => !['unknown', 'deleting'].includes(job.cleanupStatus)).slice(0, Math.max(0, finished.length - MAX_HISTORY_JOBS)));
            queue.jobs = queue.jobs.filter(job => !obsolete.has(job));
            await write(queue);
            let effectError = null;
            try { await result.afterWrite?.(); } catch (error) { effectError = error; }
            return { applied: true, ...result, effectError };
        };
        tail = tail.then(apply, apply);
        return tail;
    }
    return {
        transact,
        transition(runId, updates, { expectedSteps, condition, afterWrite } = {}) {
            return transact(queue => {
                const job = queue.jobs.find(item => item.runId === runId);
                if (job?.status !== 'running' || (expectedSteps && !expectedSteps.includes(job.step)) ||
                    (condition && !condition(job))) return null;
                Object.assign(job, typeof updates === 'function' ? updates(job) : updates);
                return { state: job, afterWrite };
            });
        },
    };
}
