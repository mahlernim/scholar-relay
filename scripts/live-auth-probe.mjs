// Opt-in GET-only auth qualification with an isolated profile and real MV3 permissions.
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (!process.argv.includes('--live')) {
    console.error('Use --live to make read-only requests to the Notebook app in a fresh Chrome profile.');
    process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'dist'), { recursive: true });
const runRoot = await mkdtemp(join(root, 'dist', 'live-auth-'));
const extensionRoot = join(runRoot, 'extension');
const profileRoot = join(runRoot, 'profile');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const expectedCode = process.argv.find(arg => arg.startsWith('--expect-code='))?.slice('--expect-code='.length) || 'SESSION_UNRECOGNIZED';
if (!['AUTH_REQUIRED', 'SESSION_UNRECOGNIZED'].includes(expectedCode)) throw new Error('Unsupported expected classification.');

async function chromeExecutable() {
    const candidates = [process.env.CHROME_PATH];
    if (process.env.LOCALAPPDATA) {
        const browserRoot = join(process.env.LOCALAPPDATA, 'ms-playwright');
        const installs = (await readdir(browserRoot, { withFileTypes: true }).catch(() => []))
            .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        for (const entry of installs) {
            if (entry.isDirectory() && /^chromium-\d+$/.test(entry.name)) candidates.push(join(browserRoot, entry.name, 'chrome-win64', 'chrome.exe'));
        }
    }
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    for (const candidate of candidates.filter(Boolean)) {
        try { await access(candidate); return candidate; } catch {}
    }
    throw new Error('Chrome was not found. Set CHROME_PATH.');
}

function safeLocation(value) {
    try {
        const url = new URL(value);
        const path = url.hostname === 'accounts.google.com' &&
            !/^\/(?:ServiceLogin|AccountChooser|CookieMismatch|(?:v\d+\/)?signin(?:\/[^/]+)?|)$/.test(url.pathname)
            ? '/<redacted>' : url.pathname;
        return { host: url.hostname, path };
    } catch { return { host: null, path: null }; }
}

class PipeConnection {
    constructor(readable, writable) {
        this.readable = readable;
        this.writable = writable;
        this.pending = new Map();
        this.nextId = 1;
        this.buffer = Buffer.alloc(0);
        this.events = [];
        readable.on('data', chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            for (let end; (end = this.buffer.indexOf(0)) !== -1;) {
                const packet = this.buffer.subarray(0, end);
                this.buffer = this.buffer.subarray(end + 1);
                if (!packet.length) continue;
                const message = JSON.parse(packet.toString('utf8'));
                const pending = this.pending.get(message.id);
                if (pending) {
                    this.pending.delete(message.id);
                    clearTimeout(pending.timeout);
                    if (message.error) pending.reject(new Error(message.error.message));
                    else pending.resolve(message.result);
                } else if (message.method === 'Network.requestWillBeSent') {
                    if (message.params.redirectResponse) {
                        const response = message.params.redirectResponse;
                        this.events.push({ type: 'redirect', ...safeLocation(response.url), status: response.status });
                    }
                    this.events.push({ type: 'request', ...safeLocation(message.params.request.url) });
                } else if (message.method === 'Network.responseReceived') {
                    const response = message.params.response;
                    this.events.push({ type: 'response', ...safeLocation(response.url), status: response.status });
                } else if (message.method === 'Network.loadingFailed') {
                    this.events.push({ type: 'failure', status: 0, blockedReason: message.params.blockedReason || null,
                        corsError: message.params.corsErrorStatus?.corsError || null });
                }
            }
        });
        readable.on('error', error => this.fail(error));
        readable.on('end', () => this.fail(new Error('Chrome closed the debug pipe.')));
    }
    fail(error) {
        for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
        this.pending.clear();
    }
    call(method, params = {}, sessionId) {
        const id = this.nextId++;
        return new Promise((resolveCall, reject) => {
            const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, 60000);
            this.pending.set(id, { resolve: resolveCall, reject, timeout });
            this.writable.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
        });
    }
    close() { this.writable.end(); this.readable.destroy(); }
}

let chrome, connection;
const report = { observedAt: new Date().toISOString(), profile: 'new isolated signed-out profile', runRoot,
    expectedClassification: expectedCode, requests: [], classification: null, browserNetwork: [] };
