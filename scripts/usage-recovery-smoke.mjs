import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messageKey } from '../i18n.js';
import { extractPageText } from '../page-text.js';

export async function usageRecoverySmoke({ popup, evaluate, reload, root, origin }) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const now = Date.now();
    const usage = {capturedAt:now,expiresAt:now+3600000,windows:[{code:1,used:32,remaining:68,resetsAt:now+3600000},
        {code:2,used:100,remaining:0,resetsAt:now+604800000}],actions:[{code:1,sufficient:false},{code:2,sufficient:true}]};
    const job = {runId:'page-text-smoke',status:'error',step:'error',failedStep:'add_source',sourceTitle:'Paper',sourceType:'webpage',pageTabId:7,
        notebookId:'nb',notebookUrl:origin+'/notebook/nb',pdfUrl:origin+'/article',pageUrl:origin+'/article',importMethod:'url',
        error:'RPC_REJECTED',pageTextFailure:{rpcCode:9,diagnostic:1,sourceId:'failed-source',url:origin+'/article'},tasks:[]};
    const out=join(root,'dist','usage-recovery-qa'); await mkdir(out,{recursive:true});
    for (const locale of ['en','ko','ja','es','fr','de','pt_BR','zh_CN','it','zh_TW']) {
        const catalog=JSON.parse(await readFile(join(root,'_locales',locale,'messages.json'),'utf8'));
        const expected=source=>catalog[messageKey(source)].message;
        const {identifier}=await popup.call('Page.addScriptToEvaluateOnNewDocument',{source:`
            const catalog=${JSON.stringify(catalog)};
            chrome.i18n.getUILanguage=()=>${JSON.stringify(locale.replace('_','-'))};
            chrome.i18n.getMessage=(key,values=[])=>catalog[key]?.message.replace(/\\$(\\d+)/g,(_,i)=>values[i-1]??'')||'';
            const send=chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage=message=>message.type==='GET_USAGE'?Promise.resolve({usage:${JSON.stringify(usage)}}):send(message);
        `});
        try {
            for(const width of [320,360]) {
                await popup.call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
                await evaluate(popup,`globalThis.__smoke.setFixtureState(${JSON.stringify(job)})`);
                await reload(popup);
                await evaluate(popup,`document.getElementById('finished-jobs').open=true;document.querySelector('[data-page-text]').click()`);
                let view;
                for(let i=0;i<30;i++) {
                    view=await evaluate(popup,`({consent:document.querySelector('[data-page-text-confirm]')?.parentElement.textContent,width:document.documentElement.scrollWidth,usage:document.querySelector('.subtitle').textContent})`);
                    if(view.consent)break;
                    await new Promise(r=>setTimeout(r,20));
                }
                assert(view.consent?.includes(expected('Sends tab text to Google as a text source. May include sign-in-only content.')),locale+' consent missing');
                assert(view.width<=width,locale+' consent overflow '+view.width+'/'+width);
                assert(view.usage.includes('100'),locale+' weekly meter not selected');
                if(width===320) {
                    await popup.call('Page.bringToFront');
                    const screen=await popup.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
                    await writeFile(join(out,locale+'-consent.png'),Buffer.from(screen.data,'base64'));
                }
                await evaluate(popup,`document.querySelector('[data-page-text-back]').click();document.getElementById('btn-gear').click()`);
                const label=await evaluate(popup,`({text:document.querySelector('#sec-audio .s-section-title').textContent,disabled:document.getElementById('s-generateAudio').disabled,width:document.documentElement.scrollWidth})`);
                assert(label.text.includes(expected('Limit'))&&!label.disabled,locale+' quota hint blocks or is absent');
                assert(label.width<=width,locale+' settings overflow');
            }
        } finally { await popup.call('Page.removeScriptToEvaluateOnNewDocument',{identifier}); }
    }
    const fixtureTab=await evaluate(popup, `chrome.tabs.create({url:${JSON.stringify(origin+'/plain')},active:false})`);
    try {
        await new Promise(r=>setTimeout(r,250));
        const checks=await evaluate(popup, `chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{
            const extract=${extractPageText.toString()};
            document.body.innerHTML='<article><h1>Paper</h1><p>'+('Useful article text. '.repeat(40))+'</p><form>FORM_SECRET</form><p hidden>HIDDEN_SECRET</p><p style="display:none">CSS_SECRET</p><iframe></iframe></article>';
            const good=extract(location.href);const clean=!/FORM_SECRET|HIDDEN_SECRET|CSS_SECRET/.test(good.content);
            let changed=false,huge=false,challenge=false,missing=false;
            try{extract(location.href+'?changed')}catch{changed=true;}
            document.querySelector('article').textContent='가'.repeat(70000);try{extract(location.href)}catch{huge=true;}
            document.title='Verify you are human';document.querySelector('article').textContent='Article '.repeat(100);try{extract(location.href)}catch{challenge=true;}
            document.body.textContent='No article';try{extract(location.href)}catch{missing=true;}
            return {clean,changed,huge,challenge,missing,provenance:good.content.includes('Captured ')};
        }})`);
        assert(Object.values(checks[0].result).every(Boolean),'Article extraction safety failed');
    } finally { await evaluate(popup,`chrome.tabs.remove(${fixtureTab.id})`); }
    await popup.call('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:false});
    console.log('Usage and page-text consent smoke passed in ten locales at 320/360 px.');
}
