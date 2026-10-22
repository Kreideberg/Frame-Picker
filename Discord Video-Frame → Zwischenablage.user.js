// ==UserScript==
// @name         Discord Video-Frame → Zwischenablage
// @namespace    https://example.com/discord-video-frame-copy
// @version      1.0.0
// @description  Video in Discord anklicken und den aktuell angezeigten Frame als PNG in die Zwischenablage kopieren (z.B. für Google Lens).
// @match        *://discord.com/*
// @match        *://*.discord.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      discordapp.com
// @connect      discordapp.net
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window.self) return;

  /* ------------------------------------------------------------------ *
   *  Einstellungen
   * ------------------------------------------------------------------ */
  const CONFIG = {
    openLensAfterCopy: false,              // true = Lens immer öffnen; sonst nur bei Shift+Klick
    lensUrl: 'https://lens.google.com/',
    saveFileIfClipboardFails: true,        // PNG speichern, falls die Zwischenablage nicht klappt
    maxFallbackMB: 150,                    // Obergrenze für den Notfall-Download des ganzen Videos
    loadTimeoutMs: 20000,
    fab: { right: 20, bottom: 96 },        // Position des Buttons (px)
  };

  /* ------------------------------------------------------------------ *
   *  Frame -> PNG
   * ------------------------------------------------------------------ */
  function canvasToPng(videoEl) {
    return new Promise((resolve, reject) => {
      try {
        const c = document.createElement('canvas');
        c.width = videoEl.videoWidth;
        c.height = videoEl.videoHeight;
        c.getContext('2d').drawImage(videoEl, 0, 0);
        // wirft SecurityError, wenn die Canvas "tainted" ist (Video ohne CORS)
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Kein Bild erzeugt'))), 'image/png');
      } catch (e) {
        reject(e);
      }
    });
  }

  // Lädt das Video in ein verstecktes <video>, springt zur Zeit und macht den Screenshot
  function frameFromUrl(url, time, cors) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      if (cors) v.crossOrigin = 'anonymous';
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;

      let done = false;
      let timer = null;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeAttribute('src');
        v.load();
        fn(arg);
      };
      timer = setTimeout(() => finish(reject, new Error('Timeout beim Laden des Videos')), CONFIG.loadTimeoutMs);

      v.addEventListener('error', () => finish(reject, new Error('Video konnte nicht geladen werden')));
      v.addEventListener('loadedmetadata', () => {
        const max = isFinite(v.duration) ? v.duration : time;
        v.currentTime = Math.min(Math.max(time, 0.001), max);
      }, { once: true });
      v.addEventListener('seeked', () => {
        canvasToPng(v).then((b) => finish(resolve, b), (e) => finish(reject, e));
      }, { once: true });

      v.src = url;
    });
  }

  // Notfall: ganzes Video per GM_xmlhttpRequest holen (umgeht CORS), dann als blob: abspielen
  function frameViaGM(url, time) {
    return new Promise((resolve, reject) => {
      const maxBytes = CONFIG.maxFallbackMB * 1024 * 1024;
      let req = null;
      req = GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onprogress: (p) => {
          if (p.total > maxBytes && req && req.abort) {
            req.abort();
            reject(new Error('Video zu groß für den Fallback'));
          }
        },
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
          const m = /content-type:\s*([^\r\n;]+)/i.exec(res.responseHeaders || '');
          const objUrl = URL.createObjectURL(new Blob([res.response], { type: m ? m[1].trim() : 'video/mp4' }));
          frameFromUrl(objUrl, time, false)
            .then(resolve, reject)
            .finally(() => URL.revokeObjectURL(objUrl));
        },
        onerror: () => reject(new Error('Netzwerkfehler')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  async function frameToPng(video, url, time) {
    // 1) direkt vom sichtbaren Video (klappt, wenn Discord es mit CORS lädt)
    try {
      return await canvasToPng(video);
    } catch (e) {
      if (!e || e.name !== 'SecurityError') throw e;
    }
    // 2) gleiches Video nochmal mit crossorigin="anonymous" laden (CDN erlaubt CORS)
    try {
      return await frameFromUrl(url, time, true);
    } catch (e) {
      console.warn('[VFC] CORS-Klon fehlgeschlagen, versuche Fallback:', e);
    }
    // 3) Fallback über Tampermonkey
    return frameViaGM(url, time);
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ------------------------------------------------------------------ *
   *  UI (Shadow DOM)
   * ------------------------------------------------------------------ */
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: system-ui, sans-serif; }
      .fab { position: fixed; width: 48px; height: 48px; border-radius: 50%; border: none;
             background: #16a34a; color: #fff; font-size: 22px; cursor: pointer;
             box-shadow: 0 4px 12px rgba(0,0,0,.35); }
      .fab:hover { background: #15803d; }
      .fab.active { background: #dc2626; box-shadow: 0 0 0 4px rgba(220,38,38,.35); }
      .hl { position: fixed; display: none; pointer-events: none; border: 3px solid #16a34a;
            background: rgba(22,163,74,.18); border-radius: 4px; }
      .tip { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: none;
             background: #111827; color: #fff; padding: 8px 14px; border-radius: 8px;
             font-size: 13px; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
      .toast { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); display: none;
               max-width: min(520px, 90vw); background: #1f2937; color: #f3f4f6; padding: 10px 16px;
               border-radius: 8px; font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
      .toast.err { background: #7f1d1d; }
    </style>
    <button class="fab" title="Video-Frame in Zwischenablage kopieren">📸</button>
    <div class="hl"></div>
    <div class="tip">Video anklicken (Shift+Klick = kopieren + Google Lens öffnen) · Esc = Abbrechen</div>
    <div class="toast"></div>
  `;
  document.documentElement.appendChild(host);

  const fab = root.querySelector('.fab');
  const hl = root.querySelector('.hl');
  const tip = root.querySelector('.tip');
  const toastEl = root.querySelector('.toast');
  fab.style.right = CONFIG.fab.right + 'px';
  fab.style.bottom = CONFIG.fab.bottom + 'px';

  let toastTimer = null;
  function toast(msg, isError = false, ms = 4000) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', isError);
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ms);
  }

  /* ------------------------------------------------------------------ *
   *  Video auswählen
   * ------------------------------------------------------------------ */
  let picking = false;

  const videoAt = (x, y) =>
    document.elementsFromPoint(x, y).find((el) => el.tagName === 'VIDEO') || null;
  const fromHost = (e) => e.composedPath().includes(host);

  function onMove(e) {
    const v = videoAt(e.clientX, e.clientY);
    if (!v) { hl.style.display = 'none'; return; }
    const r = v.getBoundingClientRect();
    Object.assign(hl.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px',
    });
  }

  function block(e) {
    if (fromHost(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (fromHost(e)) return;
    block(e);
    const v = videoAt(e.clientX, e.clientY);
    if (!v) { toast('Hier ist kein Video.', true, 2000); return; }
    stopPicking();
    capture(v, e.shiftKey); // synchron im Klick, damit die Zwischenablage-Berechtigung erhalten bleibt
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); stopPicking(); }
  }

  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'];

  function startPicking() {
    if (picking) return;
    picking = true;
    fab.classList.add('active');
    tip.style.display = 'block';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    BLOCKED.forEach((t) => document.addEventListener(t, block, true));
  }

  function stopPicking() {
    picking = false;
    fab.classList.remove('active');
    tip.style.display = 'none';
    hl.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    BLOCKED.forEach((t) => document.removeEventListener(t, block, true));
  }

  /* ------------------------------------------------------------------ *
   *  Screenshot erstellen und kopieren
   * ------------------------------------------------------------------ */
  async function capture(video, withLens = false) {
    if (!video.videoWidth) { toast('Das Video ist noch nicht geladen.', true); return; }

    const url = video.currentSrc || video.src;
    const time = video.currentTime;
    const blobPromise = frameToPng(video, url, time);
    toast('Erzeuge Screenshot …', false, 0);

    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('Clipboard-API nicht verfügbar');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      const openLens = withLens || CONFIG.openLensAfterCopy;
      toast(openLens
        ? '✔ Frame kopiert – Google Lens wurde geöffnet, dort mit Strg+V einfügen'
        : '✔ Frame kopiert – in Google Lens mit Strg+V einfügen');
      if (openLens) GM_openInTab(CONFIG.lensUrl, { active: true });
    } catch (e) {
      console.error('[VFC] Zwischenablage fehlgeschlagen:', e);
      try {
        const blob = await blobPromise;
        if (CONFIG.saveFileIfClipboardFails) {
          saveBlob(blob, `discord_frame_${Date.now()}.png`);
          toast('Zwischenablage nicht möglich – PNG wurde stattdessen gespeichert.', true);
        } else {
          toast('Zwischenablage nicht möglich: ' + (e.message || e), true);
        }
      } catch (e2) {
        console.error('[VFC] Screenshot fehlgeschlagen:', e2);
        toast('Screenshot fehlgeschlagen: ' + (e2.message || e2) + ' (Details in der Konsole, F12)', true, 7000);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   *  Events
   * ------------------------------------------------------------------ */
  fab.addEventListener('click', () => (picking ? stopPicking() : startPicking()));
  GM_registerMenuCommand('Video für Frame-Kopie auswählen', startPicking);
})();