try {
    await mkdir(extensionRoot);
    const packageScript = await readFile(join(root, 'scripts', 'package-store.ps1'), 'utf8');
    const runtimeBlock = packageScript.match(/\$runtimeFiles\s*=\s*@\(([\s\S]*?)\)/)?.[1];
    if (!runtimeBlock) throw new Error('Package runtime allowlist was not found.');
    for (const [, relative] of runtimeBlock.matchAll(/'([^']+)'/g)) {
        if (relative.includes('..') || relative.startsWith('/') || relative.includes(':')) throw new Error('Invalid runtime path.');
        await mkdir(dirname(join(extensionRoot, relative)), { recursive: true });
        await cp(join(root, relative), join(extensionRoot, relative));
    }
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
    report.hostPermissions = manifest.host_permissions;
    report.permissions = manifest.permissions;
    const workerPath = join(extensionRoot, manifest.background.service_worker);
    await writeFile(workerPath, (await readFile(workerPath, 'utf8')) +
        "\nimport { __testing as liveAuthTesting } from './notebooklm-api.js';\nglobalThis.__liveAuthApi = { fetchTokens, resetTokens: liveAuthTesting.resetTokens };\n");
    chrome = spawn(await chromeExecutable(), ['--disable-gpu', '--lang=en', '--enable-unsafe-extension-debugging',
        '--no-first-run', '--no-default-browser-check', '--window-position=-32000,-32000',
        '--remote-debugging-pipe', `--user-data-dir=${profileRoot}`],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    connection = new PipeConnection(chrome.stdio[4], chrome.stdio[3]);
    report.browserVersion = (await connection.call('Browser.getVersion')).product;
    const { id } = await connection.call('Extensions.loadUnpacked', { path: extensionRoot });
    if (!id) throw new Error('Extension did not load.');
    let worker;
    for (let attempt = 0; attempt < 40; attempt++) {
        worker = (await connection.call('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/background.js`);
        if (worker) break;
        await delay(250);
    }
    if (!worker) throw new Error('The extension service worker did not start.');
    const { sessionId } = await connection.call('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    await connection.call('Runtime.enable', {}, sessionId);
    await connection.call('Network.enable', {}, sessionId);
    const result = await connection.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `
        (async () => {
            const api = globalThis.__liveAuthApi;
            const originalFetch = globalThis.fetch;
            const requests = [];
            const safe = value => {
                const url = new URL(value);
                return {host:url.hostname,path:url.hostname==='accounts.google.com' && !/^\\/(?:ServiceLogin|AccountChooser|CookieMismatch|(?:v\\d+\\/)?signin(?:\\/[^/]+)?|)$/.test(url.pathname)?'/<redacted>':url.pathname};
            };
            globalThis.fetch = async (url, options={}) => {
                if ((options.method || 'GET').toUpperCase() !== 'GET') throw new Error('Live auth probe refuses mutations.');
                const record = {requested:safe(url)}; requests.push(record);
                try {
                    const response = await originalFetch(url, options);
                    Object.assign(record,{final:safe(response.url || url),status:response.status});
                    return response;
                } catch (error) { Object.assign(record,{status:0,errorType:error.name}); throw error; }
            };
            try {
                api.resetTokens();
                await api.fetchTokens();
                return {requests,classification:{ok:true,code:null}};
            } catch (error) {
                return {requests,classification:{ok:false,code:error.code || null,phase:error.phase || null,
                    failures:(error.failures||[]).map(item=>({host:item.host,kind:item.kind,httpStatus:item.httpStatus||null}))}};
            } finally { globalThis.fetch=originalFetch; }
        })()
    ` }, sessionId);
    if (result.exceptionDetails) throw new Error('Live worker evaluation failed. No response body was retained.');
    Object.assign(report, result.result.value);
    report.browserNetwork = connection.events;
    report.matchesExpectedClassification = report.classification.code === expectedCode;
    if (!report.matchesExpectedClassification) process.exitCode = 1;
} catch (error) {
    report.harnessError = error.message;
    process.exitCode = 1;
} finally {
    connection?.close();
    if (chrome) {
        chrome.kill();
        if (chrome.exitCode === null) await Promise.race([new Promise(resolveExit => chrome.once('exit', resolveExit)), delay(3000)]);
    }
    await writeFile(join(runRoot, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    console.log(`Retained isolated profile and sanitized evidence at ${runRoot}`);
}
