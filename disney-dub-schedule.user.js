// ==UserScript==
// @name         Disney+ Hebrew dubbing schedule (English on most days)
// @namespace    https://github.com/arbiv/disney-dub-schedule
// @version      2.1.0
// @description  Allows Hebrew audio on Disney+ only on selected weekdays (default Mon and Thu). On other days Hebrew audio rows are hidden and English audio is selected automatically.
// @author       arbiv
// @homepageURL  https://github.com/arbiv/disney-dub-schedule
// @updateURL    https://raw.githubusercontent.com/arbiv/disney-dub-schedule/main/disney-dub-schedule.user.js
// @downloadURL  https://raw.githubusercontent.com/arbiv/disney-dub-schedule/main/disney-dub-schedule.user.js
// @match        https://www.disneyplus.com/*
// @match        https://disneyplus.com/*
// @match        https://*.disneyplus.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * HOW IT WORKS
 *  - A 1 second poll (no MutationObserver, because it does not cross shadow roots) does two things on
 *    restricted days:
 *      A) Hides the Hebrew rows of the audio list whenever it is on screen, and clicks English if Hebrew
 *         is the ticked row (covers a kid opening the panel by hand).
 *      B) On /play/ pages, when the video is playing: wakes the controls, clicks the gear, reads the
 *         current audio language from the "Audio options" menu item, and only if it is Hebrew opens the
 *         list, clicks English and closes the panel. If it is not Hebrew, it just closes the panel.
 *  - If the title has no English audio row, nothing is hidden and nothing is clicked.
 *  - After MAX_ATTEMPTS failures it keeps watching (no clicks) and retries as soon as the gear becomes
 *    visible through real user activity, at most once per OPPORTUNISTIC_COOLDOWN_MS.
 *  - On allowed days the script does nothing (it only un-hides rows it hid earlier).
 *
 * Disney+ structure used (Lit web components, all OPEN shadow roots; many components exist 3 times
 * for responsive layouts and only one is visible, so we always pick the visible one):
 *   gear      : button[data-qa~="settings-modal-control.toggle"]  inside div[role=button][aria-label=הגדרות]
 *   dialog    : .settingsModal-dialog (class only, no role; class suffix is view-main / view-audioSelection ...)
 *   audio item: button.settings-nav-item[data-view="audioSelection"]  (aria-label "אפשרויות שמע, <lang>")
 *   audio list: [role=radiogroup].audio-selection-list > li.audio-selection-list__item
 *               > button.audio-selection-list__button[role=radio][aria-checked] > span.audio-selection-list__label
 *   close     : div[role=button][aria-label=סגירה|Close]
 * The subtitles list (subtitles-selection-list*) is never touched.
 */
