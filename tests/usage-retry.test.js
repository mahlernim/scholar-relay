import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryGate, parseRetryAfter, AUTO_WAIT_MS } from '../retry-policy.js';
import { meterEnabled, decodeUsage, activeUsage, actionLimited, formatReset } from '../usage.js';
import { canRecoverPageText } from '../page-text.js';

const now = Date.parse('2026-09-29T00:00:00Z');
const windowRow = (code, used, remaining, offset = 3600000) => [null, null, null, null, code, [(now + offset) / 1000], used, remaining];
const raw = () => [1, [windowRow(2, 10, 90, 604800000), windowRow(1, 30, 70)], null, [[1, false], [2, true], [99, false]]];
test('usage accepts direct and wrapped eligibility and never coerces malformed bits', () => {
    const account = [null, null, null, null, [null, null, null, null, null, null, true]];
    for (const value of [account, [account], [[account]]]) assert.equal(meterEnabled(value), true);
    for (const value of [null, [], [null, null, null, null, [null, null, null, null, null, null, 1]]]) assert.equal(meterEnabled(value), false);
});
test('usage selects by window code, retains unknown actions and explicit mapping', () => {
    const snapshot = decodeUsage(raw(), now);
    assert.equal(activeUsage(snapshot, now).code, 1);
    assert.equal(actionLimited(snapshot, 'audio', now), true);
    assert.equal(actionLimited(snapshot, 'video', now), false);
    assert.equal(actionLimited(snapshot, 'slide_deck', now), false);
    snapshot.actions.push({code:6,sufficient:false});
    assert.equal(actionLimited(snapshot, 'slide_deck', now), true);
    snapshot.windows.find(w => w.code === 2).used = 100.1;
    assert.equal(activeUsage(snapshot, now).code, 2);
    assert.equal(activeUsage(snapshot, now + 3600000), null);
    assert.equal(actionLimited(snapshot, 'audio', now + 3600000), false);
});
test('elided zero percentages derive only from the present finite counterpart', () => {
    const data = raw(); data[1][0][6] = null; data[1][0][7] = 100;
    data[1][1][6] = 100; data[1][1][7] = null;
    const snapshot = decodeUsage(data, now);
    assert.equal(snapshot.windows[0].used, 0); assert.equal(snapshot.windows[1].remaining, 0);
    data[1][1][6] = 35; data[1][1][7] = 60;
    assert.equal(decodeUsage(data, now).windows[1].remaining, 60);
});
test('skipped and schema failures do not become empty usage', () => {
    assert.equal(decodeUsage([2]), null);
    const mutations = [d=>d[0]=3,d=>d[0]=0,d=>d[1].pop(),d=>d[1][1][4]=2,
        d=>d[1][1][4]=99,d=>d[1][1][6]=Infinity,d=>d[1][1][6]=true,
        d=>{d[1][1][6]=null;d[1][1][7]=null;},d=>d[1][1][5]=[1,-1],
        d=>d[3][0][1]=1,d=>d[3].push([1,true])];
    for (const mutate of mutations) { const data=raw();mutate(data);assert.throws(()=>decodeUsage(data,now)); }
    const data=raw();data[3][0]=[1];assert.equal(decodeUsage(data,now).actions[0].sufficient,false);
});
test('non-today reset labels include a date across all interface locales', () => {
    for (const locale of ['en','ko','ja','es','fr','de','pt_BR','zh_CN','it','zh_TW']) {
        assert.notEqual(formatReset(now+3600000,locale,now), formatReset(now+604800000+3600000,locale,now));
    }
});
test('Retry-After preserves zero, dates and long waits without clamping', () => {
    for (const seconds of [0,300,86400]) assert.equal(parseRetryAfter(String(seconds),now).nextEligibleAt,now+seconds*1000);
    assert.equal(parseRetryAfter(new Date(now-1000).toUTCString(),now).nextEligibleAt,now);
    assert.equal(parseRetryAfter(new Date(now+86400000*21).toUTCString(),now).nextEligibleAt,now+86400000*21);
    assert.ok(parseRetryAfter('9'.repeat(400),now).nextEligibleAt>now+AUTO_WAIT_MS);
    for (const value of [null,'','-1','1.5','1e2','tomorrow','NaN']) assert.equal(parseRetryAfter(value,now),null);
});
test('cooldown spans jobs and worker reloads but keeps scope and original budget', async () => {
    let time=now, data;
    const options={read:async()=>structuredClone(data),write:async v=>{data=structuredClone(v);},now:()=>time};
    let gate=createRetryGate(options);
    assert.equal(await gate.check('account-a',{operationId:'job-a',consume:true}),null);
    await gate.remember('account-a','200');
    let wait=await gate.check('account-a',{operationId:'job-b'});
    assert.equal(wait.nextEligibleAt,now+200000);assert.equal(wait.canRetry,true);
    assert.equal(await gate.check('account-b'),null);
    time+=100000;gate=createRetryGate(options);
    await gate.remember('account-a','250');
    wait=await gate.check('account-a',{operationId:'job-a'});
    assert.equal(wait.deadline,now+300000);assert.equal(wait.nextEligibleAt,now+350000);assert.equal(wait.canRetry,false);
    await gate.remember('account-a','1');
    assert.equal((await gate.check('account-a')).nextEligibleAt,now+350000);
});
test('stage deadline and attempt limit survive reload and successful finish clears only the operation', async () => {
    let data;const options={read:async()=>structuredClone(data),write:async v=>{data=structuredClone(v);},now:()=>now};
    let gate=createRetryGate(options);
    await gate.check('x',{operationId:'short',deadline:now+1000});await gate.remember('x','2');
    assert.equal((await gate.check('x',{operationId:'short'})).canRetry,false);
    for(let i=0;i<3;i++)assert.equal(await gate.check('y',{operationId:'attempts',consume:true}),null);
    gate=createRetryGate(options);assert.equal((await gate.check('y',{operationId:'attempts'})).canRetry,false);
    await gate.finish('short');assert.ok((await gate.check('x')).nextEligibleAt);
});
test('page text eligibility excludes uncertain, claimed, deleted and non-page cases', () => {
    const job={status:'error',notebookId:'nb',sourceType:'webpage',pageTabId:7,importMethod:'url',pdfUrl:'https://example.org/a',pageUrl:'https://example.org/a',
        pageTextFailure:{sourceId:'source',url:'https://example.org/a',rpcCode:9,diagnostic:1}};
    assert.equal(canRecoverPageText(job),true);
    for(const update of [{pageTextClaimed:true},{status:'running'},{notebookDeletedAt:'now'},{cleanupStatus:'unknown'}, {pageTabId:null},{sourceType:'pdf'},
        {pageUrl:'https://example.org/b'},{pageTextFailure:{...job.pageTextFailure,diagnostic:2}},
        {pageTextFailure:{...job.pageTextFailure,rpcCode:8}}])assert.equal(canRecoverPageText({...job,...update}),false);
});
