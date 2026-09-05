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
