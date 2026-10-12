# Dovie's Tab Discarder

**Keep tabs. Lose the load.**

A small, local-only Chrome extension for inspecting loaded and discarded tabs by exact hostname, across all normal browser windows. Especially useful for keeping many ChatGPT conversations open without keeping every page loaded.

Manifest V3. Plain HTML, CSS and JavaScript. No dependencies, npm, build step, content scripts, website requests, analytics or backend.

## Install

Requires desktop Chrome 120 or newer.

1. Download and extract the ZIP from [the latest release](https://github.com/DovieW/dovies-tab-discarder/releases/latest), or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the directory containing `manifest.json`.
4. Pin **Dovie's Tab Discarder** to the toolbar and open its popup.

This is an unpacked release, not a Chrome Web Store installation. To update, replace the extracted files and click **Reload** on the extension's card.

## Use

The popup initially selects the current tab's hostname. On browser-internal pages, it falls back to your last available selection or another open hostname. Search the hostname selector to switch. `chatgpt.com` and `www.chatgpt.com` are intentionally separate; there is no unreliable public-suffix guessing.

**Discard Others** unloads eligible background tabs on the selected hostname. It keeps the current tab and active tabs in every window loaded, and also skips pinned, audible, loading/navigating and `autoDiscardable: false` tabs. If the current tab belongs to another hostname, the popup explicitly explains that only eligible background tabs on the selected hostname will be discarded.

The list shows loaded tabs first. Click a title to switch to that tab and focus its window; selecting a discarded tab reloads it. Use the row's discard button to unload one eligible tab. Hover over an action's result to see skip reasons.

**Show loaded count in toolbar** explicitly monitors the selected hostname. This preference is independent of the current tab and future popup selections. The toolbar tooltip identifies the monitored hostname and exact loaded count; the badge caps at `99+`. Monitoring is off initially. To disable an existing monitor, select its hostname and uncheck the control.

Light and dark appearance follow the operating system. Keyboard navigation and reduced-motion preferences are supported.

## Safety and limitations

- Discarding never closes a tab or changes its URL or group membership. It releases its page from memory. Saved conversations and website-side history are not deleted.
- **Unsaved drafts, form input and in-memory page state may be lost when a tab reloads. Pin tabs with work you need to preserve.**
- The Tabs API does not expose camera, microphone, screen-sharing, presentation or picture-in-picture state. Explicit extension discarding can bypass Chrome's automatic media protections. **Pin tabs used for calls, recording, presenting or silent media before discarding.** No additional permission available here reliably detects every website media session.
- Chrome can refuse a discard. The extension never activates other tabs to work around restrictions. A reported success requires a successful API response and confirmation of `discarded === true` in a fresh snapshot, including when Chrome replaces the tab's internal ID.
- Changes during an operation are rechecked. Newly opened tabs are left for the next operation. Tabs that close, navigate, reload or become protected are skipped. The API provides no atomic transaction between the final eligibility check and discarding; Chrome resolves races after that check.
- Only normal windows and HTTP(S) hostnames are included. Browser-internal, extension and file pages are excluded. Incognito tabs are unavailable unless you explicitly allow the extension in incognito.
- This is a manual utility. It has no automatic discard timers, domain enforcement, session restoration, histories, cloud sync or accounts.

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `tabs` | Read open-tab URLs, titles and lifecycle state for hostname matching and display. Chrome labels this permission “Read your browsing history”; the extension does not call the History API. |
| `storage` | Save only the last manually selected hostname and optional monitored hostname in `chrome.storage.local`. |
| `favicon` | Display icons from Chrome's local favicon cache, without loading website favicon URLs. |

No host permissions, `<all_urls>`, `activeTab`, page injection or content access. No cookies, page contents, credentials or browsing logs are read or stored. The extension's CSP forbids network connections and remote images. Chrome itself and websites can still make their usual requests, including when you explicitly activate a discarded tab.

The small event-driven service worker exists for badge updates and completing user-requested discard batches even if the popup closes. It runs no polling, timers or persistent connections. Relevant tab events coalesce badge updates; no tab query is made for the badge when monitoring is off. Operations use at most four concurrent discard requests. Chrome suspends the worker when idle. The visible popup queries on opening and relevant tab events, using reusable list rows.

API behavior is based on the official [Tabs reference](https://developer.chrome.com/docs/extensions/reference/api/tabs), [favicon guide](https://developer.chrome.com/docs/extensions/how-to/ui/favicons) and [service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). Media limitations are also informed by [Chromium's discard eligibility policy](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc).

## Verify

There are no development dependencies. Optional automated checks require Node 22+; browser checks also require a recent desktop Chrome with the experimental CDP `Extensions.loadUnpacked` and `Extensions.triggerAction` commands.

```sh
node --test tests/core.test.mjs
node tests/browser.mjs
```

The browser suite launches its own disposable headless profile and local HTTP fixtures. It never attaches to your running browser. Set `CHROME_BIN` to choose a Chrome executable and `DISCARDER_TEST_ARTIFACTS` to choose an external screenshot directory. Test timers are confined to the test harness; the extension has none. Headless Chrome can leave an activated discarded tab unloaded; verify automatic reload in a visible window using the checklist below.

Manual acceptance checklist (use disposable pages or saved conversations):

- [ ] One ChatGPT tab: counts `1 / 1 / 0`, current marker, bulk action disabled. Ten tabs: nine discard, the current tab stays loaded. Repeat with tabs spread across three windows; every active tab stays loaded.
- [ ] Include already-discarded, pinned, audible and grouped tabs. Protected rows explain why; counts reflect actual states. Activate a discarded tab: it reloads and the loaded count rises. Pin any camera, microphone or presentation tab before testing.
- [ ] Open, close, move, activate and navigate tabs while the popup is visible and during a batch. Click the bulk action repeatedly; one batch runs. Close the popup during a batch and reopen; actual counts reconcile. Chrome refusals must not count as successes.
- [ ] Switch hostnames, including subdomains, long names and `example.co.uk`. The current-tab label stays distinct. Select another domain: only its eligible background tabs discard.
- [ ] Open on `chrome://extensions`, then test with no HTTP(S) tabs. Fallback and empty states remain usable. Close every tab on the selected hostname: show the empty state.
- [ ] Use Tab, Shift+Tab, arrows, Enter and Escape. Check visible focus, long titles, scrolling with hundreds of tabs, light/dark appearance and reduced motion.
- [ ] Enable a monitor, switch the popup hostname, reload the extension/restart Chrome, discard and reactivate tabs. Badge and tooltip continue to describe the configured monitor. Turn monitoring off: badge clears. No extension errors in `chrome://extensions`.

## Files

`manifest.json`, `popup.html`, `popup.css`, `popup.js`, `core.mjs`, `worker.js` and `icons/` are the entire extension. `tests/` is optional validation. Original SVG and 16/32/48/128-pixel PNGs are included. PNGs were rasterized locally with ImageMagick; loading or developing the extension requires no image conversion tooling.

MIT licensed.
