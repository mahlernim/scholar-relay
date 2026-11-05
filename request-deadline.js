// Bound reads and pre-response uploads so one stalled connection cannot hold
// the queue indefinitely. Accepted mutation bodies use their separate policy.
export async function withRequestDeadline(operation, timeoutMs = 15000) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => operation(controller.signal)),
            new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('The network request timed out.'));
                }, timeoutMs);
            }),
        ]);
    } finally { clearTimeout(timer); }
}

export async function withStallDeadline(operation, { idleMs, maxMs, watch = null, watchMs = 5000 }) {
    const controller = new AbortController();
    let idleTimer, maxTimer, watchTimer, fail, settled = false;
    const stopped = new Promise((_, reject) => { fail = reject; });
    const stop = message => {
        if (settled) return;
        settled = true;
        controller.abort();
        fail(new Error(message));
    };
    const touch = () => {
        if (settled) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop('The network request stalled.'), idleMs);
    };
    touch();
    maxTimer = setTimeout(() => stop('The network request timed out.'), maxMs);
    if (watch) {
        watchTimer = setInterval(() => {
            Promise.resolve().then(watch).then(reason => { if (reason) stop(reason); }, () => {});
        }, watchMs);
    }
    try {
        return await Promise.race([Promise.resolve().then(() => operation(controller.signal, touch)), stopped]);
    } finally {
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearInterval(watchTimer);
    }
}
