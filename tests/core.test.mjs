import test from 'node:test';
import assert from 'node:assert/strict';
import { counts, discardTabs, hostname, matchingTabs, orderedTabs, protection } from '../core.mjs';

const tab = (id, extra = {}) => ({ id, windowId: 1, index: id, url: `https://chatgpt.com/c/${id}`,
  active: false, discarded: false, pinned: false, audible: false, autoDiscardable: true, status: 'complete', ...extra });

function mock(initial, { beforeGet, discard, query } = {}) {
  const state = new Map(initial.map(item => [item.id, { ...item }]));
  const calls = [];
  let running = 0;
  let peak = 0;
  let queries = 0;
  const api = {
    tabs: {
      query: async options => {
        assert.deepEqual(options, { windowType: 'normal' });
        query?.(++queries, state);
        return [...state.values()].map(item => ({ ...item }));
      },
      get: async id => {
        beforeGet?.(id, state);
        if (!state.has(id)) throw Error('Closed');
        return { ...state.get(id) };
      },
      discard: async id => {
        calls.push(id); running++; peak = Math.max(peak, running);
        try {
          await new Promise(resolve => setTimeout(resolve, 1));
          if (discard) return await discard(id, state);
          const item = state.get(id);
          item.discarded = true;
          return { ...item };
        } finally { running--; }
      }
    },
    windows: { get: async () => ({ type: 'normal' }) }
  };
  return { api, state, calls, peak: () => peak };
}

