/* ====================================================================
   POTHOLE PATROL — sdk.js
   The ONLY file that talks to window.CrazyGames.SDK.

   Covers:
     [SDK INIT]        CrazyGames.SDK.init() during the loading screen
     [AD] MIDGAME      requestAd('midgame', ...) between runs
     [AD] REWARDED     requestAd('rewarded', ...) for in-run boosts
     [MUTE]            settings.muteAudio + addSettingsChangeListener
     [GAMEPLAY]        game.gameplayStart() / game.gameplayStop()
     [DATA]            data.getItem / setItem / removeItem wrappers

   If the SDK script failed to load (testing locally, ad blocker, …)
   everything degrades to a mock: ads "play" for 2 seconds behind the
   #overlay-mockad element and saves go to localStorage.
   ==================================================================== */

PP.SDK = (function () {
  let sdk = null;
  let mock = true;          // assume mock until init proves otherwise
  let mockMuteAudio = false;
  let inGameplay = false;
  let adShowing = false;

  function hasRealSDK() {
    return !!(window.CrazyGames && window.CrazyGames.SDK);
  }

  // ================= [SDK INIT] =====================================
  async function init() {
    mock = PP.QUERY.mocksdk === '1' || !hasRealSDK();

    if (!mock) {
      sdk = window.CrazyGames.SDK;
      try {
        await sdk.init();                       // <-- CrazyGames.SDK.init()
        PP.log('CrazyGames SDK initialized');
      } catch (e) {
        PP.log('SDK init failed, falling back to mock:', e);
        mock = true;
        sdk = null;
      }
    }

    // ---- [MUTE] read initial muteAudio setting -----------------------
    let initialMute = false;
    if (!mock) {
      try {
        initialMute = !!(sdk.game && sdk.game.settings && sdk.game.settings.muteAudio);
      } catch (e) { /* setting unavailable */ }

      // ---- [MUTE] react to muteAudio changing mid-session -------------
      try {
        const onSettings = (settings) => {
          PP.Audio.setSdkMute(!!(settings && settings.muteAudio));
        };
        if (sdk.game && typeof sdk.game.addSettingsChangeListener === 'function') {
          sdk.game.addSettingsChangeListener(onSettings);
        } else if (typeof sdk.addSettingsChangeListener === 'function') {
          sdk.addSettingsChangeListener(onSettings);
        }
      } catch (e) { PP.log('settings listener unavailable:', e); }
    } else {
      // mock: URL param ?mute=1 simulates settings.muteAudio = true
      mockMuteAudio = PP.QUERY.mute === '1';
      initialMute = mockMuteAudio;
      PP.log('running with MOCK SDK (ads simulate in 2s, saves -> localStorage)');
    }
    PP.Audio.setSdkMute(initialMute);
  }

  // ================= [LOADING] start / stop =========================
  // CrazyGames loading events: loadingStart() fires once the SDK is
  // initialized and the loading screen is doing its work; loadingStop()
  // fires when loading completes and the main menu appears (main.js).
  let isLoading = false;

  function loadingStart() {
    if (isLoading) return;
    isLoading = true;
    if (!mock) { try { sdk.game.loadingStart(); } catch (e) { /* ignore */ } }
    PP.log('loadingStart()');
  }

  function loadingStop() {
    if (!isLoading) return;
    isLoading = false;
    if (!mock) { try { sdk.game.loadingStop(); } catch (e) { /* ignore */ } }
    PP.log('loadingStop()');
  }

  // ================= [GAMEPLAY] start / stop ========================
  // Called by game.js whenever the player enters/leaves active play
  // (run start, pause, ad showing, menus, game over).
  function gameplayStart() {
    if (inGameplay) return;
    inGameplay = true;
    if (!mock) { try { sdk.game.gameplayStart(); } catch (e) { /* ignore */ } }
    PP.log('gameplayStart()');
  }

  function gameplayStop() {
    if (!inGameplay) return;
    inGameplay = false;
    if (!mock) { try { sdk.game.gameplayStop(); } catch (e) { /* ignore */ } }
    PP.log('gameplayStop()');
  }

  // ================= [HAPPYTIME] positive-moment signal =============
  // Optional CrazyGames signal fired at genuine "happy moments" — a new
  // personal best, a maxed-out combo, unlocking a new district — so the
  // platform can react (e.g. like/engagement prompts). Safe no-op in mock.
  function happytime() {
    if (!mock) { try { sdk.game.happytime(); } catch (e) { /* ignore */ } }
    PP.log('happytime()');
  }

  // ================= [AD] core request ==============================
  // Shared plumbing for midgame + rewarded:
  //   adStarted  -> pause the game loop, mute audio
  //   adFinished -> unmute, resume, success callback
  //   adError    -> unmute, resume, error callback (NO reward)
  //
  // NOTE ON THE CRAZYGAMES PREVIEW/TESTER: real ad serving is disabled
  // until a game is fully launched, so adError fires there by design
  // (reason: adsDisabledBasicLaunch / unfilled). Append ?useLocalSdk=true
  // to the game URL in the preview to make the SDK simulate ads instead.
  function requestAd(type, hooks) {
    if (adShowing) return;
    adShowing = true;
    let settled = false;   // finished/error fire at most once

    const callbacks = {
      adStarted: () => {
        PP.Audio.setAdMute(true);        // [MUTE] mute during ad
        PP.Game.pause('ad');             // pause game loop (also gameplayStop)
        PP.log('adStarted (' + type + ')');
      },
      adFinished: () => {
        if (settled) return;
        settled = true;
        adShowing = false;
        PP.Audio.setAdMute(false);       // [MUTE] restore audio
        PP.Game.resume('ad');            // resume loop (also gameplayStart)
        PP.log('adFinished (' + type + ')');
        if (hooks.onFinished) hooks.onFinished();
      },
      adError: (err) => {
        if (settled) return;
        settled = true;
        adShowing = false;
        PP.Audio.setAdMute(false);       // [MUTE] restore audio
        PP.Game.resume('ad');
        // always logged (not just in debug) so the reason shows up
        // in the CrazyGames preview console
        console.warn('[Pothole Patrol] adError (' + type + '):', err);
        if (hooks.onError) hooks.onError(err);
      },
    };

    if (mock) {
      // Simulated ad: completes after 2 seconds behind a visible overlay.
      callbacks.adStarted();
      PP.UI.showMockAd(type, 2, () => callbacks.adFinished());
      return;
    }

    try {
      const result = sdk.ad.requestAd(type, callbacks);  // <-- real CrazyGames ad call
      // requestAd is promise-based in SDK v3; a rejection without an
      // adError callback would otherwise leave the game stuck paused
      if (result && typeof result.catch === 'function') {
        result.catch((e) => callbacks.adError(e));
      }
    } catch (e) {
      callbacks.adError(e);
    }
  }

  // human-readable reasons for the documented CrazyGames adError codes
  function adErrorText(err) {
    const code = typeof err === 'string' ? err
      : (err && (err.code || err.message)) || '';
    if (/adsDisabledBasicLaunch/i.test(code)) return 'ADS DISABLED UNTIL FULL LAUNCH';
    if (/unfilled/i.test(code)) return 'NO AD AVAILABLE RIGHT NOW';
    if (/adblock/i.test(code)) return 'AD BLOCKER DETECTED';
    if (/cooldown/i.test(code)) return 'ADS COOLING DOWN — TRY AGAIN SOON';
    return 'AD UNAVAILABLE';
  }

  // ---- [AD] MIDGAME: between runs (never during active gameplay) ----
  function requestMidgameAd(onDone) {
    requestAd('midgame', { onFinished: onDone, onError: onDone });
  }

  // ---- [AD] REWARDED: reward ONLY granted on adFinished --------------
  function requestRewardedAd(hooks) {
    requestAd('rewarded', {
      onFinished: () => {
        if (hooks.onReward) hooks.onReward();   // grant the reward
        if (hooks.onDone) hooks.onDone();
      },
      onError: (err) => {
        PP.UI.toast(adErrorText(err) + ' — NO REWARD');
        PP.Game.setAdCooldown(30);               // hide the button, retry after a bit
        if (hooks.onDone) hooks.onDone();        // no reward on error
      },
    });
  }

  // ================= [DATA] save/load wrappers =======================
  // CrazyGames Data Module with graceful localStorage fallback so the
  // game saves correctly when tested outside the CrazyGames site.
  function dataGetItem(key) {
    if (!mock) {
      try { return sdk.data.getItem(key); }
      catch (e) { PP.log('SDK data.getItem failed, using localStorage:', e); }
    }
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function dataSetItem(key, value) {
    if (!mock) {
      try { sdk.data.setItem(key, value); return; }
      catch (e) { PP.log('SDK data.setItem failed, using localStorage:', e); }
    }
    try { localStorage.setItem(key, value); } catch (e) { /* storage full/blocked */ }
  }

  function dataRemoveItem(key) {
    if (!mock) {
      try { sdk.data.removeItem(key); return; }
      catch (e) { PP.log('SDK data.removeItem failed, using localStorage:', e); }
    }
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  // ---- debug helper: simulate the CrazyGames mute setting flipping ----
  function debugToggleSettingsMute() {
    mockMuteAudio = !mockMuteAudio;
    PP.Audio.setSdkMute(mockMuteAudio);
    PP.UI.toast('SDK muteAudio = ' + mockMuteAudio);
  }

  return {
    init,
    get isMock() { return mock; },
    loadingStart, loadingStop,
    gameplayStart, gameplayStop,
    happytime,
    requestMidgameAd, requestRewardedAd,
    dataGetItem, dataSetItem, dataRemoveItem,
    debugToggleSettingsMute,
  };
})();
