// Server waits and client deadlines are separate. Never clamp a server wait.
export const AUTO_WAIT_MS = 300000;
const MAX_DATE = 8640000000000000;
export function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    let delayMs;
    if (/^\d+$/.test(raw)) delayMs = Number(raw) * 1000;
    else if (/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(raw)) {
        const date = Date.parse(raw);
        if (!Number.isFinite(date)) return null;
        delayMs = Math.max(0, date - now);
    } else return null;
    const representable = Number.isFinite(delayMs) && now + delayMs <= MAX_DATE;
    return { retryAfterSeconds: Number.isFinite(delayMs) ? delayMs / 1000 : null,
        nextEligibleAt: representable ? now + delayMs : MAX_DATE, delayUnknown: !representable };
}

export function createRetryGate({ read, write, now = Date.now }) {
    let tail = Promise.resolve();
    const transact = fn => {
        const apply = async () => {
            const data = await read() || { scopes: {}, operations: {} };
            data.scopes ||= {}; data.operations ||= {};
            const result = fn(data);
            await write(data);
            return result;
        };
        tail = tail.then(apply, apply);
        return tail;
    };
    return {
        async check(scope, options = {}) {
            return transact(data => {
                const time = now();
                // Completed operation records are removed explicitly. Old abandoned
                // records can expire without extending any active job's budget.
                for (const [key, op] of Object.entries(data.operations)) {
                    if (op.deadline + 86400000 < time) delete data.operations[key];
                }
                const id = options.operationId;
                const op = id ? (data.operations[id] ||= { deadline: Math.min(time + AUTO_WAIT_MS, options.deadline ?? Infinity), attempts: 0 })
                    : { deadline: Math.min(time + AUTO_WAIT_MS, options.deadline ?? Infinity), attempts: 0 };
                op.deadline = Math.min(op.deadline, options.deadline ?? Infinity);
                const wait = data.scopes[scope];
                if (wait && wait.nextEligibleAt <= time) delete data.scopes[scope];
                const active = wait?.nextEligibleAt > time ? wait : null;
                if (active || time >= op.deadline || op.attempts >= 3) {
                    return { ...active, deadline: op.deadline, canRetry: !!active && active.nextEligibleAt < op.deadline && op.attempts < 3 };
                }
                if (options.consume && id) op.attempts++;
                return null;
            });
        },
        remember(scope, value) {
            const wait = parseRetryAfter(value, now());
            if (!wait) return Promise.resolve(null);
            return transact(data => {
                if (!data.scopes[scope] || data.scopes[scope].nextEligibleAt < wait.nextEligibleAt) data.scopes[scope] = wait;
                return data.scopes[scope];
            });
        },
        finish(operationId) { return operationId ? transact(data => { delete data.operations[operationId]; }) : Promise.resolve(); },
    };
}

let memory = null;
export function resetRetryMemoryForTesting() { memory = null; }
export const retryGate = createRetryGate({
    read: async () => globalThis.chrome?.storage?.local
        ? (await chrome.storage.local.get('rpcRetryState')).rpcRetryState : memory,
    write: async value => {
        if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ rpcRetryState: value });
        else memory = value;
    },
});
export function retryWaitError(wait, mode = 'setup') {
    return Object.assign(new Error('Server requested a wait before another read.'), {
        code: mode === 'poll' || wait.canRetry ? 'READ_DEFERRED' : 'RETRY_WAIT_REQUIRED',
        ...wait, replaySafe: true,
    });
}
