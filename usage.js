export const USAGE_ACTIONS = Object.freeze({ audio: 1, video: 2, infographic: 5,
    slide_deck: 6, report: 7, data_table: 8, flashcards: 9, quiz: 10, mind_map: 11 });
const array = value => Array.isArray(value) ? value : [];
export function meterEnabled(raw) {
    for (const account of [raw, array(raw)[0], array(array(raw)[0])[0]]) {
        const bit = array(array(account)[4])[6];
        if (typeof bit === 'boolean') return bit;
    }
    return false;
}
export function decodeUsage(raw, now = Date.now()) {
    const invalid = () => { throw new Error('Malformed usage response'); };
    if (!Array.isArray(raw)) return invalid();
    if (raw[0] === 2) return null;
    if (raw[0] !== 1 || !Array.isArray(raw[1]) || raw[1].length !== 2) return invalid();
    const windows = raw[1].map(row => {
        if (!Array.isArray(row) || ![1, 2].includes(row[4])) return invalid();
        const stamp = row[5];
        if (!Array.isArray(stamp) || !Number.isSafeInteger(stamp[0]) || !Number.isInteger(stamp[1] ?? 0) ||
            (stamp[1] ?? 0) < 0 || (stamp[1] ?? 0) >= 1e9) return invalid();
        const resetsAt = stamp[0] * 1000 + (stamp[1] ?? 0) / 1e6;
        if (!Number.isFinite(new Date(resetsAt).getTime())) return invalid();
        let used = row[6], remaining = row[7];
        if (used == null && remaining == null) return invalid();
        if ([used, remaining].some(x => x != null && (typeof x !== 'number' || !Number.isFinite(x)))) return invalid();
        if (used == null) used = 100 - remaining;
        if (remaining == null) remaining = 100 - used;
        return { code: row[4], resetsAt, used, remaining };
    });
    if (new Set(windows.map(w => w.code)).size !== 2) return invalid();
    if (raw[3] != null && !Array.isArray(raw[3])) return invalid();
    const actions = array(raw[3]).map(row => {
        if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] <= 0 ||
            (row[1] != null && typeof row[1] !== 'boolean')) return invalid();
        return { code: row[0], sufficient: row[1] ?? false };
    });
    if (new Set(actions.map(a => a.code)).size !== actions.length) return invalid();
    return { capturedAt: now, expiresAt: Math.min(...windows.map(w => w.resetsAt)), windows, actions };
}
export function activeUsage(snapshot, now = Date.now()) {
    if (!snapshot || !Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now) return null;
    const weekly = snapshot.windows?.find(w => w.code === 2);
    return weekly?.used >= 100 ? weekly : snapshot.windows?.find(w => w.code === 1) || null;
}
export function actionLimited(snapshot, type, now = Date.now()) {
    return !!activeUsage(snapshot, now) && snapshot.actions?.some(a => a.code === USAGE_ACTIONS[type] && a.sufficient === false);
}
export function formatReset(at, locale, now = Date.now(), full = false) {
    const date = new Date(at), today = new Date(now);
    const sameDay = date.toDateString() === today.toDateString();
    return new Intl.DateTimeFormat(locale?.replace('_', '-') || undefined, {
        hour: 'numeric', minute: '2-digit', ...(!sameDay || full ? { month: 'short', day: 'numeric' } : {}),
    }).format(date);
}
