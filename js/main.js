/* ====================================================================
   POTHOLE PATROL — main.js
   Boot sequence (SDK init + save load behind the loading screen),
   the requestAnimationFrame loop, and all pointer/touch input.
   ==================================================================== */

(function () {
  const canvas = document.getElementById('game-canvas');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  async function boot() {
    PP.UI.init();
    PP.Render.init(canvas);
    bindInput();
    bindWindowEvents();
    requestAnimationFrame(frame);

    PP.UI.showScreen('loading');
    const minSplash = sleep(400);   // brief breath only — get players to the menu fast

    // ================= [SDK INIT] =================
    PP.UI.setLoadStatus('Rallying the fleet…');
    await PP.SDK.init();

    // ================= [LOADING] start ============
    // tell CrazyGames the game is loading (SDK must be inited first)
    PP.SDK.loadingStart();

    // ================= [DATA LOAD] =================
    PP.UI.setLoadStatus('Loading save data…');
    PP.Save.load();
    PP.Audio.setUserMute(PP.Save.data.muted);   // restore the saved sound preference
    PP.Game.setDistrictById(PP.Save.data.district);

    await minSplash;
    PP.UI.setLoadStatus('Painting lane lines…');
    await sleep(80);

    // ================= [LOADING] stop =============
    // loading is done; the menu (and gameplay) is now reachable
    PP.SDK.loadingStop();
    PP.UI.enterMenu();

    // first-run tutorial: hand-holds new players through hiring a truck and
    // unlocking their first district. Leaving mid-tutorial restarts it next
    // load (save.js only persists a "real" save once tutorialDone is set).
    if (PP.Tutorial && !PP.Save.data.tutorialDone) PP.Tutorial.start();
  }

  // ------------------------------------------------------------------
  // Main loop — simulation only advances while effectively playing
  // (not paused by user/ad/menu/portrait/hidden); rendering always runs
  // so the frozen city stays visible behind overlays.
  // ------------------------------------------------------------------
  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (PP.Game.effectivePlaying()) PP.Game.update(dt);
    PP.Game.updateAmbient(dt);   // menu backdrop traffic (no-op during runs)
    PP.Render.draw();
    PP.UI.frame();
    if (PP.Tutorial && PP.Tutorial.active) PP.Tutorial.frame();   // pointer/blocker tracking
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Input: tap a pothole = dispatch nearest truck; tap a truck then a
  // pothole = dispatch that truck; or drag a truck onto a pothole.
  // Pointer events cover both mouse and touch.
  // ------------------------------------------------------------------
  let drag = null;   // { truck, sx, sy, moved }

  function bindInput() {
    canvas.addEventListener('pointerdown', (e) => {
      PP.Audio.unlock();
      if (PP.Game.state !== 'playing' || !PP.Game.effectivePlaying()) return;
      const p = PP.Render.pxToTile(e.clientX, e.clientY);
      const grabR = Math.max(0.5, 26 / PP.Render.ts);

      // grab an idle truck first (drag or select)…
      const truck = PP.Game.idleTruckAt(p.x, p.y, grabR);
      if (truck) {
        drag = { truck, sx: p.x, sy: p.y, moved: false };
        PP.Game.setDrag(truck, p.x, p.y);
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }

      // …otherwise tap a pothole (uses selected truck if any, else nearest)
      const tapR = Math.max(0.55, 28 / PP.Render.ts);
      const hole = PP.Game.potholeAt(p.x, p.y, tapR);
      if (hole) PP.Game.requestDispatch(hole, PP.Game.selectedTruck);
      PP.Game.clearSelection();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = PP.Render.pxToTile(e.clientX, e.clientY);
      if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 0.3) drag.moved = true;
      PP.Game.setDrag(drag.truck, p.x, p.y);
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const p = PP.Render.pxToTile(e.clientX, e.clientY);
      if (drag.moved) {
        const dropR = Math.max(0.9, 30 / PP.Render.ts);
        const hole = PP.Game.potholeAt(p.x, p.y, dropR);
        if (hole) PP.Game.requestDispatch(hole, drag.truck);
        PP.Game.clearSelection();
      } else {
        PP.Game.selectTruck(drag.truck);   // plain tap = select for next tap
        PP.Audio.play('click');
      }
      PP.Game.setDrag(null);
      drag = null;
    });

    canvas.addEventListener('pointercancel', () => {
      PP.Game.setDrag(null);
      drag = null;
    });

    // unlock WebAudio on the first interaction anywhere
    document.addEventListener('pointerdown', () => PP.Audio.unlock(), { passive: true });
    document.addEventListener('keydown', () => PP.Audio.unlock());

    // desktop conveniences
    window.addEventListener('keydown', (e) => {
      if (e.key === 'm' || e.key === 'M') PP.Audio.toggleUserMute();
      if ((e.key === 'p' || e.key === 'P' || e.key === 'Escape') && PP.Game.state === 'playing') {
        const pauseShown = !document.getElementById('overlay-pause').classList.contains('hidden');
        if (pauseShown) {
          document.getElementById('overlay-pause').classList.add('hidden');
          PP.Game.resume('user');
        } else if (PP.Game.effectivePlaying()) {
          PP.Game.pause('user');
          document.getElementById('overlay-pause').classList.remove('hidden');
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Resize / orientation / tab visibility
  // ------------------------------------------------------------------
  function bindWindowEvents() {
    const onResize = () => {
      PP.Render.resize();
      PP.UI.checkOrientation();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 60));

    // auto-pause when the tab is hidden (also fires gameplayStop)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) PP.Game.pause('hidden');
      else PP.Game.resume('hidden');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
