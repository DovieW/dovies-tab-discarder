import { counts, discardTabs, hostname, matchingTabs } from './core.mjs';

let badgeTask;
let badgeDirty = false;
let discarding = false;

// One coalesced snapshot per burst. Nothing runs periodically or keeps this
// worker alive; transient state is rebuilt from Chrome whenever it wakes.
function updateBadge() {
  badgeDirty = true;
  if (badgeTask) return badgeTask;
  badgeTask = (async () => {
    while (badgeDirty) {
      badgeDirty = false;
      const { monitoredDomain = '' } = await chrome.storage.local.get('monitoredDomain');
      const loaded = monitoredDomain
        ? counts(matchingTabs(await chrome.tabs.query({ windowType: 'normal' }), monitoredDomain)).loaded
        : 0;
      await chrome.action.setBadgeBackgroundColor({ color: '#426957' });
      await chrome.action.setBadgeText({ text: monitoredDomain ? (loaded > 99 ? '99+' : String(loaded)) : '' });
      await chrome.action.setTitle({ title: monitoredDomain
        ? `Dovie's Tab Discarder — ${loaded} loaded on ${monitoredDomain}`
        : "Dovie's Tab Discarder" });
    }
  })().catch(() => console.warn('Could not refresh the tab badge.')).finally(() => {
    badgeTask = null;
    if (badgeDirty) updateBadge();
  });
  return badgeTask;
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.monitoredDomain) updateBadge();
});
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('url' in change || 'discarded' in change || 'status' in change) updateBadge();
});
for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onAttached,
  chrome.tabs.onDetached, chrome.tabs.onReplaced, chrome.windows.onRemoved]) {
  event.addListener(updateBadge);
}

// Run batches here so closing the popup does not abandon an operation.
// A second popup or repeated click cannot start an overlapping batch.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'discard') return;
  if (hostname(`https://${message.domain}/`) !== message.domain ||
    !Number.isInteger(message.currentId) ||
    (message.onlyId !== null && !Number.isInteger(message.onlyId))) {
    respond({ error: 'Invalid tab selection.' });
    return;
  }
  if (discarding) {
    respond({ error: 'A discard operation is already running.' });
    return;
  }
  discarding = true;
  discardTabs(chrome, message.domain, message.currentId, message.onlyId)
    .then(result => respond({ result }), () => respond({ error: 'Could not read tab states. Try again.' }))
    .finally(() => { discarding = false; updateBadge(); });
  return true;
});