test('exact hostname parsing handles public suffixes and excludes special URLs', () => {
  for (const value of ['chrome://newtab/', 'about:blank', 'chrome-extension://id/', 'file:///tmp/a', '', null, 'invalid']) assert.equal(hostname(value), '');
  assert.equal(hostname('https://A.example.co.uk:443/path'), 'a.example.co.uk');
  assert.equal(hostname('http://localhost:123/'), 'localhost');
  assert.equal(hostname('https://例え.jp/'), 'xn--r8jz45g.jp');
  assert.equal(matchingTabs([tab(1), tab(2, { url: 'https://www.chatgpt.com/' })], 'chatgpt.com').length, 1);
  assert.deepEqual(matchingTabs([tab(1)], ''), []);
});
test('only discarded=true counts as discarded; frozen and hidden are loaded', () => {
  assert.deepEqual(counts([tab(1), tab(2, { discarded: true }), tab(3, { frozen: true, hidden: true })]), { total: 3, loaded: 2, discarded: 1 });
  assert.deepEqual(counts([]), { total: 0, loaded: 0, discarded: 0 });
});
test('protection explains each exposed safety condition', () => {
  assert.equal(protection(tab(1), 1), 'Current tab');
  for (const [extra, expected] of [
    [{ active: true }, 'Active in its window'], [{ pinned: true }, 'Pinned'],
    [{ audible: true }, 'Playing audio'], [{ autoDiscardable: false }, 'Protected from discarding'],
    [{ mutedInfo: { muted: true, reason: 'capture' } }, 'Being captured'],
    [{ status: 'loading' }, 'Loading or navigating'], [{ pendingUrl: 'https://other.test/' }, 'Loading or navigating'],
    [{ discarded: true }, 'Already discarded']
  ]) assert.equal(protection(tab(2, extra), 1), expected);
  assert.equal(protection(tab(2, { frozen: true }), 1), '');
});
test('loaded first, current first within loaded, then stable window and tab order', () => {
  const input = [tab(3, { discarded: true }), tab(2, { windowId: 2 }), tab(4), tab(1)];
  assert.deepEqual(orderedTabs(input, 4).map(item => item.id), [4, 1, 2, 3]);
  assert.equal(input[0].id, 3);
});
test('one current tab is kept', async () => {
  const m = mock([tab(1, { active: true })]);
  const result = await discardTabs(m.api, 'chatgpt.com', 1);
  assert.equal(result.discarded, 0); assert.equal(result.skipped, 1); assert.deepEqual(m.calls, []);
});
test('ten tabs discard nine without closing or changing URLs', async () => {
  const initial = Array.from({ length: 10 }, (_, i) => tab(i + 1, { active: i === 0 }));
  const m = mock(initial);
  const result = await discardTabs(m.api, 'chatgpt.com', 1);
  assert.equal(result.discarded, 9); assert.equal(result.skipped, 1);
  assert.deepEqual([...m.state.values()].map(item => item.url), initial.map(item => item.url));
});
test('all active windows, pinned, audible, opted-out, loading and discarded tabs are skipped', async () => {
  const m = mock([tab(1, { active: true }), tab(2, { active: true, windowId: 2 }), tab(3, { pinned: true }),
    tab(4, { audible: true }), tab(5, { autoDiscardable: false }), tab(6, { status: 'loading' }),
    tab(7, { discarded: true }), tab(8, { windowId: 3 }), tab(9, { url: 'https://other.test/' }),
    tab(10, { mutedInfo: { muted: true, reason: 'capture' } })]);
  const result = await discardTabs(m.api, 'chatgpt.com', 1);
  assert.equal(result.discarded, 1); assert.equal(result.skipped, 7); assert.deepEqual(m.calls, [8]);
});
test('domain mismatch safely discards only eligible background tabs', async () => {
  const m = mock([tab(1, { url: 'https://other.test/', active: true }), tab(2), tab(3, { active: true, windowId: 2 })]);
  const result = await discardTabs(m.api, 'chatgpt.com', 1);
  assert.equal(result.discarded, 1); assert.deepEqual(m.calls, [2]);
});
test('rechecks activation, pinning, audio and navigation immediately before discarding', async () => {
  const m = mock([tab(1), tab(2), tab(3), tab(4), tab(5)], { beforeGet(id, state) {
    Object.assign(state.get(id), [{ active: true }, { pinned: true }, { audible: true },
      { url: 'https://other.test/' }, { url: 'https://chatgpt.com/c/different' }][id - 1]);
  } });
  const result = await discardTabs(m.api, 'chatgpt.com', -1);
  assert.equal(result.discarded, 0); assert.equal(result.skipped, 5); assert.deepEqual(m.calls, []);
});
test('closed tab and Chrome rejection do not abort the batch', async () => {
  const m = mock([tab(1), tab(2), tab(3)], {
    beforeGet(id, state) { if (id === 1) state.delete(id); },
    discard(id, state) { if (id === 2) throw Error('Chrome refused'); state.get(id).discarded = true; return state.get(id); }
  });
  const result = await discardTabs(m.api, 'chatgpt.com', -1);
  assert.equal(result.discarded, 1); assert.equal(result.skipped, 2);
});
test('undefined and unconfirmed API results are never successes', async () => {
  for (const result of [undefined, tab(1), tab(1, { discarded: true })]) {
    const m = mock([tab(1)], { discard: () => result });
    assert.equal((await discardTabs(m.api, 'chatgpt.com', -1)).discarded, 0);
  }
});
test('final snapshot catches reload, closure and domain changes after success', async () => {
  const m = mock([tab(1), tab(2), tab(3), tab(4)], { query(count, state) {
    if (count === 2) { state.get(1).discarded = false; state.delete(2); state.get(3).url = 'https://other.test/'; state.get(4).url = 'https://chatgpt.com/c/new'; }
  } });
  const result = await discardTabs(m.api, 'chatgpt.com', -1);
  assert.equal(result.discarded, 0); assert.equal(result.skipped, 4);
});
test('individual action is limited to its requested tab', async () => {
  const m = mock([tab(1), tab(2), tab(3)]);
  const result = await discardTabs(m.api, 'chatgpt.com', -1, 2);
  assert.equal(result.discarded, 1); assert.deepEqual(m.calls, [2]);
});
test('hundreds of tabs use at most four concurrent requests', async () => {
  const m = mock(Array.from({ length: 501 }, (_, i) => tab(i + 1)));
  const result = await discardTabs(m.api, 'chatgpt.com', -1);
  assert.equal(result.discarded, 501); assert.equal(m.peak(), 4);
});
test('newly opened tabs are outside the operation snapshot', async () => {
  const m = mock([tab(1)], { beforeGet(_id, state) { state.set(2, tab(2)); } });
  assert.equal((await discardTabs(m.api, 'chatgpt.com', -1)).discarded, 1);
  assert.deepEqual(m.calls, [1]);
});
test('Chrome may replace a tab ID during discard; reconcile the returned ID', async () => {
  const m = mock([tab(1)], { discard(id, state) {
    const replacement = { ...state.get(id), id: 101, discarded: true };
    state.delete(id); state.set(101, replacement); return replacement;
  } });
  assert.equal((await discardTabs(m.api, 'chatgpt.com', -1)).discarded, 1);
});
test('a tab moved out of a normal window is skipped', async () => {
  const m = mock([tab(1)]);
  m.api.windows.get = async () => ({ type: 'popup' });
  assert.equal((await discardTabs(m.api, 'chatgpt.com', -1)).skipped, 1);
  assert.deepEqual(m.calls, []);
});
