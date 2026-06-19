/* ====================================================================
   POTHOLE PATROL — save.js
   Persistent progression. All storage goes through the PP.SDK data
   wrappers (CrazyGames Data Module, localStorage fallback).

   Persisted: total funds, the hired fleet (each vehicle's type, upgrade
   levels and deploy flag), unlocked districts, current district, best
   run stats, tutorial-completed flag.

   NOTE: the storage key is "cash"-era, so any older save is simply ignored —
   every player starts fresh with $600 and no vehicles (exactly enough to buy
   the Basic Truck themselves).

   FIRST-RUN TUTORIAL: a save is only treated as "real" once tutorialDone is
   set (the tutorial writes it at the very end). Until then, any persisted
   state from a half-finished tutorial is discarded on load and the player
   starts over from scratch — so leaving / reloading mid-tutorial always
   restarts the tutorial from the beginning (only the sound preference is
   carried across).
   ==================================================================== */

PP.Save = (function () {
  const KEY = 'pothole_patrol';

  function defaults() {
    return {
      version: 4,
      totalFunds: 600,
      // brand-new players own nothing — the tutorial walks them through
      // buying their first truck AND unlocking their first district
      fleet: [],
      unlocked: [],                 // nothing owned yet (Maple is bought in the tutorial)
      district: PP.firstDistrictId, // the selected district (also the menu backdrop)
      best: { patched: 0, combo: 0, funds: 0 },
      muted: 0,         // sound preference (persists the speaker toggle)
      tutorialDone: 0,  // set to 1 only when the first-run tutorial completes
      adClaimed: 0,     // home-screen ad reward used this round? (resets on run end)
      lastPlayedDay: 0, // day-number of the last session (daily-return streak)
      streak: 0,        // consecutive-day streak count
    };
  }

  let data = defaults();

  // Repair / clamp a fleet array loaded from disk: drop unknown types,
  // clamp upgrade levels to 0..3, and guarantee at least one vehicle.
  function sanitizeFleet(fleet) {
    const clean = [];
    if (Array.isArray(fleet)) {
      for (const v of fleet) {
        const def = v && PP.vehicleById(v.type);
        if (!def) continue;
        const up = {};
        for (const u of def.upgrades) {
          const lvl = (v.up && v.up[u.key]) | 0;
          up[u.key] = Math.min(3, Math.max(0, lvl));
        }
        const entry = { type: def.id, up, deploy: !!v.deploy };
        if (typeof v.name === 'string' && v.name.trim()) entry.name = v.name.slice(0, 18);
        clean.push(entry);
      }
    }
    // an empty fleet is allowed now (new players own nothing); just keep the
    // number of deploy-flagged vehicles within the cap
    let deployed = 0;
    const cap = PP.CONFIG.ECON.deployCap;
    for (const v of clean) {
      if (v.deploy) { if (deployed < cap) deployed++; else v.deploy = false; }
    }
    return clean;
  }

  // ---- [DATA LOAD] called once during the loading screen --------------
  function load() {
    const raw = PP.SDK.dataGetItem(KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.tutorialDone) {
          // tutorial never finished last time → discard everything and start
          // fresh so the tutorial restarts from the beginning. Keep only the
          // sound preference so a muted player stays muted.
          data = defaults();
          if (parsed.muted) data.muted = parsed.muted;
          PP.log('tutorial incomplete — fresh start (tutorial will restart)');
          return;
        }
        data = Object.assign(defaults(), parsed);
        data.best = Object.assign(defaults().best, parsed.best || {});
        data.fleet = sanitizeFleet(parsed.fleet);
        // drop any unlocked ids that no longer exist, always keep the first district
        if (!Array.isArray(data.unlocked)) data.unlocked = [];
        data.unlocked = data.unlocked.filter((id) => !!PP.districtById(id));
        if (!data.unlocked.includes(PP.firstDistrictId)) data.unlocked.unshift(PP.firstDistrictId);
        if (!data.unlocked.includes(data.district)) data.district = PP.firstDistrictId;
        PP.log('save loaded:', data);
      } catch (e) {
        PP.log('corrupt save, starting fresh:', e);
        data = defaults();
      }
    } else {
      PP.log('no save found, starting fresh');
    }
  }

  // ---- [DATA SAVE] called after every purchase and at run end ---------
  function save() {
    PP.SDK.dataSetItem(KEY, JSON.stringify(data));
    PP.log('save written');
  }

  // ---- [DATA REMOVE] full wipe (debug panel) ---------------------------
  function reset() {
    PP.SDK.dataRemoveItem(KEY);
    data = defaults();
    PP.log('save wiped');
  }

  return {
    get data() { return data; },
    load, save, reset,
  };
})();
