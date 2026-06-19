/* ====================================================================
   POTHOLE PATROL — tutorial.js
   The first-run, hand-held tutorial.

   A pointing-hand cursor (an SVG, see index.html #tut-pointer) shows the
   ONE place the player may tap; a full-screen invisible blocker swallows
   every tap that lands anywhere else, so the player can only follow along.
   Each instruction text box advances ONLY on a tap — never on a timer.

   The script walks the player through:
     1. YOUR FLEET → hire the Basic Truck → deploy it → back to the menu.
     2. START PATROL into a hidden flat-grey "training yard" (a run on
        PP.TUTORIAL_DISTRICT that can't be picked from the patrol menu),
        where ONE scripted pothole teaches dispatching: the truck reaches it
        first and earns a flat $100, then a single text beat explains the
        reputation rule (no staged loss) to keep the tutorial short.
     3. A fade back home → the patrol map → unlock Maple Heights for the
        exact $100 just earned.
   Only at the very end is the save marked tutorialDone — leaving or
   reloading before that restarts the whole tutorial (see save.js).
   ==================================================================== */

PP.Tutorial = (function () {
  const $ = (id) => document.getElementById(id);

  let el = {};
  let active = false;
  let transitioning = false;     // a fade / screen swap is in flight — ignore taps
  let idx = 0;
  let phase = 'active';          // 'active' (awaiting the gated tap) | 'waiting' (a game event)
  let beatT0 = 0;                // run-clock stamp for the short cinematic beats

  // live references to the scripted world objects (assigned as we go)
  let p1 = null, p2 = null;
  let car1 = null, car2 = null;

  const truckRef = () => (PP.Game.run && PP.Game.run.trucks && PP.Game.run.trucks[0]) || null;

  // ---- short cinematic beats run off the run clock so a pause halts them --
  function startBeat() { beatT0 = (PP.Game.run && PP.Game.run.t) || 0; }
  function beatElapsed(sec) { const r = PP.Game.run; return !!r && (r.t - beatT0) >= sec; }

  // ------------------------------------------------------------------
  // Anchors — where the pointer aims and where a "valid" tap may land.
  // A rect anchor: {left,top,right,bottom,cx,cy}. A pothole anchor adds a
  // circular `radius`.
  // ------------------------------------------------------------------
  function domRect(sel) {
    const node = document.querySelector(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
             cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  function potholeRect(getP) {
    const p = getP();
    if (!p || !PP.Game.grid) return null;
    const px = PP.Render.tileToPx(p.x, p.y);
    const radius = Math.max(20, PP.Render.ts * 0.5);
    return { left: px.x - radius, top: px.y - radius, right: px.x + radius, bottom: px.y + radius,
             cx: px.x, cy: px.y, radius };
  }

  // ------------------------------------------------------------------
  // Step actions
  // ------------------------------------------------------------------
  function clickSel(sel) { const n = document.querySelector(sel); if (n) n.click(); }

  // A plain "tap this control" step that forwards the real click on advance.
  function domStep(text, sel, opts) {
    opts = opts || {};
    return Object.assign({
      text,
      anchor: () => domRect(sel),
      onClick: () => clickSel(sel),
    }, opts);
  }

  // ------------------------------------------------------------------
  // The script
  // ------------------------------------------------------------------
  const STEPS = [
    // ---- Phase A: hire + deploy a truck ----------------------------
    domStep("Welcome to Pothole Patrol! First, open YOUR FLEET to manage your trucks.",
            '#btn-garage'),
    domStep("Tap HIRE VEHICLE to see who's for hire.",
            '[data-action="hire-open"]'),
    domStep("Hire the BASIC TRUCK — your dependable first workhorse.",
            '[data-action="hire"]'),
    domStep("Now head back to your fleet.",
            '#btn-hire-back'),
    domStep("Tap DEPLOY so your new truck joins the patrol.",
            '[data-action="toggle-deploy"]'),
    domStep("Looking good. Head back to the menu.",
            '#btn-garage-back'),
    {
      text: "Press START PATROL to begin a quick training shift.",
      anchor: () => domRect('#btn-play'),
      onClick: () => PP.UI.beginTutorialShift(),   // start the hidden training yard, NOT a real run
    },

    // ---- Phase B: the training yard (one quick scripted pothole) ---
    // A pothole opens, a slow car rolls in, the player dispatches the truck
    // (which wins the race). A single follow-up beat banks the $100 and teaches
    // the reputation rule verbally — no second staged "loss" — to keep the
    // run-up to real gameplay short.
    {
      text: null,
      onEnter: () => { p1 = PP.Game.tutorialSpawnPothole(7, 6, -1); startBeat(); },
      autoAdvance: () => beatElapsed(0.8),
    },
    {
      text: null,
      onEnter: () => { car1 = PP.Game.tutorialSpawnCar(6, -1, 1.2); startBeat(); },
      autoAdvance: () => beatElapsed(0.8),
    },
    // Freeze and ask for the dispatch — the truck is close, so it wins.
    {
      text: "A pothole opened and a car's coming! Tap the pothole to send your truck before it gets hit.",
      onEnter: () => PP.Game.pause('tutorial'),
      anchor: () => potholeRect(() => p1),
      onClick: () => { PP.Game.tutorialDispatch(p1, truckRef()); PP.Game.resume('tutorial'); },
      waitFor: () => !!p1 && p1.state === 'patched',
      waitText: "Your truck's on it — it'll patch the hole before the car arrives!",
    },
    // Patched: bank the flat $100 and teach reputation in one beat, then fade home.
    {
      text: "Nice — patched it first for a flat $100! See your REPUTATION bar up top? If a car reaches a pothole before your truck, it costs you rep — let it empty and your shift ends. Speed is everything out there.",
      onEnter: () => { if (p1) PP.Game.tutorialAward(100, p1.x, p1.y); PP.Game.pause('tutorial'); },
      anchor: () => domRect('#hud-rep-wrap'),
      clickAnywhere: true,
      handlesAdvance: true,
      onClick: () => goHome(),
    },

    // ---- Phase C: unlock the first real district -------------------
    domStep("Now let's get you a real district. Open the patrol map.",
            '#btn-menu-district'),
    {
      text: "Unlock MAPLE HEIGHTS — the $100 you just earned covers it exactly!",
      anchor: () => domRect('[data-action="unlock-district"][data-id="maple"]'),
      onClick: () => clickSel('[data-action="unlock-district"][data-id="maple"]'),
      waitFor: () => PP.Save.data.unlocked.includes('maple'),
    },
    {
      text: "That's it — you're trained! Tap START PATROL whenever you're ready. Smooth roads, Chief.",
      onEnter: () => { PP.Save.data.tutorialDone = 1; PP.Save.save(); },   // the tutorial is now durable
      anchor: () => domRect('#btn-travel-play'),
      place: 'top',           // keep the sign-off up top, clear of the patrol list
      clickAnywhere: true,
      handlesAdvance: true,
      onClick: () => finish(),
    },
  ];

  // ------------------------------------------------------------------
  // Step lifecycle
  // ------------------------------------------------------------------
  function enterStep() {
    const step = STEPS[idx];
    if (!step) { finish(); return; }
    phase = 'active';
    if (step.onEnter) step.onEnter();
  }

  function advance() { idx++; enterStep(); }

  // ------------------------------------------------------------------
  // The blocker: every tap funnels through here.
  // ------------------------------------------------------------------
  function onPointerDown(e) {
    if (!active) return;
    e.preventDefault();
    if (transitioning || phase !== 'active') return;
    const step = STEPS[idx];
    if (!step) return;
    if (!step.clickAnywhere && !step.onClick) return;   // a pure cinematic beat — swallow taps

    if (!isValidClick(step, e.clientX, e.clientY)) { nudge(); PP.Audio.play('error'); return; }

    PP.Audio.play('click');
    if (step.onClick) step.onClick();
    if (step.handlesAdvance) return;          // onClick drives its own transition (e.g. fade home)
    if (step.waitFor) { phase = 'waiting'; }  // hold until the game event resolves
    else advance();
  }

  function isValidClick(step, x, y) {
    if (step.clickAnywhere) return true;
    const a = step.anchor && step.anchor();
    if (!a) return false;
    const pad = 18;
    if (a.radius != null) {
      const dx = x - a.cx, dy = y - a.cy, rr = a.radius + pad;
      return dx * dx + dy * dy <= rr * rr;
    }
    return x >= a.left - pad && x <= a.right + pad && y >= a.top - pad && y <= a.bottom + pad;
  }

  function nudge() {
    el.pointer.classList.remove('nudge');
    void el.pointer.offsetWidth;     // restart the animation
    el.pointer.classList.add('nudge');
  }

  // ------------------------------------------------------------------
  // Per-frame: resolve waits / auto-advances, then place the pointer,
  // highlight and text box on the live target (it may scroll or animate).
  // ------------------------------------------------------------------
  function frame() {
    if (!active) return;
    const step = STEPS[idx];
    if (!step) return;

    if (phase === 'waiting') {
      if (!step.waitFor || step.waitFor()) { advance(); return; }
    } else if (phase === 'active' && step.autoAdvance && step.autoAdvance()) {
      advance(); return;
    }
    layout(step);
  }

  function layout(step) {
    const a = (phase === 'active' && step.anchor) ? step.anchor() : null;

    if (a && !transitioning) {
      placePointer(a);
      placeHighlight(a);
      el.pointer.classList.remove('hidden');
      el.highlight.classList.remove('hidden');
    } else {
      el.pointer.classList.add('hidden');
      el.highlight.classList.add('hidden');
    }

    const text = (phase === 'waiting' && step.waitText) ? step.waitText : step.text;
    if (!text || transitioning) { el.textbox.classList.add('hidden'); return; }
    el.text.textContent = text;
    el.hint.style.display = (step.clickAnywhere && phase === 'active') ? '' : 'none';
    placeTextbox(a, step);
    el.textbox.classList.remove('hidden');
  }

  function placePointer(a) {
    const H = window.innerHeight;
    // the hand sits below the target and points up; for targets low on the
    // screen it sits above and points down (so it never runs off the bottom)
    const below = a.cy < H * 0.62;
    const half = a.radius != null ? a.radius : (a.bottom - a.top) / 2;
    const gap = 6;
    const fx = a.cx;
    const fy = below ? a.cy + half + gap : a.cy - half - gap;
    const ox = fx - a.cx, oy = fy - a.cy;
    const rot = Math.atan2(-ox, oy) * 180 / Math.PI;   // finger points from the hand back at the target
    el.pointer.style.left = fx + 'px';
    el.pointer.style.top = fy + 'px';
    el.pointer.style.transform = 'translate(-50%, 0) rotate(' + rot + 'deg)';
  }

  function placeHighlight(a) {
    const s = el.highlight.style;
    if (a.radius != null) {
      const r = a.radius + 8;
      s.left = (a.cx - r) + 'px'; s.top = (a.cy - r) + 'px';
      s.width = (2 * r) + 'px'; s.height = (2 * r) + 'px'; s.borderRadius = '50%';
    } else {
      const pad = 8;
      s.left = (a.left - pad) + 'px'; s.top = (a.top - pad) + 'px';
      s.width = (a.right - a.left + 2 * pad) + 'px';
      s.height = (a.bottom - a.top + 2 * pad) + 'px';
      s.borderRadius = '16px';
    }
  }

  function placeTextbox(a, step) {
    const H = window.innerHeight;
    let atTop = a ? a.cy > H * 0.5 : false;    // target low → text box high (and vice-versa)
    if (step.place === 'top') atTop = true;
    if (step.place === 'bottom') atTop = false;
    el.textbox.style.top = atTop ? '20px' : 'auto';
    el.textbox.style.bottom = atTop ? 'auto' : '26px';
  }

  // ------------------------------------------------------------------
  // The fade back to the home menu (between the training yard and the
  // patrol-map purchase). Triggered by a tap; the fade itself is just an
  // animation, then the next text box waits for a tap as usual.
  // ------------------------------------------------------------------
  function goHome() {
    transitioning = true;
    el.pointer.classList.add('hidden');
    el.highlight.classList.add('hidden');
    el.textbox.classList.add('hidden');

    // bank the training-yard $100 into the real wallet
    PP.Save.data.totalFunds += 100;
    PP.Save.save();

    el.fade.classList.add('show');
    setTimeout(() => {
      PP.Game.resume('tutorial');     // clear the hold
      PP.UI.enterMenu();              // tears down the run, shows the home menu + ambient city
      el.fade.classList.remove('show');
      setTimeout(() => { transitioning = false; advance(); }, 480);
    }, 460);
  }

  // ------------------------------------------------------------------
  // Start / finish
  // ------------------------------------------------------------------
  function start() {
    el = {
      blocker: $('tut-blocker'),
      pointer: $('tut-pointer'),
      highlight: $('tut-highlight'),
      textbox: $('tut-textbox'),
      text: $('tut-text'),
      hint: $('tut-hint'),
      fade: $('tut-fade'),
    };
    if (!el.blocker) return;          // tutorial DOM missing — skip gracefully
    active = true;
    idx = 0;
    phase = 'active';
    p1 = p2 = car1 = car2 = null;
    el.blocker.classList.remove('hidden');
    el.blocker.addEventListener('pointerdown', onPointerDown);
    enterStep();
  }

  function finish() {
    active = false;
    transitioning = false;
    if (el.blocker) {
      el.blocker.removeEventListener('pointerdown', onPointerDown);
      el.blocker.classList.add('hidden');
    }
    el.pointer && el.pointer.classList.add('hidden');
    el.highlight && el.highlight.classList.add('hidden');
    el.textbox && el.textbox.classList.add('hidden');
    el.fade && el.fade.classList.remove('show');
  }

  return { start, frame, finish, get active() { return active; } };
})();
