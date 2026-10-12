import { counts, hostname, matchingTabs, orderedTabs, protection } from './core.mjs';

const $ = id => document.getElementById(id);
let tabs = [];
let currentId = -1;
let currentWindowId = -1;
let domain = '';
let monitoredDomain = '';
let busy = false;
let reading = false;
let dirty = false;
let scheduled = false;
const rows = new Map();

function feedback(message, detail = '') {
  $('feedback').textContent = message;
  $('feedback').title = detail;
}

function renderDomains() {
  const query = $('domain-search').value.trim().toLowerCase();
  const totals = new Map();
  for (const tab of tabs) {
    const host = hostname(tab.url);
    if (host) totals.set(host, (totals.get(host) || 0) + 1);
  }
  const domains = [...totals.keys()].sort();
  const visible = domains.filter(value => value.includes(query));
  $('domain-options').replaceChildren(...visible.map(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value} (${totals.get(value)})`;
    option.selected = value === domain;
    return option;
  }));
  $('domain-options').hidden = !visible.length;
  $('no-domains').hidden = !!visible.length;
}

function createRow(tab) {
  const row = $('tab-template').content.firstElementChild.cloneNode(true);
  row.dataset.id = tab.id;
  row.querySelector('.switch-tab').addEventListener('click', async () => {
    if (busy) return;
    try {
      const latest = await chrome.tabs.get(tab.id);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(latest.windowId, { focused: true });
      window.close();
    } catch {
      feedback('That tab is no longer available.');
      await refresh();
    }
  });
  row.querySelector('.discard-tab').addEventListener('click', () => discard(tab.id));
  const favicon = row.querySelector('.favicon');
  favicon.addEventListener('error', () => {
    const fallback = chrome.runtime.getURL('icons/icon.svg');
    if (favicon.src !== fallback) favicon.src = fallback;
  });
  rows.set(tab.id, row);
  return row;
}

function render() {
  const matching = matchingTabs(tabs, domain);
  const stats = counts(matching);
  for (const [key, value] of Object.entries(stats)) $(key).textContent = value;
  $('selected-domain').textContent = domain || 'Choose a hostname';
  $('selected-domain').title = domain;
  const current = tabs.find(tab => tab.id === currentId);
  const currentHost = hostname(current?.url);
  $('current-context').textContent = currentHost === domain && domain
    ? 'Current tab is on this hostname · it stays loaded'
    : `Current tab: ${currentHost || 'browser or unavailable page'}`;
  $('current-context').title = $('current-context').textContent;
  const eligible = matching.filter(tab => !protection(tab, currentId)).length;
  $('discard-others').disabled = busy || !eligible;
  $('eligible-count').textContent = eligible ? String(eligible) : '';
  $('protection-note').textContent = currentHost !== domain && domain
    ? 'Discards eligible background tabs on this hostname. All active tabs stay loaded.'
    : 'Current, active, pinned and audible tabs stay loaded.';
  const windows = [...new Set(matching.map(tab => tab.windowId))].sort((a, b) => a - b);
  $('window-count').textContent = `${windows.length} window${windows.length === 1 ? '' : 's'}`;
  $('empty').hidden = !!matching.length;
  $('monitor').disabled = busy || !domain;
  $('domain-search').disabled = busy;
  $('domain-options').disabled = busy;
  $('monitor').checked = !!domain && monitoredDomain === domain;
  $('monitor-context').textContent = monitoredDomain && monitoredDomain !== domain
    ? `Toolbar is monitoring ${monitoredDomain}` : '';
  $('monitor-context').title = $('monitor-context').textContent;
  const list = $('tab-list');
  const ids = new Set(matching.map(tab => tab.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) { row.remove(); rows.delete(id); }
  }
  const ordered = orderedTabs(matching, currentId);
  ordered.forEach((tab, index) => {
    const row = rows.get(tab.id) || createRow(tab);
    const reason = protection(tab, currentId);
    const title = tab.title || hostname(tab.url) || 'Untitled tab';
    row.dataset.discarded = String(tab.discarded === true);
    row.querySelector('.tab-title').textContent = title;
    row.querySelector('.tab-meta').textContent = `${tab.discarded === true ? 'Discarded' : 'Loaded'} · ${tab.windowId === currentWindowId ? 'This window' : `Window ${windows.indexOf(tab.windowId) + 1}`}${reason && reason !== 'Already discarded' && reason !== 'Current tab' ? ` · ${reason}` : ''}`;
    row.querySelector('.current-marker').hidden = tab.id !== currentId;
    const switchButton = row.querySelector('.switch-tab');
    switchButton.title = `Switch to ${title}`;
    switchButton.setAttribute('aria-label', `Switch to ${title}${tab.discarded ? ' (reloads discarded tab)' : ''}`);
    switchButton.disabled = busy;
    const discardButton = row.querySelector('.discard-tab');
    discardButton.disabled = busy || !!reason;
    discardButton.title = reason || 'Discard without closing';
    discardButton.setAttribute('aria-label', reason ? `${title}: ${reason}` : `Discard ${title}`);
    const favicon = row.querySelector('.favicon');
    const cached = new URL(chrome.runtime.getURL('_favicon/'));
    cached.searchParams.set('pageUrl', tab.url);
    cached.searchParams.set('size', '32');
    if (favicon.dataset.page !== tab.url) {
      favicon.dataset.page = tab.url;
      favicon.src = cached.href;
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
}

async function refresh() {
  dirty = true;
  if (reading) return;
  reading = true;
  try {
    while (dirty) {
      dirty = false;
      tabs = await chrome.tabs.query({ windowType: 'normal' });
      currentId = tabs.find(tab => tab.windowId === currentWindowId && tab.active)?.id ?? -1;
      renderDomains();
      render();
    }
  } catch {
    feedback('Could not refresh tabs. Reopen the popup to retry.');
  } finally { reading = false; }
}

function scheduleRefresh() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; refresh(); });
}

async function discard(onlyId = null) {
  if (busy || !domain) return;
  busy = true;
  render();
  feedback('Discarding…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'discard', domain, currentId, onlyId });
    if (response?.error) feedback(response.error);
    else if (response?.result) {
      const result = response.result;
      feedback(`${result.discarded} tab${result.discarded === 1 ? '' : 's'} discarded · ${result.skipped} skipped`,
        Object.entries(result.reasons).map(([reason, count]) => `${count}: ${reason}`).join('\n'));
    } else feedback('Could not confirm the result. Check the tab counts.');
  } catch {
    feedback('Could not confirm the result. Check the tab counts.');
  } finally {
    busy = false;
    await refresh();
  }
}

$('discard-others').addEventListener('click', () => discard());
$('domain-search').addEventListener('input', renderDomains);
$('domains').addEventListener('toggle', () => {
  if ($('domains').open) { $('domain-search').value = ''; renderDomains(); $('domain-search').focus(); }
});
$('domain-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); $('domain-options').focus(); }
});
$('domain-options').addEventListener('change', async () => {
  if (busy) return;
  domain = $('domain-options').value;
  $('domains').open = false;
  $('domains').querySelector('summary').focus();
  feedback('');
  render();
  try { await chrome.storage.local.set({ lastDomain: domain }); }
  catch { feedback('Hostname selected; preference could not be saved.'); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('domains').open) {
    event.preventDefault(); $('domains').open = false; $('domains').querySelector('summary').focus();
  }
});
document.addEventListener('click', event => {
  if (!$('domains').contains(event.target)) $('domains').open = false;
});
$('monitor').addEventListener('change', async () => {
  const next = $('monitor').checked ? domain : '';
  try {
    await chrome.storage.local.set({ monitoredDomain: next });
    monitoredDomain = next;
    render();
  } catch { feedback('Could not save the toolbar preference.'); render(); }
});

async function start() {
  try {
    const [window, preferences, snapshot] = await Promise.all([
      chrome.windows.getCurrent(), chrome.storage.local.get(['lastDomain', 'monitoredDomain']),
      chrome.tabs.query({ windowType: 'normal' })
    ]);
    currentWindowId = window.id;
    tabs = snapshot;
    currentId = tabs.find(tab => tab.windowId === currentWindowId && tab.active)?.id ?? -1;
    const available = new Set(tabs.map(tab => hostname(tab.url)).filter(Boolean));
    monitoredDomain = preferences.monitoredDomain || '';
    domain = hostname(tabs.find(tab => tab.id === currentId)?.url) ||
      [preferences.lastDomain, monitoredDomain, ...available].find(value => available.has(value)) || '';
    renderDomains();
    render();
    for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated,
      chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced,
      chrome.windows.onCreated, chrome.windows.onRemoved]) event.addListener(scheduleRefresh);
    chrome.tabs.onUpdated.addListener((_id, change) => {
      if (['url', 'status', 'discarded', 'title', 'favIconUrl', 'pinned', 'audible', 'autoDiscardable'].some(key => key in change)) scheduleRefresh();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.monitoredDomain) {
        monitoredDomain = changes.monitoredDomain.newValue || ''; render();
      }
    });
    // Reconcile events that arrived while the initial snapshot was loading.
    await refresh();
  } catch {
    $('selected-domain').textContent = 'Tabs unavailable';
    $('current-context').textContent = 'Reopen the popup to retry.';
    feedback('Chrome could not provide the tab list.');
  }
}
start();
