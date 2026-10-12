// Only exact HTTP(S) hostnames. No guesses about registrable domains.
export function hostname(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : '';
  } catch {
    return '';
  }
}

export function matchingTabs(tabs, domain) {
  return domain ? tabs.filter(tab => hostname(tab.url) === domain) : [];
}

export function counts(tabs) {
  const discarded = tabs.filter(tab => tab.discarded === true).length;
  return { total: tabs.length, loaded: tabs.length - discarded, discarded };
}

export function protection(tab, currentId) {
  if (tab.discarded === true) return 'Already discarded';
  if (tab.id === currentId) return 'Current tab';
  if (tab.active) return 'Active in its window';
  if (tab.pinned) return 'Pinned';
  if (tab.mutedInfo?.reason === 'capture') return 'Being captured';
  if (tab.audible) return 'Playing audio';
  if (tab.autoDiscardable === false) return 'Protected from discarding';
  if (tab.status === 'loading' || tab.pendingUrl) return 'Loading or navigating';
  return '';
}

export function orderedTabs(tabs, currentId) {
  return [...tabs].sort((a, b) =>
    Number(a.discarded === true) - Number(b.discarded === true) ||
    Number(b.id === currentId) - Number(a.id === currentId) ||
    a.windowId - b.windowId || a.index - b.index);
}

// Chrome remains the authority. Re-read each tab immediately before acting,
// and reconcile successful API responses against a final snapshot.
export async function discardTabs(api, domain, currentId, onlyId = null) {
  const initial = matchingTabs(await api.tabs.query({ windowType: 'normal' }), domain)
    .filter(tab => onlyId === null || tab.id === onlyId);
  const targets = initial.filter(tab => tab.discarded !== true);
  const accepted = new Map();
  const reasons = {};
  const skipped = reason => { reasons[reason] = (reasons[reason] || 0) + 1; };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (cursor < targets.length) {
      const original = targets[cursor++];
      try {
        const tab = await api.tabs.get(original.id);
        const window = await api.windows.get(tab.windowId);
        if (window.type !== 'normal' || tab.url !== original.url || hostname(tab.url) !== domain) {
          skipped('Changed or moved');
          continue;
        }
        const reason = protection(tab, currentId);
        if (reason) {
          skipped(reason);
          continue;
        }
        const result = await api.tabs.discard(tab.id);
        // Chrome may replace the tab's internal ID while discarding. Follow
        // the returned tab rather than assuming the old ID remains valid.
        if (Number.isInteger(result?.id) && result.discarded === true && result.url === tab.url) accepted.set(result.id, result.url);
        else skipped('Chrome declined');
      } catch {
        skipped('Unavailable or Chrome declined');
      }
    }
  }));
  const tabs = await api.tabs.query({ windowType: 'normal' });
  const actual = new Map(matchingTabs(tabs, domain)
    .filter(tab => tab.discarded === true).map(tab => [tab.id, tab.url]));
  let discarded = 0;
  for (const [id, url] of accepted) {
    if (actual.get(id) === url) discarded++;
    else skipped('Reloaded, changed or closed');
  }
  return { discarded, skipped: targets.length - discarded, reasons };
}
