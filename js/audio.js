/* ====================================================================
   POTHOLE PATROL — audio.js
   WebAudio sound effects + two looping music tracks (menu.mp3 / game.mp3)
   that crossfade into each other on screen changes.

   [MUTE] One global mute state combining THREE sources:
     1. sdkMute  — CrazyGames settings.muteAudio (set by js/sdk.js)
     2. adMute   — true while any ad is showing  (set by js/sdk.js)
     3. userMute — the in-game speaker toggle button
   Sound is audible only when ALL THREE are false.

   [MUSIC] PP.Audio.setMusic('menu' | 'game') picks the track; the two
   are routed through their own gain nodes and crossfaded (see crossfade).
   ==================================================================== */

PP.Audio = (function () {
  let ctx = null;
  let master = null;   // everything routes through this; muting = gain 0
  let sfxGain = null;

  let sdkMute = false;
  let adMute = false;
  let userMute = false;

  // ---- music tracks --------------------------------------------------
  const MUSIC_VOL = 0.55;     // full volume of whichever track is active
  const FADE = 1.1;           // crossfade seconds
  const MUSIC_SRC = { menu: 'audio/menu.mp3', game: 'audio/game.mp3' };
  const els = {};             // HTMLAudioElement per track
  const trackGain = {};       // GainNode per track (the crossfade faders)
  let musicWired = false;     // MediaElementSource nodes created yet?
  let desiredTrack = null;    // 'menu' | 'game' — what should be playing

  function isMuted() { return sdkMute || adMute || userMute; }

  // [MUTE] the single place the combined mute state is applied
  function applyMute() {
    if (ctx && master) {
      master.gain.setTargetAtTime(isMuted() ? 0 : 1, ctx.currentTime, 0.04);
    }
    if (PP.UI && PP.UI.updateMuteUI) PP.UI.updateMuteUI();
    PP.log('mute state:', { sdkMute, adMute, userMute, effective: isMuted() });
  }

  function setSdkMute(v) { sdkMute = !!v; applyMute(); }
  function setAdMute(v)  { adMute = !!v;  applyMute(); }
  function setUserMute(v) { userMute = !!v; applyMute(); return userMute; }   // restore a saved preference
  function toggleUserMute() { userMute = !userMute; applyMute(); return userMute; }

  // --- context bootstrap (must happen after a user gesture) -----------
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.8;
      sfxGain.connect(master);
      wireMusic();
      applyMute();
    }
    if (ctx.state === 'suspended') ctx.resume();
    // first user gesture: kick off whatever track was already requested
    if (musicWired) crossfade(false);
  }

  // ---- [MUSIC] route the two <audio> elements into the graph ----------
  // Each track: <audio> -> MediaElementSource -> trackGain -> master.
  // Muting still works because everything passes through `master`.
  function wireMusic() {
    if (musicWired || !ctx) return;
    for (const name of ['menu', 'game']) {
      let el = els[name];
      if (!el) {
        el = els[name] = new Audio(MUSIC_SRC[name]);
        el.loop = true;
        el.preload = 'auto';
        el.crossOrigin = 'anonymous';
      }
      const g = trackGain[name] = ctx.createGain();
      g.gain.value = 0;
      g.connect(master);
      try {
        ctx.createMediaElementSource(el).connect(g);
      } catch (e) {
        PP.log('music wiring failed for ' + name + ':', e);
      }
    }
    musicWired = true;
  }

  // ---- [MUSIC] choose the active track --------------------------------
  function setMusic(track) {
    if (track === desiredTrack) return;
    desiredTrack = track;
    if (musicWired) crossfade(true);
  }

  // Ramp the active track up and the others down; start the incoming
  // element playing. Both tracks loop continuously (the inactive one
  // simply sits at gain 0), so the fade overlaps cleanly.
  function crossfade(fade) {
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = fade ? FADE : 0.02;
    for (const name of ['menu', 'game']) {
      const g = trackGain[name], el = els[name];
      if (!g) continue;
      const target = name === desiredTrack ? MUSIC_VOL : 0;
      if (target > 0 && el.paused) { el.play().catch(() => {}); }
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
      g.gain.linearRampToValueAtTime(target, now + dur);
    }
  }

  // --- tiny synth helpers ----------------------------------------------
  function blip(t0, f0, f1, dur, type, vol, dest) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest || sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function thud(t0, dur, vol, cutoff) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = cutoff || 800;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(sfxGain);
    src.start(t0);
  }

  // --- sound effects ----------------------------------------------------
  const SFX = {
    click(t)    { blip(t, 480, 320, 0.06, 'square', 0.18); },
    dispatch(t) { blip(t, 520, 760, 0.07, 'square', 0.2); blip(t + 0.09, 660, 920, 0.07, 'square', 0.2); },
    patch(t, combo) {
      const shift = Math.pow(1.0594, Math.min(combo || 0, 10)); // pitch rises with combo
      blip(t,        392 * shift, 0, 0.10, 'triangle', 0.3);
      blip(t + 0.07, 494 * shift, 0, 0.10, 'triangle', 0.3);
      blip(t + 0.14, 587 * shift, 0, 0.16, 'triangle', 0.3);
    },
    hit(t)      { thud(t, 0.16, 0.5, 700); blip(t, 170, 65, 0.22, 'sawtooth', 0.25); },
    crack(t)    { thud(t, 0.07, 0.14, 500); },
    cone(t)     { thud(t, 0.05, 0.2, 1500); },
    error(t)    { blip(t, 160, 0, 0.13, 'square', 0.25); blip(t + 0.15, 140, 0, 0.16, 'square', 0.25); },
    shield(t)   { blip(t, 300, 900, 0.35, 'sine', 0.3); blip(t + 0.05, 450, 1200, 0.3, 'sine', 0.18); },
    reward(t)   { [523, 659, 784, 1047].forEach((f, i) => blip(t + i * 0.09, f, 0, 0.14, 'triangle', 0.3)); },
    buy(t)      { blip(t, 880, 1320, 0.1, 'square', 0.22); blip(t + 0.1, 1100, 1760, 0.12, 'square', 0.22); },
    gameover(t) { blip(t, 440, 110, 0.8, 'sawtooth', 0.3); thud(t + 0.4, 0.3, 0.4, 400); },
    // celebratory combo-milestone sting — longer & higher at ×8 and the ×12 cap
    combo(t, n) {
      const tier = (n || 0) >= 12 ? 2 : (n || 0) >= 8 ? 1 : 0;
      const notes = [523, 659, 784, 1047, 1319].slice(0, 3 + tier);   // 3 / 4 / 5 notes
      notes.forEach((f, i) => blip(t + i * 0.06, f, 0, 0.13, 'triangle', 0.3));
      if (tier >= 1) blip(t + notes.length * 0.06, 1568, 0, 0.22, 'triangle', 0.27); // top flourish
    },
    // triumphant fanfare for the vehicle-unlock plate (two rising chords)
    unlock(t) {
      [392, 523, 659].forEach((f) => blip(t, f, 0, 0.18, 'triangle', 0.2));
      [523, 659, 784].forEach((f) => blip(t + 0.16, f, 0, 0.3, 'triangle', 0.22));
      blip(t + 0.16, 1047, 0, 0.32, 'sine', 0.15);
    },
    // bright welcome-back chime for the daily-return popup
    daily(t)    { [659, 880, 1175].forEach((f, i) => blip(t + i * 0.08, f, 0, 0.18, 'triangle', 0.28)); },
  };

  function play(name, arg) {
    if (!ctx || isMuted()) return;       // [MUTE] hard gate on every effect
    const fn = SFX[name];
    if (fn) { try { fn(ctx.currentTime, arg); } catch (e) { /* ignore */ } }
  }

  // observable music status (used by tests / debugging)
  function musicState() {
    return {
      desired: desiredTrack,
      wired: musicWired,
      menuVol: trackGain.menu ? +trackGain.menu.gain.value.toFixed(3) : null,
      gameVol: trackGain.game ? +trackGain.game.gain.value.toFixed(3) : null,
      menuPlaying: els.menu ? !els.menu.paused : false,
      gamePlaying: els.game ? !els.game.paused : false,
    };
  }

  return {
    unlock, play, isMuted, setMusic, musicState,
    setSdkMute, setAdMute, setUserMute, toggleUserMute,
    get userMute() { return userMute; },
  };
})();
