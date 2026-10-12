// Native CDP + Node only. All tabs and browser settings belong to a disposable
// profile. No connection to the user's browser and no website traffic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'tab-discarder-test-'));
const artifacts = process.env.DISCARDER_TEST_ARTIFACTS || path.join(tmpdir(), 'tab-discarder-artifacts');
await mkdir(artifacts, { recursive: true });
const browser = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
  '--window-size=1024,900',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--autoplay-policy=no-user-gesture-required', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
browser.stderr.on('data', chunk => { browserLog += chunk; });
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(`<title>Conversation ${request.url}</title><p>Local fixture</p>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let socket;
let sequence = 0;
const pending = new Map();
const errors = [];
const requests = [];
async function until(task, message = 'Condition timed out') {
  const limit = Date.now() + 10000;
  while (Date.now() < limit) {
    const result = await task();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(message);
}
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function attach(targetId) {
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  await command('Runtime.enable', {}, sessionId);
  return sessionId;
}
async function evaluate(session, expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function check(name, task) { await task(); console.log(`PASS ${name}`); }

try {
  const portFile = await until(async () => {
    try { return await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); }
    catch { if (browser.exitCode !== null) throw Error(browserLog); return false; }
  });
  const [port, endpoint] = portFile.trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(Error(message.error.message)); else handler.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
  });
  const { id } = await command('Extensions.loadUnpacked', { path: root });
  console.log(`${(await command('Browser.getVersion')).product}; extension ${id}`);
  const workerTarget = await until(async () => (await command('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.includes(id)));
  const worker = await attach(workerTarget.targetId);
  const run = expression => evaluate(worker, expression);
  await until(() => run('typeof chrome !== "undefined" && !!chrome.tabs'));
  // Dynamic import is unavailable in service workers. Evaluate the same source
  // for direct lifecycle checks; popup checks below use real worker messaging.
  const coreSource = (await readFile(path.join(root, 'core.mjs'), 'utf8')).replaceAll('export ', '');
  await run(`globalThis.testDiscardTabs=(()=>{${coreSource}\nreturn discardTabs})()`);
  const all = () => run('chrome.tabs.query({windowType:"normal"})');
  const batch = (domain, currentId, onlyId = null) => run(`testDiscardTabs(chrome,${JSON.stringify(domain)},${currentId},${onlyId})`);
  async function reset(count) {
    return run(`(async()=>{
      const windows=await chrome.windows.getAll({windowTypes:['normal']});
      const windowId=windows[0].id;
      const old=await chrome.tabs.query({windowId});
      const tabs=[];
      for(let i=0;i<${count};i++) tabs.push(await chrome.tabs.create({windowId,url:${JSON.stringify(base)}+'/c/'+i,active:i===0}));
      await chrome.tabs.remove(old.map(t=>t.id));
      for(const w of windows.slice(1)) await chrome.windows.remove(w.id);
      await chrome.windows.update(windowId,{focused:true});
      await chrome.storage.local.clear();
      return {ids:tabs.map(t=>t.id),windowId};
    })()`);
  }
  async function ready() {
    await until(async () => (await all()).every(tab => tab.status === 'complete' || tab.discarded), 'Tabs did not load');
  }
  let popup;
  async function openPopup(url = base + '/c/0', expectedDomain = '127.0.0.1') {
    const target = (await command('Target.getTargets', { filter: [{}] })).targetInfos.find(target => target.type === 'tab' && target.url === url);
    await command('Extensions.triggerAction', { id, targetId: target.targetId });
    const popupTarget = await until(async () => (await command('Target.getTargets')).targetInfos.find(target => target.url === `chrome-extension://${id}/popup.html`), 'Popup did not open');
    popup = await attach(popupTarget.targetId);
    await command('Network.enable', {}, popup);
    await until(async () => await evaluate(popup, `document.getElementById('selected-domain')?.textContent === ${JSON.stringify(expectedDomain)}`));
    return popupTarget;
  }
  await check('one current tab is preserved', async () => {
    const { ids } = await reset(1); await ready();
    assert.equal((await batch('127.0.0.1', ids[0])).discarded, 0);
    assert.equal((await all())[0].discarded, false);
  });
  await check('ten tabs: discard nine, preserve URLs and order', async () => {
    const { ids } = await reset(10); await ready();
    const before = await all();
    const result = await batch('127.0.0.1', ids[0]);
    assert.equal(result.discarded, 9, JSON.stringify({ result, before })); assert.equal(result.skipped, 1);
    const after = await all();
    assert.deepEqual(after.map(t => [t.url, t.index]), before.map(t => [t.url, t.index]));
    assert.equal(after.filter(t => t.discarded).length, 9);
    assert.equal((await batch('127.0.0.1', ids[0])).discarded, 0);
  });
  await check('active tabs in multiple windows and pinned tabs stay loaded', async () => {
    const { ids } = await reset(4); await ready();
    await run(`chrome.tabs.update(${ids[1]},{pinned:true})`);
    await run(`chrome.windows.create({url:[${JSON.stringify(base + '/second/active')},${JSON.stringify(base + '/second/background')}],focused:false})`);
    await ready();
    const before = await all();
    const result = await batch('127.0.0.1', ids[0]);
    assert.equal(result.discarded, 3); assert.equal(result.skipped, 3);
    for (const tab of (await all()).filter(t => t.active || t.pinned)) assert.equal(tab.discarded, false);
    assert.equal((await all()).length, before.length);
  });
  await check('audible and auto-discard-protected tabs stay loaded', async () => {
    const { ids } = await reset(4); await ready();
    await run(`chrome.tabs.update(${ids[1]},{autoDiscardable:false})`);
    const target = (await command('Target.getTargets')).targetInfos.find(t => t.url === base + '/c/2');
    const page = await attach(target.targetId);
    await evaluate(page, 'globalThis.audio=new AudioContext();globalThis.osc=audio.createOscillator();osc.connect(audio.destination);osc.start();audio.resume()');
    await until(async () => (await all()).find(t => t.id === ids[2]).audible);
    await command('Target.detachFromTarget', { sessionId: page });
    assert.equal((await batch('127.0.0.1', ids[0])).discarded, 1);
    assert.equal((await all()).find(t => t.id === ids[2]).discarded, false);
  });
  await check('tab groups retain membership after discard', async () => {
    const { ids } = await reset(3); await ready();
    const group = await run(`chrome.tabs.group({tabIds:[${ids[1]},${ids[2]}]})`);
    await batch('127.0.0.1', ids[0]);
    assert.ok((await all()).filter(t => t.id !== ids[0]).every(t => t.groupId === group && t.discarded));
  });
  await check('actual action popup selects current hostname and reflects tab events', async () => {
    await reset(10); await ready();
    await openPopup();
    assert.deepEqual(await evaluate(popup, '["total","loaded","discarded"].map(id=>document.getElementById(id).textContent)'), ['10', '10', '0']);
    const added = await run(`chrome.tabs.create({url:${JSON.stringify(base + '/new')},active:false})`);
    await until(async () => await evaluate(popup, 'document.getElementById("total").textContent==="11"'));
    await run(`chrome.tabs.remove(${added.id})`);
    await until(async () => await evaluate(popup, 'document.getElementById("total").textContent==="10"'));
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, popup);
    await evaluate(popup, 'new Promise(r=>setTimeout(r,150))');
    assert.equal(await evaluate(popup, 'document.documentElement.scrollHeight<=window.innerHeight'), true,
      JSON.stringify(await evaluate(popup, '({viewport:innerHeight,doc:document.documentElement.scrollHeight,body:document.body.getBoundingClientRect().height,main:document.querySelector("main").getBoundingClientRect().height,list:document.getElementById("tab-list").getBoundingClientRect().height})')));
    assert.ok(await evaluate(popup, 'document.getElementById("tab-list").getBoundingClientRect().height>100'),
      JSON.stringify(await evaluate(popup, '({viewport:innerHeight,body:document.body.getBoundingClientRect().height,main:document.querySelector("main").getBoundingClientRect().height,list:document.getElementById("tab-list").getBoundingClientRect().height})')));
    assert.ok(await evaluate(popup, 'document.querySelector("footer").getBoundingClientRect().top>=document.getElementById("tab-list").getBoundingClientRect().bottom'), 'Footer must not overlap tabs');
    await writeFile(path.join(artifacts, 'popup-light.png'), Buffer.from((await command('Page.captureScreenshot', {}, popup)).data, 'base64'));
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, popup);
    await evaluate(popup, 'new Promise(r=>setTimeout(r,150))');
    await writeFile(path.join(artifacts, 'popup-dark.png'), Buffer.from((await command('Page.captureScreenshot', {}, popup)).data, 'base64'));
    await evaluate(popup, 'document.getElementById("discard-others").click();document.getElementById("discard-others").click()');
    await until(async () => await evaluate(popup, 'document.getElementById("discarded").textContent==="9"'));
    assert.match(await evaluate(popup, 'document.getElementById("feedback").textContent'), /9 tabs discarded · 1 skipped/);
    assert.equal((await all()).filter(t => t.discarded).length, 9);
  });
  await check('optional badge is explicit, accurate and clears when disabled', async () => {
    assert.equal(await run('chrome.action.getBadgeText({})'), '');
    await evaluate(popup, 'document.getElementById("monitor").click()');
    await until(async () => (await run('chrome.action.getBadgeText({})')) === '1');
    assert.match(await run('chrome.action.getTitle({})'), /1 loaded on 127\.0\.0\.1/);
    await evaluate(popup, 'document.getElementById("monitor").click()');
    await until(async () => (await run('chrome.action.getBadgeText({})')) === '');
  });
  await check('domain switching keeps the current tab separate and the badge fixed', async () => {
    const otherBase = base.replace('127.0.0.1', 'localhost');
    await run(`(async()=>{for(let i=0;i<2;i++) await chrome.tabs.create({url:${JSON.stringify(otherBase)}+'/other/'+i,active:false})})()`);
    await ready();
    await until(async () => await evaluate(popup, '!!document.querySelector("#domain-options option[value=localhost]")'));
    await evaluate(popup, `document.getElementById('monitor').click();
      document.getElementById('domain-options').value='localhost';
      document.getElementById('domain-options').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate(popup, 'document.getElementById("current-context").textContent'), 'Current tab: 127.0.0.1');
    assert.match(await evaluate(popup, 'document.getElementById("protection-note").textContent'), /background tabs/);
    await until(async () => (await run('chrome.action.getBadgeText({})')) === '1');
    await evaluate(popup, 'document.getElementById("discard-others").click()');
    await until(async () => await evaluate(popup, 'document.getElementById("discarded").textContent==="2"'));
    assert.equal(await run('chrome.action.getBadgeText({})'), '1');
    assert.match(await evaluate(popup, 'document.getElementById("monitor-context").textContent'), /127\.0\.0\.1/);
  });
  await check('hostname selector filters, supports keyboard focus and Escape', async () => {
    await evaluate(popup, `document.querySelector('#domains summary').click()`);
    await until(async () => await evaluate(popup, 'document.activeElement.id==="domain-search"'));
    await evaluate(popup, `document.getElementById('domain-search').value='local';document.getElementById('domain-search').dispatchEvent(new Event('input'))`);
    assert.deepEqual(await evaluate(popup, '[...document.getElementById("domain-options").options].map(o=>o.value)'), ['localhost']);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' }, popup);
    assert.equal(await evaluate(popup, 'document.activeElement.id'), 'domain-options');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, popup);
    assert.equal(await evaluate(popup, 'document.getElementById("domains").open'), false);
    assert.equal(await evaluate(popup, 'document.activeElement.tagName'), 'SUMMARY');
  });
  await check('closing all matching tabs produces an empty state', async () => {
    await run(`(async()=>{const tabs=await chrome.tabs.query({});await chrome.tabs.remove(tabs.filter(t=>t.url.startsWith('http://localhost:')).map(t=>t.id))})()`);
    await until(async () => await evaluate(popup, 'document.getElementById("empty").hidden===false'));
    assert.equal(await evaluate(popup, 'document.getElementById("discard-others").disabled'), true);
    assert.equal(await evaluate(popup, 'document.getElementById("total").textContent'), '0');
  });
  await check('individual discard and switching activate the requested tab', async () => {
    await evaluate(popup, `document.getElementById('domain-search').value='';document.getElementById('domain-search').dispatchEvent(new Event('input'));
      document.getElementById('domain-options').value='127.0.0.1';document.getElementById('domain-options').dispatchEvent(new Event('change'))`);
    const added = await run(`chrome.tabs.create({url:${JSON.stringify(base + '/individual')},active:false})`);
    await ready();
    await until(async () => await evaluate(popup, `document.querySelector('[data-id="${added.id}"] .discard-tab')?.disabled===false`));
    await evaluate(popup, `document.querySelector('[data-id="${added.id}"] .discard-tab').click()`);
    await until(async () => await evaluate(popup, 'document.getElementById("discarded").textContent==="10"'));
    const discarded = (await all()).find(t => t.url.endsWith('/individual'));
    assert.equal(discarded.discarded, true);
    await until(async () => await evaluate(popup, `document.querySelector('[data-id="${discarded.id}"] .switch-tab')?.disabled===false`));
    await evaluate(popup, `document.querySelector('[data-id="${discarded.id}"] .switch-tab').click()`);
    await until(async () => (await all()).some(t => t.url.endsWith('/individual') && t.active));
    // Headless Chrome can leave an activated tab unloaded; visible-window
    // reload behavior is explicitly covered by the manual checklist.
  });
  await check('unavailable-domain fallback and no-website empty state', async () => {
    const { ids } = await reset(1); await ready();
    await run(`chrome.tabs.create({url:'chrome://extensions/',active:true})`);
    const popupTarget = await openPopup('chrome://extensions/');
    assert.match(await evaluate(popup, 'document.getElementById("current-context").textContent'), /browser or unavailable/);
    await run(`chrome.tabs.remove(${ids[0]})`);
    await until(async () => await evaluate(popup, 'document.getElementById("empty").hidden===false'));
    await command('Target.closeTarget', { targetId: popupTarget.targetId });
    await openPopup('chrome://extensions/', 'Choose a hostname');
    assert.equal(await evaluate(popup, 'document.getElementById("monitor").disabled'), true);
  });
  await check('worker rejects overlapping batches and finishes after popup closes', async () => {
    await reset(30); await ready();
    const popupTarget = await openPopup();
    const result = await evaluate(popup, `(async()=>{
      const current=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
      const message={type:'discard',domain:'127.0.0.1',currentId:current.id,onlyId:null};
      return Promise.all([chrome.runtime.sendMessage(message),chrome.runtime.sendMessage(message)])
    })()`);
    assert.equal(result.filter(item => item.error?.includes('already running')).length, 1);
    assert.equal(result.find(item => item.result).result.discarded, 29);
    await command('Target.closeTarget', { targetId: popupTarget.targetId });
    await reset(30); await ready();
    const nextPopup = await openPopup();
    await evaluate(popup, 'document.getElementById("discard-others").click()');
    await command('Target.closeTarget', { targetId: nextPopup.targetId });
    await until(async () => (await all()).filter(t => t.discarded).length === 29);
  });
  assert.deepEqual(errors, [], 'Unexpected browser exceptions');
  assert.ok(requests.every(url => url.startsWith('chrome-extension:') || url.startsWith('data:')), 'Popup made external requests');
  console.log(`Browser checks passed. Screenshots: ${artifacts}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await command('Browser.close').catch(() => {});
    socket.close();
  }
  if (browser.exitCode === null) { browser.kill(); await once(browser, 'exit'); }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
