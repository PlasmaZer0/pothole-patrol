/* ====================================================================
   POTHOLE PATROL — ui.js
   Everything DOM: screens, HUD, modals, toasts, the orientation
   blocker, the mock-ad overlay and the debug panel.

   Screens: loading, menu, Your Fleet (hire / deploy / upgrade), the Hire
   carousel, per-vehicle upgrades, Travel (select / unlock districts), plus
   the in-run HUD, pause, summary and overlays.

   Ad-flow entry points in this file:
     - Summary "2× CASH"       -> [AD] REWARDED (doubles the run, then straight home)
     - Summary "CONTINUE"      -> [AD] MIDGAME (between runs)
     - "FIX ALL POTHOLES" btn  -> [AD] REWARDED (in-run, fix every pothole)
     - "WATCH AD -> $500" btn  -> [AD] REWARDED (home screen, funds boost)
   ==================================================================== */

PP.UI = (function () {
  const E = PP.CONFIG.ECON;
  const $ = (id) => document.getElementById(id);

  // Inline SVG icons (replacing emoji, which render differently per device).
  // They draw in `currentColor`, so the host element's text colour controls them.
  const ICON = {
    speakerOn: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    speakerOff: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 10.5v6M14 10.5v6"/></svg>',
    pencil: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>',
    lock: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    pin: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>',
  };
  PP.ICONS = ICON;

  let el = {};
  const last = {};   // change-detection cache so we touch the DOM sparingly

  // set textContent only when the value actually changed
  function setText(key, node, value) {
    if (last[key] === value) return;
    last[key] = value;
    node.textContent = value;
  }

  // ------------------------------------------------------------------
  function init() {
    el = {
      screens: {
        loading: $('screen-loading'),
        menu: $('screen-menu'),
        garage: $('screen-garage'),
        hire: $('screen-hire'),
        vehicle: $('screen-vehicle'),
        travel: $('screen-travel'),
      },
      loadStatus: $('load-status'),

      menuTotalFunds: $('menu-total-funds'),
      menuBestPatched: $('menu-best-patched'),
      menuBestCombo: $('menu-best-combo'),
      menuDistrictName: $('menu-district-name'),
      menuLocationName: $('menu-location-name'),
      menuNextUnlock: $('menu-next-unlock'),
      debugBadge: $('debug-badge'),

      dailyReturn: $('daily-return'),
      drStreak: $('dr-streak'),
      drBonus: $('dr-bonus'),

      garageFunds: $('garage-funds'),
      fleetGrid: $('fleet-grid'),
      fleetDeployCount: $('fleet-deploy-count'),
      fleetDeployCap: $('fleet-deploy-cap'),
      fleetDeployWhere: $('fleet-deploy-where'),

      hireFunds: $('hire-funds'),
      hireArt: $('hire-art'),
      hireInfo: $('hire-info'),
      hireDots: $('hire-dots'),

      vehTitle: $('veh-title'),
      vehSub: $('veh-sub'),
      vehFunds: $('veh-funds'),
      vehArt: $('veh-art'),
      vehBlurb: $('veh-blurb'),
      vehUpgrades: $('veh-upgrades'),

      travelFunds: $('travel-funds'),
      locationList: $('location-list'),

      hudFunds: $('hud-funds'),
      hudComboChip: $('hud-combo-chip'),
      hudCombo: $('hud-combo'),
      hudTrucks: $('hud-trucks'),
      hudDistrict: $('hud-district'),
      hudRepFill: $('hud-rep-fill'),
      hudRepWrap: $('hud-rep-wrap'),
      btnReward: $('btn-reward'),
      btnMenuAd: $('btn-menu-ad'),

      overlayPause: $('overlay-pause'),
      screenSummary: $('screen-summary'),
      sumFlavor: $('sum-flavor'),
      sumPatched: $('sum-patched'),
      sumFunds: $('sum-funds'),
      sumCombo: $('sum-combo'),
      sumTime: $('sum-time'),
      sumBest: $('sum-best'),
      btnDouble: $('btn-double'),
      btnContinue: $('btn-continue'),
      sumNext: $('sum-next'),

      overlayMockad: $('overlay-mockad'),
      mockadCount: $('mockad-count'),
      mockadType: $('mockad-type'),
      toast: $('toast'),

      vehicleUnlock: $('vehicle-unlock'),
      vuArtColor: $('vu-art-color'),
      vuArtBlack: $('vu-art-black'),
      vuShackle: $('vu-shackle'),
      vuName: $('vu-name'),

      muteButtons: [$('btn-mute-menu'), $('btn-mute-hud'), $('btn-mute-pause')],
    };

    bindEvents();
    updateMuteUI();   // populate the speaker icons (all three mute buttons)
    if (PP.DEBUG) {
      document.body.classList.add('debug');
      el.debugBadge.classList.remove('hidden');
      $('debug-panel').classList.remove('hidden');
    }
    checkOrientation();
  }

  function bindEvents() {
    $('btn-play').addEventListener('click', () => { PP.Audio.play('click'); startGame(); });
    el.dailyReturn.addEventListener('click', () => { PP.Audio.play('click'); dismissDailyReturn(); });
    $('btn-garage').addEventListener('click', () => { PP.Audio.play('click'); showFleet(); });
    $('btn-garage-back').addEventListener('click', () => { PP.Audio.play('click'); enterMenu(); });
    $('btn-hire-back').addEventListener('click', () => { PP.Audio.play('click'); showFleet(); });
    $('btn-vehicle-back').addEventListener('click', () => { PP.Audio.play('click'); showFleet(); });

    // ---- travel screen: select / unlock districts --------------------
    $('btn-menu-district').addEventListener('click', () => { PP.Audio.play('click'); showTravel(); });
    $('btn-travel-back').addEventListener('click', () => { PP.Audio.play('click'); enterMenu(); });
    $('btn-travel-play').addEventListener('click', () => { PP.Audio.play('click'); startGame(); });
    el.screens.travel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      handleDistrictAction(btn.dataset.action, btn.dataset.id);
    });

    // ---- pause ----
    $('btn-pause').addEventListener('click', () => {
      if (PP.Game.state !== 'playing') return;
      PP.Audio.play('click');
      PP.Game.pause('user');
      el.overlayPause.classList.remove('hidden');
    });
    $('btn-resume').addEventListener('click', () => {
      PP.Audio.play('click');
      el.overlayPause.classList.add('hidden');
      PP.Game.resume('user');
    });
    $('btn-abandon').addEventListener('click', () => {
      PP.Audio.play('click');
      el.overlayPause.classList.add('hidden');
      PP.Game.endRun();    // banks funds + shows the summary
    });

    // ---- [MUTE] manual mute toggle (one of the three mute sources) ----
    // the toggle is saved as a preference so it sticks between sessions
    for (const b of el.muteButtons) {
      b.addEventListener('click', () => {
        const muted = PP.Audio.toggleUserMute();
        PP.Save.data.muted = muted ? 1 : 0;
        PP.Save.save();
        PP.Audio.play('click');
      });
    }

    // ---- summary "2× CASH" -> [AD] REWARDED -> double this run's cash,
    // then STRAIGHT to the main menu (no midgame ad on this path) ----------
    el.btnDouble.addEventListener('click', () => {
      if (el.btnDouble.disabled) return;
      PP.Audio.play('click');
      el.btnDouble.disabled = true;
      el.btnContinue.disabled = true;
      // ============ [AD] REWARDED: doubles the cash earned this run ============
      PP.SDK.requestRewardedAd({
        onReward: () => {
          PP.Save.data.totalFunds += summaryFunds;   // a second helping = 2× the run
          PP.Save.save();                            // [DATA SAVE] doubled cash banked
          PP.Audio.play('reward');
          toast('CASH DOUBLED TO +$' + (summaryFunds * 2));
        },
        onDone: () => {                              // reward or not, head home (no midgame ad)
          el.btnDouble.disabled = false;
          el.btnContinue.disabled = false;
          el.screenSummary.classList.add('hidden');
          enterMenu();
        },
      });
    });

    // ---- summary "continue" -> [AD] MIDGAME -> main menu ------------------
    el.btnContinue.addEventListener('click', () => {
      PP.Audio.play('click');
      el.btnContinue.disabled = true;
      el.btnDouble.disabled = true;
      // ============== [AD] MIDGAME: shown between runs ==============
      PP.SDK.requestMidgameAd(() => {
        el.btnContinue.disabled = false;
        el.btnDouble.disabled = false;
        el.screenSummary.classList.add('hidden');
        enterMenu();
      });
    });

    // ---- rewarded-ad flow (single reward: emergency crew fixes all) ----
    el.btnReward.addEventListener('click', () => {
      const run = PP.Game.run;
      if (PP.Game.state !== 'playing' || !run || run.adCd > 0) return;
      PP.Audio.play('click');
      PP.Game.pause('menu');             // hold the game while the ad loads
      // ============ [AD] REWARDED: fix every pothole on the map ============
      // (reward granted only on adFinished — see js/sdk.js)
      PP.SDK.requestRewardedAd({
        onReward: () => {
          PP.Game.grantInstantRepair();
          PP.Game.setAdCooldown(E.rewardCooldown);
        },
        onDone: () => PP.Game.resume('menu'),
      });
    });

    // ---- home-screen rewarded ad: funds boost (scales with location) ----
    // Reward amount grows with the current location (prices rise). After a
    // successful claim the button hides for the rest of the menu session;
    // finishing a run restores it (see PP.Game.endRun -> adClaimed = 0).
    el.btnMenuAd.addEventListener('click', () => {
      const sv = PP.Save.data;
      if (sv.adClaimed) return;
      PP.Audio.play('click');
      el.btnMenuAd.disabled = true;
      const reward = PP.adRewardFor(sv.district);
      // ============ [AD] REWARDED: city funds boost from the menu ============
      PP.SDK.requestRewardedAd({
        onReward: () => {
          sv.totalFunds += reward;
          sv.adClaimed = 1;              // one claim per round
          PP.Save.save();                // [DATA SAVE] ad reward banked
          refreshMeta();                 // hides the button (adClaimed)
          PP.Audio.play('reward');
          toast('+$' + reward + ' CASH!');
        },
        onDone: () => { el.btnMenuAd.disabled = false; },
      });
    });

    // ---- Your Fleet grid (delegated): hire / upgrade / deploy ----------
    el.screens.garage.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const a = btn.dataset.action;
      if (a === 'hire-open') { PP.Audio.play('click'); showHire(); }
      else if (a === 'open-upgrade') { PP.Audio.play('click'); showVehicle(+btn.dataset.idx); }
      else if (a === 'toggle-deploy') toggleDeploy(+btn.dataset.idx);
      else if (a === 'rename') { PP.Audio.play('click'); renamingIdx = +btn.dataset.idx; renderFleet(); }
      else if (a === 'sell') sellVehicle(+btn.dataset.idx);
    });

    // ---- Hire carousel (delegated): browse / hire ---------------------
    el.screens.hire.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const a = btn.dataset.action;
      if (a === 'carousel-prev') { carouselIdx = (carouselIdx - 1 + PP.VEHICLES.length) % PP.VEHICLES.length; PP.Audio.play('click'); renderHire(); }
      else if (a === 'carousel-next') { carouselIdx = (carouselIdx + 1) % PP.VEHICLES.length; PP.Audio.play('click'); renderHire(); }
      else if (a === 'hire') hireVehicle();
    });

    // ---- Per-vehicle upgrades (delegated) -----------------------------
    el.screens.vehicle.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      if (btn.dataset.action.indexOf('buy-upgrade:') === 0) buyUpgrade(btn.dataset.action.split(':')[1]);
    });

    // ---- debug panel ----------------------------------------------------
    if (PP.DEBUG) {
      $('dbg-mute').addEventListener('click', () => PP.SDK.debugToggleSettingsMute());
      $('dbg-funds').addEventListener('click', () => {
        PP.Save.data.totalFunds += 500;
        PP.Save.save();
        toast('+$500 (debug)');
        refreshMeta();
      });
      $('dbg-spawn').addEventListener('click', () => PP.Game.debugSpawnPothole());
      $('dbg-end').addEventListener('click', () => PP.Game.debugEndRun());
      $('dbg-wipe').addEventListener('click', () => {
        PP.Save.reset();
        toast('SAVE WIPED');
        refreshMeta();
      });
    }
  }

  // ------------------------------------------------------------------
  // Screens
  // ------------------------------------------------------------------
  function showScreen(name) {
    for (const key of Object.keys(el.screens)) {
      el.screens[key].classList.toggle('show', key === name);
    }
    document.body.classList.toggle('playing', name === null);
  }

  function setLoadStatus(text) { el.loadStatus.textContent = text; }

  function refreshMeta() {
    const sv = PP.Save.data;
    setTextRaw(el.menuTotalFunds, '$' + sv.totalFunds);
    setTextRaw(el.menuBestPatched, sv.best.patched);
    setTextRaw(el.menuBestCombo, '×' + sv.best.combo);
    const d = PP.districtById(sv.district) || PP.DISTRICTS[0];
    setTextRaw(el.menuDistrictName, d.name);
    setTextRaw(el.menuLocationName, d.locationName);

    // near-term goal: cash remaining to the next district unlock (a visible
    // carrot so returning players always see what they're working toward)
    const nextD = PP.ALL_MAPS ? null : PP.nextLockedDistrict(sv.unlocked);
    if (nextD) {
      const remain = Math.max(0, nextD.cost - sv.totalFunds);
      el.menuNextUnlock.textContent = remain <= 0
        ? '✓ READY — UNLOCK ' + nextD.name
        : '$' + remain + ' TO ' + nextD.name;
      el.menuNextUnlock.classList.toggle('ready', remain <= 0);
      el.menuNextUnlock.classList.remove('hidden');
    } else {
      el.menuNextUnlock.classList.add('hidden');
    }

    // home-screen ad button: amount scales with location; hidden once claimed
    const reward = PP.adRewardFor(sv.district);
    setTextRaw(el.btnMenuAd, '$' + reward);   // square play-button; the $amount sits on top
    el.btnMenuAd.classList.toggle('hidden', !!sv.adClaimed);

    if (el.screens.garage.classList.contains('show')) renderFleet();
    if (el.screens.hire.classList.contains('show')) renderHire();
    if (el.screens.vehicle.classList.contains('show')) renderVehicle();
    if (el.screens.travel.classList.contains('show')) renderTravel();
  }
  function setTextRaw(node, v) { node.textContent = v; }

  function enterMenu() {
    PP.Game.toMenu();
    PP.Game.startAmbient();   // last-played district idles behind the menu
    showScreen('menu');
    refreshMeta();
    updateMuteUI();
    PP.Audio.setMusic('menu');   // [MUSIC] menu theme
    checkDailyReturn();          // once-per-day "welcome back" streak + bonus
  }

  // ------------------------------------------------------------------
  // Daily-return streak: once per calendar day, a returning player gets a
  // small escalating cash bonus and a celebratory popup — a reason to come
  // back tomorrow (lifts D1 retention). Self-gates on the stored day-number.
  // ------------------------------------------------------------------
  function dayNumber() {
    const d = new Date();   // local calendar date → stable int (consecutive days differ by 1)
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

  function checkDailyReturn() {
    const sv = PP.Save.data;
    if (!sv.tutorialDone) return;             // established players only
    const today = dayNumber();
    if (sv.lastPlayedDay === today) return;   // already counted today
    const prev = sv.lastPlayedDay || 0;
    const returning = prev > 0;               // had a prior play-day (not first ever)
    sv.streak = (prev === today - 1) ? (sv.streak || 0) + 1 : 1;   // consecutive vs. reset
    sv.lastPlayedDay = today;
    const bonus = returning ? Math.min(300, 60 * sv.streak) : 0;   // small, capped
    if (bonus > 0) sv.totalFunds += bonus;
    PP.Save.save();                           // [DATA SAVE] streak + bonus persisted
    refreshMeta();
    if (returning) showDailyReturn(sv.streak, bonus);
  }

  let dailyTimer = null;
  function showDailyReturn(streak, bonus) {
    el.drStreak.textContent = 'DAY ' + streak + ' STREAK';
    if (bonus > 0) { el.drBonus.textContent = '+$' + bonus; el.drBonus.classList.remove('hidden'); }
    else el.drBonus.classList.add('hidden');
    el.dailyReturn.classList.remove('hidden');
    PP.Audio.play('daily');
    clearTimeout(dailyTimer);
    dailyTimer = setTimeout(dismissDailyReturn, 5000);   // auto-dismiss after 5s
  }
  function dismissDailyReturn() {
    clearTimeout(dailyTimer);
    el.dailyReturn.classList.add('hidden');
  }

  function showFleet() {
    PP.Game.toMenu();
    if (!PP.Game.ambient) PP.Game.startAmbient();   // city idles behind Your Fleet too
    showScreen('garage');
    renderFleet();
    PP.Audio.setMusic('menu');   // [MUSIC] stay on the menu theme
  }

  let allMapsNoticed = false;
  function showTravel() {
    PP.Game.toMenu();
    if (!PP.Game.ambient) PP.Game.startAmbient();   // city idles behind the picker too
    showScreen('travel');
    renderTravel();
    PP.Audio.setMusic('menu');   // [MUSIC] stay on the menu theme
    if (PP.ALL_MAPS && !allMapsNoticed) {
      allMapsNoticed = true;
      toast('PREVIEW MODE — ALL MAPS UNLOCKED (NOT SAVED)', 3.5);
    }
  }

  function startGame() {
    PP.Game.setDistrictById(PP.Save.data.district);
    if (PP.Game.deployableCount() < 1) {     // nothing fielded here — hire/deploy first
      PP.Audio.play('error');
      const owns = PP.Save.data.fleet.length > 0;
      toast(owns ? 'DEPLOY AT LEAST ONE VEHICLE TO PLAY!' : 'HIRE & DEPLOY A VEHICLE FIRST!', 3);
      showFleet();
      return;
    }
    showScreen(null);            // body.playing -> HUD visible
    PP.Game.startRun();
    PP.Audio.setMusic('game');   // [MUSIC] crossfade to the gameplay theme
    el.btnReward.classList.remove('hidden');   // reward button available at run start
    el.btnReward.disabled = false;
    last.adCd = 0;
    el.hudDistrict.textContent = PP.Game.district.name;
  }

  // Enter the tutorial's training-yard shift: same in-run HUD as a real run,
  // but on the hidden TUTORIAL_DISTRICT and with the in-run rewarded-ad button
  // suppressed (the tutorial gates every tap). Driven by PP.Tutorial.
  function beginTutorialShift() {
    showScreen(null);            // body.playing -> HUD visible
    PP.Game.startTutorialRun();
    PP.Audio.setMusic('game');   // [MUSIC] gameplay theme
    el.btnReward.classList.add('hidden');   // no "FIX ALL" ad mid-tutorial
    last.adCd = 0;
    el.hudDistrict.textContent = PP.Game.district.name;
  }

  // ------------------------------------------------------------------
  // Run summary
  // ------------------------------------------------------------------
  let summaryFunds = 0;   // cash earned this run, for the "2× CASH" rewarded-ad bonus

  function showSummary(run) {
    document.body.classList.remove('playing');
    el.overlayPause.classList.add('hidden');
    el.sumFlavor.textContent = QUOTES[(Math.random() * QUOTES.length) | 0];
    PP.Audio.setMusic('menu');   // [MUSIC] back to the menu theme for the summary
    el.sumPatched.textContent = run.patched;
    el.sumFunds.textContent = '$' + run.funds;
    el.sumCombo.textContent = '×' + run.bestCombo;
    const mm = Math.floor(run.t / 60), ss = Math.floor(run.t % 60);
    el.sumTime.textContent = mm + ':' + String(ss).padStart(2, '0');
    el.sumBest.classList.toggle('hidden', !run.newBest);
    summaryFunds = run.funds;
    el.btnDouble.disabled = false;
    el.btnContinue.disabled = false;
    const noCash = run.funds <= 0;                          // nothing to double on a $0 run
    el.btnDouble.classList.toggle('hidden', noCash);
    // when 2× CASH is hidden, Continue is the only action — make it the big
    // orange button again; otherwise keep it as the subtle text link
    el.btnContinue.className = noCash ? 'btn btn-big' : 'btn-link';

    // next-unlock teaser — keep the near-term goal in view at the decision point
    const sv = PP.Save.data;
    const nextD = PP.ALL_MAPS ? null : PP.nextLockedDistrict(sv.unlocked);
    if (nextD) {
      const remain = Math.max(0, nextD.cost - sv.totalFunds);
      el.sumNext.textContent = remain <= 0
        ? '✓ READY — UNLOCK ' + nextD.name
        : '$' + remain + ' TO ' + nextD.name;
      el.sumNext.classList.toggle('ready', remain <= 0);
      el.sumNext.classList.remove('hidden');
    } else {
      el.sumNext.classList.add('hidden');
    }
    el.screenSummary.classList.remove('hidden');
  }

  // ------------------------------------------------------------------
  // Your Fleet — hire vehicles, deploy a loadout, upgrade each vehicle
  // ------------------------------------------------------------------
  let carouselIdx = 0;     // which vehicle TYPE the hire carousel is showing
  let selectedVehIdx = -1; // which owned vehicle the upgrade screen is showing
  let renamingIdx = -1;    // which fleet card is being renamed inline

  // shown on the game-over screen, picked at random
  const QUOTES = [
    "Rome wasn't built in a day — but those potholes won't fill themselves.",
    'Every pothole patched is a small victory.',
    'Smooth roads, happy city.',
    'The road to greatness is paved… eventually.',
    'Slow and steady fills the road.',
    'A patch in time saves nine.',
    "Keep calm and patch on.",
  ];

  // escape user-entered text (vehicle callsigns) before putting it in HTML
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function upgCard(title, desc, cost, action, funds) {
    const right = cost == null
      ? '<span class="tag tag-max">MAXED</span>'
      : `<button class="btn btn-small btn-buy" data-action="${action}" ${funds < cost ? 'disabled' : ''}>$${cost}</button>`;
    return `<div class="upg-card"><div class="uc-info"><div class="uc-title">${title}</div><div class="uc-desc">${desc}</div></div>${right}</div>`;
  }

  // Draw a vehicle side-view into a card/stage canvas, crisp on hi-dpi.
  function paintArt(cv, type, silhouette) {
    if (!cv) return;
    const c = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = cv.clientWidth || cv.width, cssH = cv.clientHeight || cv.height;
    if (cssW < 2 || cssH < 2) return;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    PP.Render.drawVehicleSide(c, type, cssW, cssH, { silhouette: !!silhouette });
  }

  // How many deploy-flagged vehicles are actually fieldable on district `d`.
  function deployedCount(d) {
    let n = 0;
    for (const v of PP.Save.data.fleet) {
      const def = PP.vehicleById(v.type);
      if (v.deploy && def && PP.vehicleAllowedOn(def, d.locationId)) n++;
    }
    return n;
  }

  function renderFleet() {
    const sv = PP.Save.data;
    el.garageFunds.textContent = '$' + sv.totalFunds;
    const d = PP.districtById(sv.district) || PP.DISTRICTS[0];

    el.fleetDeployCount.textContent = deployedCount(d);
    el.fleetDeployCap.textContent = E.deployCap;
    el.fleetDeployWhere.textContent = '· ' + d.name;

    let html = '<button class="fleet-card fleet-hire" data-action="hire-open">'
      + '<span class="fc-plus">+</span><span class="fc-name">HIRE VEHICLE</span></button>';
    sv.fleet.forEach((v, i) => {
      const def = PP.vehicleById(v.type);
      if (!def) return;
      const allowed = PP.vehicleAllowedOn(def, d.locationId);
      const on = v.deploy && allowed;
      const custom = v.name && v.name.trim();
      const nameBlock = renamingIdx === i
        ? `<input class="fc-rename" maxlength="18" value="${esc(custom || '')}" placeholder="${def.name}" />`
        : `<span class="fc-name">${custom ? esc(v.name.trim()) : def.name}</span>${custom ? `<span class="fc-sub">${def.name}</span>` : ''}`;
      html += `<div class="fleet-card ${allowed ? '' : 'fc-unavail'} ${on ? 'fc-deployed' : ''}">
        <button class="fc-trash" data-action="sell" data-idx="${i}" aria-label="Sell vehicle">${ICON.trash}</button>
        <button class="fc-pencil" data-action="rename" data-idx="${i}" aria-label="Rename">${ICON.pencil}</button>
        <canvas class="fc-thumb" data-veh="${i}"></canvas>
        ${nameBlock}
        <div class="fc-actions">
          <button class="btn btn-small" data-action="open-upgrade" data-idx="${i}">UPGRADE</button>
          <button class="btn btn-small fc-deploy ${on ? 'on' : ''}" data-action="toggle-deploy" data-idx="${i}" ${allowed ? '' : 'disabled'}>${allowed ? (on ? '✓ DEPLOYED' : 'DEPLOY') : 'N/A HERE'}</button>
        </div>
      </div>`;
    });
    el.fleetGrid.innerHTML = html;
    el.fleetGrid.querySelectorAll('canvas.fc-thumb').forEach((cv) => {
      const v = sv.fleet[+cv.dataset.veh];
      if (v) paintArt(cv, v.type, false);
    });

    // inline rename: focus the input and commit on Enter / blur (Esc cancels)
    if (renamingIdx >= 0) {
      const inp = el.fleetGrid.querySelector('.fc-rename');
      if (inp) {
        inp.focus(); inp.select();
        const commit = () => {
          const v = sv.fleet[renamingIdx];
          if (v) {
            const nm = inp.value.trim().slice(0, 18);
            if (nm) v.name = nm; else delete v.name;
            PP.Save.save();                  // [DATA SAVE] rename
          }
          renamingIdx = -1;
          PP.Game.refreshFleet();
          renderFleet();
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { renamingIdx = -1; renderFleet(); }
        });
        inp.addEventListener('blur', commit);
      }
    }
  }

  function toggleDeploy(i) {
    const sv = PP.Save.data;
    const v = sv.fleet[i];
    if (!v) return;
    const d = PP.districtById(sv.district) || PP.DISTRICTS[0];
    const def = PP.vehicleById(v.type);
    if (!def || !PP.vehicleAllowedOn(def, d.locationId)) return;
    if (!v.deploy) {
      if (deployedCount(d) >= E.deployCap) { PP.Audio.play('error'); toast('LOADOUT FULL — ' + E.deployCap + ' MAX'); return; }
      v.deploy = true;
    } else {
      if (deployedCount(d) <= 1) { PP.Audio.play('error'); toast('AT LEAST ONE VEHICLE MUST DEPLOY'); return; }
      v.deploy = false;
    }
    PP.Audio.play('click');
    PP.Save.save();                        // [DATA SAVE] loadout change
    PP.Game.refreshFleet();                // re-park the loadout behind the menu
    refreshMeta();
  }

  // ---- Hire carousel ------------------------------------------------
  function showHire() {
    PP.Game.toMenu();
    if (!PP.Game.ambient) PP.Game.startAmbient();
    showScreen('hire');
    renderHire();
    PP.Audio.setMusic('menu');
  }

  function renderHire() {
    const sv = PP.Save.data;
    el.hireFunds.textContent = '$' + sv.totalFunds;
    const def = PP.VEHICLES[carouselIdx];
    const unlocked = PP.vehicleUnlocked(def, sv.unlocked);
    paintArt(el.hireArt, def.id, !unlocked);

    if (!unlocked) {
      const loc = PP.locationById(def.unlockAt);
      el.hireInfo.innerHTML = `<div class="hi-name hi-locked">${ICON.lock} ${def.name}</div>
        <div class="hi-lock">Unlocks when you reach <b>${loc ? loc.name : def.unlockAt}</b></div>`;
    } else {
      const owned = sv.fleet.filter((v) => v.type === def.id).length;
      const maxed = def.maxOwned && owned >= def.maxOwned;
      const afford = sv.totalFunds >= def.hireCost;
      const ownLabel = def.maxOwned ? ` · owned ${owned}/${def.maxOwned}` : (owned ? ' · owned ×' + owned : '');
      el.hireInfo.innerHTML = `<div class="hi-name">${def.name}</div>
        <div class="hi-blurb">${def.blurb}</div>
        <div class="hi-meta">${ICON.pin} ${PP.vehicleMapsLabel(def)}${ownLabel}</div>
        <button class="btn btn-big hi-buy" data-action="hire" ${afford && !maxed ? '' : 'disabled'}>${maxed ? 'MAX OWNED' : 'HIRE — $' + def.hireCost}</button>`;
    }
    let dots = '';
    for (let i = 0; i < PP.VEHICLES.length; i++) dots += `<span class="hire-dot ${i === carouselIdx ? 'on' : ''}"></span>`;
    el.hireDots.innerHTML = dots;
  }

  function hireVehicle() {
    const sv = PP.Save.data;
    const def = PP.VEHICLES[carouselIdx];
    if (!PP.vehicleUnlocked(def, sv.unlocked) || sv.totalFunds < def.hireCost) { PP.Audio.play('error'); return; }
    if (def.maxOwned && sv.fleet.filter((v) => v.type === def.id).length >= def.maxOwned) {
      PP.Audio.play('error'); toast('LIMIT ' + def.maxOwned + ' — ' + def.name); return;
    }
    sv.totalFunds -= def.hireCost;
    sv.fleet.push({ type: def.id, up: {}, deploy: false });
    PP.Audio.play('buy');
    PP.Save.save();                        // [DATA SAVE] hire
    PP.Game.refreshFleet();
    toast(def.name + ' HIRED!');
    refreshMeta();
  }

  // ---- Per-vehicle upgrades -----------------------------------------
  const UPG_DESC = {
    speed: 'Higher top speed',
    turn: 'Sharper, quicker turns — well worth it',
    patch: 'Patches potholes faster',
  };

  function showVehicle(i) {
    selectedVehIdx = i;
    if (!PP.Save.data.fleet[i]) { showFleet(); return; }
    PP.Game.toMenu();
    if (!PP.Game.ambient) PP.Game.startAmbient();
    showScreen('vehicle');
    renderVehicle();
    PP.Audio.setMusic('menu');
  }

  function renderVehicle() {
    const sv = PP.Save.data;
    const v = sv.fleet[selectedVehIdx];
    if (!v) { showFleet(); return; }
    const def = PP.vehicleById(v.type);
    const custom = v.name && v.name.trim();
    el.vehTitle.textContent = custom || def.name;
    el.vehSub.textContent = custom ? def.name : '';   // type stays visible below the callsign
    el.vehFunds.textContent = '$' + sv.totalFunds;
    el.vehBlurb.textContent = def.blurb;
    paintArt(el.vehArt, def.id, false);

    let html = '';
    for (const u of def.upgrades) {
      const lvl = v.up[u.key] | 0;
      const cost = lvl >= 3 ? null : u.costs[lvl];
      html += upgCard(`${u.name} <span class="upg-lvl">${lvl}/3</span>`,
        u.desc || UPG_DESC[u.affects] || 'Improves this vehicle', cost, 'buy-upgrade:' + u.key, sv.totalFunds);
    }
    el.vehUpgrades.innerHTML = html;
  }

  function sellVehicle(i) {
    const sv = PP.Save.data;
    const v = sv.fleet[i];
    if (!v) return;
    const def = PP.vehicleById(v.type);
    const refund = Math.floor(def.hireCost / 10);   // 1/10th of hire price (upgrades not refunded)
    const label = (v.name && v.name.trim()) || def.name;
    sv.totalFunds += refund;
    sv.fleet.splice(i, 1);
    if (renamingIdx === i) renamingIdx = -1;
    PP.Audio.play('buy');
    PP.Save.save();                        // [DATA SAVE] sell
    PP.Game.refreshFleet();
    toast('SOLD ' + label + ' FOR $' + refund);
    renderFleet();
    refreshMeta();
  }

  function buyUpgrade(key) {
    const sv = PP.Save.data;
    const v = sv.fleet[selectedVehIdx];
    if (!v) return;
    const def = PP.vehicleById(v.type);
    const u = def.upgrades.find((x) => x.key === key);
    if (!u) return;
    const lvl = v.up[key] | 0;
    if (lvl >= 3) return;
    const cost = u.costs[lvl];
    if (sv.totalFunds < cost) { PP.Audio.play('error'); return; }
    sv.totalFunds -= cost;
    v.up[key] = lvl + 1;
    PP.Audio.play('buy');
    PP.Save.save();                        // [DATA SAVE] upgrade
    PP.Game.refreshFleet();
    refreshMeta();
  }

  // ------------------------------------------------------------------
  // Travel: pick a district to patrol or unlock the next one.
  // Locations are unlocked in a single linear chain (see PP.DISTRICTS);
  // a district is unlockable only once the one before it is owned.
  // ------------------------------------------------------------------
  function renderTravel() {
    const sv = PP.Save.data;
    el.travelFunds.textContent = '$' + sv.totalFunds;
    // preview mode (?allmaps=1) treats everything as owned, no unlock buttons
    const isOwned = (id) => PP.ALL_MAPS || sv.unlocked.includes(id);
    const next = PP.ALL_MAPS ? null : PP.nextLockedDistrict(sv.unlocked);

    let html = '';
    for (const loc of PP.LOCATIONS) {
      const owned = loc.districts.filter((d) => isOwned(d.id)).length;
      const locUnlocked = owned > 0;
      html += `<div class="loc-card ${locUnlocked ? '' : 'loc-locked'}">
        <div class="loc-head">
          <span class="loc-name">${loc.name}</span>
          <span class="loc-progress">${owned}/${loc.districts.length}</span>
        </div>
        <div class="loc-tag">${loc.tagline}</div>
        <div class="loc-districts">`;
      for (const d of loc.districts) {
        const unlocked = isOwned(d.id);
        const active = sv.district === d.id;
        const isNext = next && next.id === d.id;
        const meta = `${d.w}×${d.h} · PAY ×${d.payout}`;
        let state, body;
        if (active && unlocked) {
          state = 'active';
          body = '<span class="tag tag-active">ON DUTY</span>';
        } else if (unlocked) {
          state = 'owned';
          body = `<button class="btn btn-small" data-action="select-district" data-id="${d.id}">PATROL</button>`;
        } else if (isNext) {
          state = 'next';
          body = `<button class="btn btn-small btn-unlock" data-action="unlock-district" data-id="${d.id}" ${sv.totalFunds < d.cost ? 'disabled' : ''}>UNLOCK $${d.cost}</button>`;
        } else {
          state = 'locked';
          body = `<span class="lock-cost">${ICON.lock} $${d.cost}</span>`;
        }
        html += `<div class="dist-chip chip-${state}">
          <div class="chip-name">${d.name}</div>
          <div class="chip-meta">${d.tagline}</div>
          <div class="chip-meta chip-stats">${meta}</div>
          <div class="chip-foot">${body}</div>
        </div>`;
      }
      html += '</div></div>';
    }
    el.locationList.innerHTML = html;
  }

  function handleDistrictAction(action, id) {
    const sv = PP.Save.data;
    const d = PP.districtById(id);
    if (!d) return;

    if (action === 'unlock-district') {
      // enforce the sequential rule + affordability server-side as well
      const next = PP.nextLockedDistrict(sv.unlocked);
      if (!next || next.id !== d.id || sv.totalFunds < d.cost) {
        PP.Audio.play('error');
        return;
      }
      // which vehicles were still locked BEFORE this purchase? (so we can tell
      // which ones reaching this new world has just made hireable)
      const wasLocked = PP.VEHICLES.filter((v) => !PP.vehicleUnlocked(v, sv.unlocked));
      sv.totalFunds -= d.cost;
      sv.unlocked.push(d.id);
      sv.district = d.id;                  // travel straight to the new district
      PP.Audio.play('buy');
      PP.SDK.happytime();                  // [HAPPYTIME] new district unlocked
      toast(d.name + ' UNLOCKED!');
      PP.Save.save();                      // [DATA SAVE] unlock
      PP.Game.startAmbient();              // swap the live backdrop
      // announce any vehicle this world just made available
      for (const v of wasLocked) {
        if (PP.vehicleUnlocked(v, sv.unlocked)) queueVehicleUnlock(v);
      }
    } else if (action === 'select-district') {
      if ((!PP.ALL_MAPS && !sv.unlocked.includes(id)) || sv.district === id) return;
      sv.district = id;
      PP.Audio.play('click');
      PP.Save.save();                      // [DATA SAVE] district switch
      PP.Game.startAmbient();              // swap the live backdrop
    } else {
      return;
    }
    renderTravel();
    refreshMeta();
  }

  // ------------------------------------------------------------------
  // Per-frame HUD refresh (cheap: only writes on change)
  // ------------------------------------------------------------------
  function frame() {
    const run = PP.Game.run;
    if (!document.body.classList.contains('playing') || !run) return;

    // funds count-up — ease the shown number toward the real total so earning
    // cash "ticks up" instead of snapping (a small but strong dopamine cue)
    if (last.fundsShown == null) last.fundsShown = run.funds;
    if (last.fundsShown !== run.funds) {
      const diff = run.funds - last.fundsShown;
      if (diff < 0 || Math.abs(diff) < 1) last.fundsShown = run.funds;     // reset / arrive
      else last.fundsShown += Math.max(1, Math.ceil(diff * 0.2));          // close ~20%/frame
      el.hudFunds.textContent = '$' + Math.round(last.fundsShown);
    }

    const combo = run.combo;
    if (last.combo !== combo) {
      const rising = combo > (last.combo || 0);
      last.combo = combo;
      el.hudCombo.textContent = combo;
      el.hudComboChip.classList.toggle('hidden', combo < 2);
      if (combo < 2) {
        el.hudComboChip.style.transform = '';            // reset when the streak ends
      } else if (rising) {
        // each step up: spring-rotate, alternating left (even) / right (odd)
        el.hudComboChip.style.transform = 'rotate(' + (combo % 2 === 0 ? -14 : 14) + 'deg)';
      }
    }

    let ready = 0;
    for (const tr of run.trucks) if (tr.state === 'parked' || tr.state === 'returning') ready++;
    setText('trucks', el.hudTrucks, String(ready));

    const rep = Math.round(run.rep);
    if (last.rep !== rep) {
      last.rep = rep;
      el.hudRepFill.style.width = rep + '%';
      el.hudRepFill.className = rep > 55 ? 'ok' : rep > 25 ? 'warn' : 'danger';
    }

    // the reward button simply hides while on cooldown (not a relied-on timer)
    const cd = Math.ceil(run.adCd);
    if (last.adCd !== cd) {
      last.adCd = cd;
      el.btnReward.classList.toggle('hidden', cd > 0);
      el.btnReward.disabled = cd > 0;
    }
  }

  // ------------------------------------------------------------------
  // Feedback bits
  // ------------------------------------------------------------------
  function fundsPop() {
    el.hudFunds.classList.remove('pop');
    void el.hudFunds.offsetWidth;   // restart the CSS animation
    el.hudFunds.classList.add('pop');
  }

  function repShake() {
    el.hudRepWrap.classList.remove('shake');
    void el.hudRepWrap.offsetWidth;
    el.hudRepWrap.classList.add('shake');
  }

  let toastTimer = null;
  function toast(text, secs) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), (secs || 2.2) * 1000);
  }

  // ------------------------------------------------------------------
  // Vehicle-unlock notification: a plate that drops in from the top
  // centre when reaching a new world makes a new vehicle hireable. The
  // animation runs in ordered stages: (1) the plate drops in, (2) the
  // padlock swings open, (3) the side-view art reveals from a black
  // silhouette (locked) to full colour. Shown one at a time (queued).
  // ------------------------------------------------------------------
  let vuQueue = [], vuBusy = false;
  let vuTimers = [];
  const vuClear = () => { vuTimers.forEach(clearTimeout); vuTimers = []; };
  const vuAt = (ms, fn) => vuTimers.push(setTimeout(fn, ms));

  // stage timeline (ms): drop -> (settle) -> lock opens -> art reveals -> hold
  const VU = { lock: 750, reveal: 1500, holdOut: 4500, gone: 4500 + 640 };

  function queueVehicleUnlock(def) {
    if (!def || !el.vehicleUnlock) return;
    vuQueue.push(def);
    pumpVehicleUnlock();
  }

  function pumpVehicleUnlock() {
    if (vuBusy) return;
    const def = vuQueue.shift();
    if (!def) return;
    vuBusy = true;
    showVehicleUnlock(def);
  }

  function showVehicleUnlock(def) {
    vuClear();
    el.vuName.textContent = def.name;
    // colour beneath, black silhouette on top — both must be painted while the
    // plate has layout size, so do it before sliding (it sits off-screen above)
    paintArt(el.vuArtColor, def.id, false);
    paintArt(el.vuArtBlack, def.id, true);
    // hard-reset to the locked/black START state with NO animation — so a
    // queued notification can never show the previous one's open lock or
    // already-coloured art. Suppress transitions, drop the classes, flush.
    el.vuShackle.style.transition = 'none';       // lock snaps shut
    el.vuArtBlack.style.transition = 'none';      // art snaps fully black
    el.vehicleUnlock.classList.remove('shown', 'lock-open');
    el.vuArtBlack.classList.remove('revealed');
    void el.vehicleUnlock.offsetWidth;            // flush: commit the reset instantly
    el.vuShackle.style.transition = '';           // restore the staged transitions
    el.vuArtBlack.style.transition = '';
    void el.vehicleUnlock.offsetWidth;            // flush again before animating

    el.vehicleUnlock.classList.add('shown');      // stage 1: drop the plate in
    PP.Audio.play('unlock');                       // triumphant fanfare
    vuAt(VU.lock,   () => el.vehicleUnlock.classList.add('lock-open'));  // stage 2: unlock
    vuAt(VU.reveal, () => el.vuArtBlack.classList.add('revealed'));      // stage 3: colourise
    vuAt(VU.holdOut, () => el.vehicleUnlock.classList.remove('shown'));  // slide back up
    vuAt(VU.gone,   () => { vuBusy = false; pumpVehicleUnlock(); });     // next in queue
  }

  // [MUTE] reflect the combined mute state on every speaker button
  function updateMuteUI() {
    if (!el.muteButtons) return;
    const icon = PP.Audio.isMuted() ? ICON.speakerOff : ICON.speakerOn;
    for (const b of el.muteButtons) {
      if (b) b.innerHTML = icon;
    }
  }

  // ------------------------------------------------------------------
  // Mock ad overlay — only used when the real SDK is absent, so local
  // testing makes the ad lifecycle visible (completes after `secs`).
  // ------------------------------------------------------------------
  function showMockAd(type, secs, onDone) {
    el.mockadType.textContent = type === 'rewarded' ? 'REWARDED AD' : 'MIDGAME AD';
    el.mockadCount.textContent = secs;
    el.overlayMockad.classList.remove('hidden');
    let left = secs;
    const iv = setInterval(() => {
      left--;
      el.mockadCount.textContent = Math.max(0, left);
      if (left <= 0) {
        clearInterval(iv);
        el.overlayMockad.classList.add('hidden');
        onDone();
      }
    }, 1000);
  }

  // ------------------------------------------------------------------
  // Portrait blocker: landscape-only on touch devices / narrow screens
  // ------------------------------------------------------------------
  function checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const block = portrait && (coarse || window.innerWidth < 640);
    document.body.classList.toggle('rotate-block', block);
    if (block) PP.Game.pause('portrait');
    else PP.Game.resume('portrait');
  }

  return {
    init, frame,
    showScreen, setLoadStatus,
    enterMenu, showFleet, showTravel, startGame, beginTutorialShift, showSummary,
    fundsPop, repShake, toast,
    updateMuteUI, showMockAd, checkOrientation,
    refreshMeta,
  };
})();