(function () {
  'use strict';

  // ===================== CONFIG =====================
  const ALLOWED_DAYS = [1, 4];      // Hebrew dubbing allowed on these days. Date().getDay(): Sun=0, Mon=1 ... Thu=4 ... Sat=6
  const PREFERRED = 'English';      // language to switch to (key of LANGS)
  const BLOCKED = 'Hebrew';         // restricted language on other days (key of LANGS)
  const SHOW_TOAST = true;          // small Hebrew message once per title
  const MUTE_DURING_SWITCH = false;  // mute the video only while switching away from Hebrew
  const MAX_ATTEMPTS = 4;           // failed attempts per title before giving up
  const RETRY_DELAY_MS = 3000;      // wait between failed attempts
  const OPPORTUNISTIC_COOLDOWN_MS = 15000; // after MAX_ATTEMPTS failures: wait this long between extra tries
  const RECHECK_MS = 0;             // re-check the current language this often while playing (0 = never)
  const POLL_MS = 1000;             // main poll
  const DEBUG = false;               // true = log to console (F12)
  const PLAYER_PATH_RE = /\/play\/([^/?#]+)/i;

  const LANGS = {
    English: /^(english|אנגלית)(?![\p{L}])/iu,
    Hebrew: /^(hebrew|עברית)(?![\p{L}])/iu,
  };
  const AD_RE = /audio description|תיאור/i;   // audio-description tracks are never auto-picked
  const TOAST_TEXT = 'היום האודיו באנגלית. דיבוב בעברית רק בימי שני וחמישי.';

  // Selectors (see structure above)
  const SEL = {
    gearButton: 'button[data-qa*="settings-modal-control.toggle"]',
    gearFallback: '[role="button"][aria-label="הגדרות"], [role="button"][aria-label="Settings"]',
    dialog: '.settingsModal-dialog, [class*="settingsModal-dialog"]',
    audioNav: 'button.settings-nav-item[data-view="audioSelection"], [data-qa*="main-settings-view.audioNavItem"]',
    audioRow: 'li.audio-selection-list__item',
    closeBtn: 'div[role="button"][aria-label="סגירה"], div[role="button"][aria-label="Close"]',
  };
  // ==================================================

  const LOG = (...a) => { if (DEBUG) console.debug('[DubSchedule]', ...a); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Today's weekday. TEST OVERRIDE: in the browser console (F12) on disneyplus.com run
  //   localStorage.setItem('dubScheduleFakeDay','1')   // pretend it is Monday (0=Sun ... 6=Sat)
  //   localStorage.removeItem('dubScheduleFakeDay')    // back to the real day
  // The change is picked up within about a second, no reload needed.
  let lastLoggedDay = null;
  function today() {
    let day = new Date().getDay();
    let fake = false;
    try {
      const f = localStorage.getItem('dubScheduleFakeDay');
      if (f !== null && /^[0-6]$/.test(f.trim())) { day = Number(f.trim()); fake = true; }
    } catch (e) { /* localStorage unavailable: use the real day */ }
    if (DEBUG && day !== lastLoggedDay) { lastLoggedDay = day; LOG('using day', day, fake ? '(fake)' : '(real)'); }
    return day;
  }
  const isRestrictedDay = () => !ALLOWED_DAYS.includes(today());
  const norm = (s) => (s || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();

  // ---------- shadow-DOM aware query ----------
  // Like querySelectorAll, but also searches inside every open shadow root.
  function deepQuery(selector, root, out) {
    root = root || document;
    out = out || [];
    root.querySelectorAll(selector).forEach((e) => out.push(e));
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) deepQuery(selector, e.shadowRoot, out); });
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const firstVisible = (selector) => deepQuery(selector).find(isVisible) || null;

  // Pointer + mouse events + click (some Lit/React handlers ignore a bare click()).
  function realClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    try {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => {
        const C = t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new C(t, opts));
      });
      el.click();
    } catch (e) { LOG('click failed', e); }
  }

  async function waitFor(fn, timeout = 2500, step = 150) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 >= timeout) return null;
      await sleep(step);
    }
  }

  // ---------- audio list helpers ----------
  const rowLabel = (li) => {
    const s = li.querySelector('.audio-selection-list__label');
    return norm(s ? s.textContent : li.textContent);
  };
  const rowButton = (li) => li.querySelector('button.audio-selection-list__button') || li.querySelector('button') || li;
  const rowChecked = (li) => {
    const b = rowButton(li);
    return !!b && b.getAttribute('aria-checked') === 'true';
  };
  const isKind = (label, lang) => !!LANGS[lang] && LANGS[lang].test(label);

  // Groups all audio rows by their <ul>. Returns [{list, rows, blocked:[li], preferred:[li]}].
  function audioGroups() {
    const map = new Map();
    deepQuery(SEL.audioRow).forEach((li) => {
      const list = li.parentNode;
      if (!list) return;
      let g = map.get(list);
      if (!g) { g = { list, rows: [], blocked: [], preferred: [] }; map.set(list, g); }
      g.rows.push(li);
      const label = rowLabel(li);
      if (isKind(label, BLOCKED)) g.blocked.push(li);
      else if (isKind(label, PREFERRED) && !AD_RE.test(label)) g.preferred.push(li);
    });
    return Array.from(map.values());
  }

  // ---------- A) hide Hebrew rows, switch if Hebrew is ticked ----------
  let busy = false;                 // true while the playback routine is clicking
  let lastListClick = 0;
  const recentSwitches = [];
  let hid = false;

  function hideRow(li) {
    if (li.dataset.ddsHidden === '1') return;
    li.dataset.ddsHidden = '1';
    li.style.setProperty('display', 'none', 'important');
    hid = true;
    LOG('hid', rowLabel(li));
  }

  function unhideAll() {
    deepQuery('[data-dds-hidden="1"]').forEach((el) => {
      el.style.removeProperty('display');
      delete el.dataset.ddsHidden;
    });
    hid = false;
  }

  // Returns true if an audio list is currently present (so the poll can speed up).
  function handleLists() {
    const groups = audioGroups();
    for (const g of groups) {
      if (!g.preferred.length || !g.blocked.length) continue; // no English, or no Hebrew: leave alone
      g.blocked.forEach(hideRow);
      if (!busy && g.blocked.some(rowChecked) && isVisible(g.list)) {
        const now = Date.now();
        while (recentSwitches.length && now - recentSwitches[0] > 60000) recentSwitches.shift();
        if (now - lastListClick > 3000 && recentSwitches.length < 6) {
          lastListClick = now;
          recentSwitches.push(now);
          const target = g.preferred.find(isVisible) || g.preferred[0];
          LOG('Hebrew ticked, clicking English');
          realClick(rowButton(target));
          showToast(currentKey() || 'page');
        }
      }
    }
    return groups.length > 0;
  }

  // ---------- B) playback routine ----------
  const states = new Map();   // key -> {done, noEnglish, lastOk, attempts, nextTry}
  const toasted = new Set();
  let running = false;

  const currentKey = () => { const m = PLAYER_PATH_RE.exec(location.pathname); return m ? m[1] : null; };

  function findPlayingVideo() {
    return deepQuery('video').find((v) => !v.paused && !v.ended && v.readyState >= 2) || null;
  }

  // Deepest element under a point, following open shadow roots.
  function deepElementFromPoint(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 12 && el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function'; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Controls only exist after mouse movement over the player: fake a mouse entering and moving over the
  // centre of the video, on every element Disney+ might listen on, plus a Shift key press as a fallback.
  function wakeControls(video) {
    const r = video.getBoundingClientRect();
    const big = r.width > 0 && r.height > 0;
    const jitter = () => Math.round((Math.random() - 0.5) * 8);
    const x = (big ? r.left + r.width / 2 : window.innerWidth / 2) + jitter();
    const y = (big ? r.top + r.height / 2 : window.innerHeight / 2) + jitter();
    const targets = [
      deepElementFromPoint(x, y),
      firstVisible('pointer-actions') || deepQuery('pointer-actions')[0],
      firstVisible('disney-web-player-ui') || deepQuery('disney-web-player-ui')[0],
      firstVisible('disney-web-player') || deepQuery('disney-web-player')[0],
      firstVisible('dwp-player-everywhere') || deepQuery('dwp-player-everywhere')[0],
      video,
      document,
    ].filter((t, i, arr) => t && arr.indexOf(t) === i);
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
      pointerType: 'mouse', pointerId: 1, isPrimary: true, view: window };
    const types = ['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mousemove'];
    targets.forEach((t) => types.forEach((type) => {
      try {
        const C = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        t.dispatchEvent(new C(type, init));
      } catch (e) { /* ignore */ }
    }));
    const host = targets.find((t) => t.tagName === 'DISNEY-WEB-PLAYER') || targets[0];
    ['keydown', 'keyup'].forEach((type) => {
      try { host.dispatchEvent(new KeyboardEvent(type, { key: 'Shift', code: 'ShiftLeft', bubbles: true, composed: true })); } catch (e) { /* ignore */ }
    });
  }

  // The visible gear: the inner toggle button, with its parent div[role=button].
  function findGear() {
    const btn = firstVisible(SEL.gearButton);
    if (btn) return { inner: btn, outer: btn.closest('[role="button"]') || btn.parentElement || btn };
    const div = deepQuery(SEL.gearFallback).filter((e) => !e.classList.contains('settings-main-menu')).find(isVisible);
    return div ? { inner: div.querySelector('button') || div, outer: div } : null;
  }

  // Click the inner button (bubbles to the div). goal = 'open' | 'closed' (state of the settings dialog).
  // The outer div is clicked a second time ONLY if, after waiting, the dialog is still confirmed in the
  // old state. (The gear is a toggle: a second click while the dialog is still opening would close it.)
  async function press(target, goal) {
    const ok = () => (goal === 'open' ? dialogOpen() : !dialogOpen());
    realClick(target.inner);
    if (await waitFor(ok, 1800, 100)) return true;
    await sleep(500);                                  // let animations settle, then re-confirm
    if (ok()) return true;
    if (target.outer && target.outer !== target.inner) {
      LOG('no state change after click, trying outer div');
      realClick(target.outer);
      return !!(await waitFor(ok, 1800, 100));
    }
    return false;
  }

  const dialogOpen = () => !!firstVisible(SEL.dialog);
  const audioNavItem = () => firstVisible(SEL.audioNav);

  // "אפשרויות שמע, עברית" or the sublabel span -> "עברית"
  function currentAudioLanguage(nav) {
    const sub = nav.querySelector('.settings-nav-item__sublabel');
    let lang = sub ? norm(sub.textContent) : '';
    if (!lang) {
      const parts = norm(nav.getAttribute('aria-label')).split(',');
      lang = parts.length > 1 ? norm(parts.slice(1).join(',')) : '';
    }
    return lang;
  }

  async function closePanel() {
    if (!dialogOpen()) return;
    const closeDiv = firstVisible(SEL.closeBtn);
    if (closeDiv) {
      await press({ inner: closeDiv.querySelector('button') || closeDiv, outer: closeDiv }, 'closed');
    }
    if (dialogOpen()) {
      const gear = findGear();
      if (gear) await press(gear, 'closed');
    }
    if (dialogOpen()) LOG('could not close the panel');
  }

  // One attempt. Returns 'done' | 'no-english' | 'retry' | 'skip'.
  async function attemptOnce(video) {
    if (dialogOpen()) return 'skip';          // the user has the panel open: do not interfere

    // 1) open settings (wake the controls first, retry for a few seconds)
    let gear = findGear();
    for (let t0 = Date.now(); !gear && Date.now() - t0 < 8000;) {   // up to ~8 s per attempt
      wakeControls(video);
      gear = await waitFor(findGear, 700, 100);
    }
    if (!gear) { LOG('gear not found'); return 'retry'; }
    if (!(await press(gear, 'open'))) { LOG('settings did not open'); return 'retry'; }

    // 2) read the current audio language
    const nav = await waitFor(audioNavItem, 2500);
    if (!nav) { LOG('audio menu item not found'); await closePanel(); return 'retry'; }
    const lang = currentAudioLanguage(nav);
    LOG('current audio:', lang);
    if (lang && !isKind(lang, BLOCKED)) { await closePanel(); return 'done'; }

    // 3) Hebrew (or unknown): open the list and pick English
    let prevMuted = video.muted;
    try {
      if (MUTE_DURING_SWITCH && !prevMuted) video.muted = true;
      realClick(nav);
      const groups = await waitFor(() => {
        const gs = audioGroups().filter((g) => g.list.isConnected && isVisible(g.list));
        return gs.length ? gs : null;
      }, 2500);
      if (!groups) { await closePanel(); return 'retry'; }
      const g = groups[0];
      if (!g.preferred.length) { await closePanel(); return 'no-english'; }   // title has no English audio
      g.blocked.forEach(hideRow);
      const english = g.preferred.find(isVisible) || g.preferred[0];
      if (!rowChecked(english)) {
        LOG('clicking English');
        realClick(rowButton(english));
        await sleep(800);
      }
      await closePanel();
      return 'done';
    } finally {
      if (MUTE_DURING_SWITCH && !prevMuted && video.muted) video.muted = false;
    }
  }

  function showToast(key) {
    if (!SHOW_TOAST || toasted.has(key)) return;
    toasted.add(key);
    try {
      const host = document.fullscreenElement || document.body;
      const d = document.createElement('div');
      d.textContent = TOAST_TEXT;
      d.dir = 'rtl';
      d.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:rgba(0,0,0,.85);color:#fff;padding:10px 18px;border-radius:10px;font:600 16px Arial,sans-serif;' +
        'pointer-events:none;transition:opacity .5s;opacity:1;';
      host.appendChild(d);
      setTimeout(() => { d.style.opacity = '0'; }, 5000);
      setTimeout(() => d.remove(), 5600);
    } catch (e) { LOG('toast failed', e); }
  }

  async function playbackStep() {
    const key = currentKey();
    if (!key || running) return;
    const video = findPlayingVideo();
    if (!video) return;
    const now = Date.now();
    let st = states.get(key);
    if (!st) { st = { done: false, noEnglish: false, lastOk: 0, attempts: 0, nextTry: 0 }; states.set(key, st); }
    if (st.noEnglish) return;
    if (st.done && (!RECHECK_MS || now - st.lastOk < RECHECK_MS)) return;
    if (!st.done) {
      if (now < st.nextTry) return;                       // cooldown always respected
      // Normal path: up to MAX_ATTEMPTS. Opportunistic path (no clicks until it triggers): a visible gear
      // means the user is active, so the controls exist and we can switch without waking anything.
      if (st.attempts >= MAX_ATTEMPTS && !findGear()) return;
    }

    running = busy = true;
    try {
      const res = await attemptOnce(video);
      LOG('attempt result:', res);
      if (res === 'done') { st.done = true; st.lastOk = Date.now(); st.attempts = 0; showToast(key); }
      else if (res === 'no-english') { st.done = true; st.noEnglish = true; }
      else if (res === 'skip') { st.nextTry = Date.now() + 2000; }            // user has the panel open: look again soon
      else { st.attempts++; st.nextTry = Date.now() + (st.attempts >= MAX_ATTEMPTS ? OPPORTUNISTIC_COOLDOWN_MS : RETRY_DELAY_MS); }
    } catch (e) {
      LOG('attempt error', e);
      st.attempts++; st.nextTry = Date.now() + (st.attempts >= MAX_ATTEMPTS ? OPPORTUNISTIC_COOLDOWN_MS : RETRY_DELAY_MS);
    } finally {
      running = busy = false;
    }
  }

  // ---------- main loop ----------
  let fastTimer = null;
  function tick() {
    try {
      if (!isRestrictedDay()) {
        // Allowed day: make sure nothing we hid earlier stays hidden (e.g. after switching the fake day).
        if (hid || deepQuery('[data-dds-hidden="1"]').length) unhideAll();
        return;
      }
      const listPresent = handleLists();
      // While an audio list is on screen, re-check quickly so Hebrew never stays visible for long.
      if (listPresent && !fastTimer) {
        fastTimer = setTimeout(() => { fastTimer = null; tick(); }, 250);
      }
      playbackStep();
    } catch (e) { LOG('tick error', e); }
  }

  setInterval(tick, POLL_MS);
  tick();
  LOG('started. restricted today:', isRestrictedDay());

  // Troubleshooting handle (F12 console): DisneyDubSchedule.groups(), DisneyDubSchedule.tick()
  window.DisneyDubSchedule = { tick, groups: audioGroups, restricted: isRestrictedDay, today, states };
})();
