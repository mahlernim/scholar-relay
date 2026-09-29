import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing, getUsage, addTextSource, addUrlSource, listSources, listArtifactStatuses } from '../notebooklm-api.js';
import { resetRetryMemoryForTesting } from '../retry-policy.js';
let session = 0;
test.beforeEach(() => { __testing.resetTokens(); resetRetryMemoryForTesting(); session++; __testing.setRetrySleep(async()=>{}); });
const response = (body, status=200, headers={}) => ({ok:status===200,status,headers:new Headers(headers),url:'https://notebook.google.com/',text:async()=>body});
const result = (method,value) => response(JSON.stringify([['wrb.fr',method,JSON.stringify(value)]]));
function service(handler) {
    const calls=[];
    globalThis.fetch=async(url,options)=>{
        if(!String(url).includes('batchexecute'))return response(`"SNlM0e":"test","FdrFJe":"usage-test-${session}"`);
        const method=new URL(url).searchParams.get('rpcids');
        const params=JSON.parse(JSON.parse(new URLSearchParams(options.body).get('f.req'))[0][0][1]);
        calls.push({method,params});return handler(method,params,calls.length);
    };return calls;
}
test('disabled accounts skip quota summary and concurrent usage calls share reads',async()=>{
    const calls=service(method=>result(method,[]));
    assert.deepEqual(await Promise.all([getUsage(),getUsage()]),[null,null]);
    assert.deepEqual(calls.map(c=>c.method),['SatQRc']);assert.deepEqual(calls[0].params,[]);
});
test('enabled usage uses null request context, distinguishes skipped and fails closed',async()=>{
    for(const summary of [[2],[3],[1,[]]]){
        __testing.resetTokens();
        const calls=service(method=>result(method,method==='SatQRc'?[null,null,null,null,[null,null,null,null,null,null,true]]:summary));
        assert.equal(await getUsage(),null);assert.deepEqual(calls[1],{method:'EylDcb',params:[null]});
    }
});
test('server cooldown defers another notebook read without sleeping or sending it',async()=>{
    let slept=0;__testing.setRetrySleep(async()=>{slept++;});
    const calls=service(()=>response('',429,{'retry-after':'300'}));
    await assert.rejects(listSources('a',{mode:'poll'}),error=>error.code==='READ_DEFERRED'&&error.retryAfterSeconds===300);
    __testing.resetTokens(); session++; // A refreshed session cannot bypass the wait.
    await assert.rejects(listArtifactStatuses('b',{mode:'poll'}),error=>error.code==='READ_DEFERRED');
    assert.equal(calls.length,1);assert.equal(slept,0);
    assert.equal(await getUsage(),null);assert.equal(calls.length,1);
});
test('uncertain text upload preserves server delay and sends exactly once',async()=>{
    const calls=service(()=>response('',503,{'retry-after':'86400'}));
    await assert.rejects(addTextSource('nb','Article','Body'),error=>error.code==='TRANSIENT_MUTATION_UNCERTAIN'&&error.retryAfterSeconds===86400);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].params[0][0],[null,['Article','Body'],null,2,null,null,null,null,null,null,1]);
});
test('text auth rejection never repeats the mutation',async()=>{
    const calls=service(()=>response('',401));
    await assert.rejects(addTextSource('nb','Article','Body'),error=>error.code==='TRANSIENT_MUTATION_UNCERTAIN');assert.equal(calls.length,1);
});
const url='https://example.org/article';
const row=id=>[[id],url,[null,null,null,null,null,null,null,[url]],[null,3,[null,null,null,null,null,null,[1]]]];
test('code 9 recovery is attributed only to a single new matching diagnostic row',async()=>{
    for(const count of [0,1,2]){
        __testing.resetTokens();let reads=0;
        service(method=>method==='izAoDd'?response(JSON.stringify([['er',method,9]])):
            result(method,[[null,++reads===1?[]:Array.from({length:count},(_,i)=>row('failed-source-'+i))]]));
        await assert.rejects(addUrlSource('nb',url),error=>error.code==='RPC_REJECTED'&&error.rpcCode===9&&
            (count===1?error.pageTextFailure?.sourceId==='failed-source-0':!error.pageTextFailure));
    }
});
test('existing same-URL source and unknown diagnostic cannot enable page recovery',async()=>{
    for(const existing of [true,false]){
        __testing.resetTokens();let reads=0;const failed=row('source-000000');if(!existing)failed[3][2][6][0]=5;
        service(method=>method==='izAoDd'?response(JSON.stringify([['er',method,9]])):
            result(method,[[null,++reads===1&&!existing?[]:[failed]]]));
        await assert.rejects(addUrlSource('nb',url),error=>!error.pageTextFailure);
    }
});
test('cancellation after baseline read prevents URL source mutation',async()=>{
    const calls=service(method=>result(method,[[null,[]]]));
    await assert.rejects(addUrlSource('nb',url,{beforeMutation:()=>{throw Object.assign(new Error('Cancelled'),{code:'PIPELINE_STALE_RUN'});}}),/Cancelled/);
    assert.deepEqual(calls.map(c=>c.method),['rLM1Ne']);
});

test('another newly matching source with a different diagnostic makes recovery ambiguous',async()=>{
    let reads=0; const other=row('source-unknown'); other[3][2][6][0]=5;
    service(method=>method==='izAoDd'?response(JSON.stringify([['er',method,9]])):
        result(method,[[null,++reads===1?[]:[row('source-connection'),other]]]));
    await assert.rejects(addUrlSource('nb',url),error=>!error.pageTextFailure);
});

test('object-shaped diagnostic settings cannot enable recovery',async()=>{
    const malformed=row('source-malformed'); malformed[3][2]={6:[1]};
    service(method=>result(method,[[null,[malformed]]]));
    assert.equal((await listSources('nb'))[0].experimentalFailureCode,undefined);
});

test('a failure usage request waits out an older read and coalesces fresh requests',async()=>{
    let release;
    const calls=service((method,params,count)=>count===1?new Promise(resolve=>{release=()=>resolve(result(method,[]));}):result(method,[]));
    const previous=getUsage();
    while(!release) await new Promise(resolve=>setImmediate(resolve));
    const next=Promise.all([getUsage({after:Date.now()+1}),getUsage({after:Date.now()+1})]);
    release();await previous;await next;
    assert.equal(calls.length,2);
});
