/* ====================================================================
   POTHOLE PATROL — config.js
   Tuning constants, LOCATIONS (each a themed world with its own
   landscape, car style, pothole/hazard style, ambient FX, signature
   landmarks and 3 districts), URL params / debug flags.
   Shared global namespace: window.PP (plain scripts, no build step).

   Theme fields consumed by the renderer:
     ground/groundAlt/road/curb/line  - tile palette
     buildings[]                       - block colours
     decor / decorA / decorB           - decoration style + 2 colours
     waterColor                        - colour of water rows (if any)
     park                              - decoration density 0..1
     carStyle    : 'car'|'fish'|'rover'|'hover'
     holeStyle   : 'pothole'|'quicksand'|'ice'|'geyser'|'meteor'|'rift'
     transitColor: colour of the occasional "transit" vehicle (bus, tram…)
     tint        : optional rgba() wash over the whole map
     fx          : optional { type, color, n } ambient particles
   Each district also carries `landmark` — a signature structure drawn
   into that map (see drawLandmark in render.js).
   ==================================================================== */

window.PP = window.PP || {};

// ---- URL params -----------------------------------------------------
// ?debug=1   -> debug panel, console logging, debug badge
// ?mocksdk=1 -> force the mock SDK even if the real one is present
// ?mute=1    -> mock SDK starts with settings.muteAudio = true
PP.QUERY = (function () {
  const q = {};
  try {
    new URLSearchParams(location.search).forEach((v, k) => { q[k] = v; });
  } catch (e) { /* ignore */ }
  return q;
})();

PP.DEBUG = PP.QUERY.debug === '1';

// ?allmaps=1 (or ?unlockall=1) -> browse/play every district this session
// WITHOUT unlocking them in your save. Purely a preview switch: nothing is
// persisted, so removing the param restores your real progression.
PP.ALL_MAPS = PP.QUERY.allmaps === '1' || PP.QUERY.unlockall === '1';

// ---- Economy / balance ----------------------------------------------
PP.CONFIG = {
  ECON: {
    patchBase: 50,        // base $ per patch (x district payout) — front-loaded so
                          // early districts (cheap fixed unlock costs) feel fast
    speedBonus: 36,       // extra $ if patched the instant it appears
    speedBonusWindow: 15, // seconds over which the speed bonus decays
    comboStep: 0.08,      // +8% funds per combo step
    comboCap: 12,
    repHit: 7,            // reputation lost when a car hits a pothole
    repPatch: 1.5,        // reputation regained per patch
    rewardCooldown: 30,   // seconds the in-run reward button hides for after use
    adFundsReward: 500,   // fallback funds for the home-screen ad (per-location below)

    deployCap: 5,         // max vehicles the player can field in one patrol
    transitChance: 0.20,  // chance a spawned vehicle is the location's transit
  },
};

// ---- Vehicle roster --------------------------------------------------
// The player hires individual vehicles into a fleet, upgrades each one,
// and picks which (up to ECON.deployCap) to field per patrol. Each type
// has its own movement style, fix speed, map restrictions and side-view
// art (see PP.Render.drawVehicleSide + the per-type drawTruck switch).
//
//   movement : 'road'  follows the road network (BFS), keeps to its lane
//              'fly'   straight line to any pothole, ignores roads
//              'dig'   tunnels under the map in a straight line, ignoring
//                      roads, leaving a dirt trail above ground, then
//                      surfaces to patch
//              'teleport' warps instantly to the pothole after a ~1s beam-
//                      out / beam-in animation; ignores roads entirely
//   maps     : 'all' | { only:[locIds] } | { except:[locIds] }
//   unlockAt : locationId where this vehicle becomes hireable, the moment
//              that location is REACHED (its first district unlocked).
//              null = available from the start.
//   base.{speed,patch,turn} : tiles/sec, seconds-to-patch, turn rate in
//              RADIANS/SEC. Turn starts deliberately LOW so a vehicle visibly
//              slows and swings through corners; the handling upgrade speeds
//              that up and is something the player clearly wants.
//   patchFloor : minimum patch time after fix upgrades
//   maxOwned : optional cap on how many of this type you may hire
//   flags : roadClose (shuts the whole road & patches it all at once) |
//           forcesTraffic (shoves traffic aside instead of slowing)
//   upgrades[] : { key, name, affects, step, costs:[t1,t2,t3] }
//                affects: 'speed' | 'turn' | 'patch'
PP.VEHICLES = [
  {
    id: 'basic', name: 'BASIC TRUCK', hireCost: 600,
    blurb: 'Your dependable workhorse. Follows roads to reach potholes. Reliable but not exceptional anywhere.',
    movement: 'road', maps: 'all', unlockAt: null,
    base: { speed: 2.1, patch: 2.8, turn: 1.6 }, patchFloor: 1.6,
    upgrades: [
      { key: 'engine', name: 'Engine', affects: 'speed', step: 0.45, costs: [400, 800, 1500] },
      { key: 'body', name: 'Body', affects: 'turn', step: 0.85, costs: [300, 600, 1200] },
      { key: 'tools', name: 'Tools', affects: 'patch', step: 0.30, costs: [500, 1000, 1900] },
    ],
  },
  {
    id: 'drill', name: 'DRILL', hireCost: 3000,
    blurb: 'Tunnels straight under the map to any pothole — ignoring roads entirely — then surfaces to patch, leaving a churning trail of dirt above ground. Blistering travel speed, but the dig-and-grind repair takes longer than most. Exclusive to Dunes Province — earns +25% cash per pothole.',
    movement: 'dig', maps: { only: ['dunes'] }, unlockAt: 'dunes', earnMult: 1.25,
    base: { speed: 3.6, patch: 3.6, turn: 2.6 }, patchFloor: 2.6,
    upgrades: [
      { key: 'drill', name: 'Drill', affects: 'speed', desc: 'Bores faster — race under the map at higher speed', step: 0.6, costs: [1000, 2000, 3500] },
    ],
  },
  {
    id: 'balloon', name: 'HOT AIR BALLOON', hireCost: 4500,
    blurb: "Drifts directly to any pothole without following roads — no lanes, no corners. Built for Skyhaven's open sky-roads, with a quick fix ceiling. Exclusive to this district — earns +25% cash per pothole.",
    movement: 'fly', maps: { only: ['skyhaven'] }, unlockAt: 'skyhaven', earnMult: 1.25,
    base: { speed: 2.9, patch: 2.4, turn: 2.5 }, patchFloor: 1.2,
    upgrades: [
      { key: 'gas', name: 'Gas Quality', affects: 'speed', step: 0.7, costs: [1500, 3000, 5000] },
      { key: 'toolbox', name: 'Toolbox', affects: 'patch', step: 0.40, costs: [1750, 3500, 6000] },
    ],
  },
  {
    id: 'advanced', name: 'ADVANCED TRUCK', hireCost: 9000,
    blurb: 'Longer and slower than the Basic Truck. When it reaches a pothole it shuts down the entire road — cones across every intersection — and patches every pothole on it at once. Powerful, but you can only run two, and it closes a whole road while it works.',
    movement: 'road', maps: 'all', unlockAt: 'frostvale', maxOwned: 2,
    base: { speed: 1.7, patch: 2.7, turn: 1.4 }, patchFloor: 2.0,
    flags: { roadClose: true },
    upgrades: [
      { key: 'body', name: 'Body', affects: 'turn', step: 0.85, costs: [2500, 5000, 10000] },
      { key: 'crane', name: 'Crane', affects: 'patch', step: 0.40, costs: [3000, 6000, 11000] },
    ],
  },
  {
    id: 'sub', name: 'SUBMARINE', hireCost: 12500,
    blurb: "The only vehicle fast enough to navigate Coral Kingdom's underwater currents. Its speed forces fish to accelerate out of the way rather than the sub slowing for them. Exclusive — earns +25% cash per pothole.",
    movement: 'road', maps: { only: ['coral'] }, unlockAt: 'coral', earnMult: 1.25,
    base: { speed: 3.2, patch: 2.6, turn: 1.6 }, patchFloor: 2.6,
    flags: { forcesTraffic: true },
    upgrades: [
      { key: 'propeller', name: 'Propeller', affects: 'speed', step: 0.7, costs: [3500, 7000, 13000] },
      { key: 'fins', name: 'Fins', affects: 'turn', step: 0.95, costs: [2500, 5000, 9000] },
    ],
  },
  {
    id: 'buggy', name: 'SPACE BUGGY', hireCost: 16000,
    blurb: 'Built for low-gravity lunar terrain. Fast across open craters, with a fix speed to rival a fully upgraded Advanced Truck and an extending patch arm. Exclusive — earns +25% cash per pothole.',
    movement: 'road', maps: { only: ['luna'] }, unlockAt: 'luna', earnMult: 1.25,
    base: { speed: 3.0, patch: 3.0, turn: 1.6 }, patchFloor: 2.0,
    upgrades: [
      { key: 'motor', name: 'Motor', affects: 'speed', step: 0.6, costs: [4500, 9000, 15000] },
      { key: 'body', name: 'Body', affects: 'turn', step: 0.85, costs: [3500, 7000, 12000] },
      { key: 'arms', name: 'Arms', affects: 'patch', step: 0.33, costs: [4000, 8000, 14000] },
    ],
  },
  {
    id: 'teleporter', name: 'TELEPORTER', hireCost: 25000,
    blurb: 'A sleek pod that beams instantly to any pothole in a column of blue light — no roads, no driving, just a one-second warp out and back. Its Terrain Editor mends the road fast. Exclusive to Nexus Core — earns +25% cash per pothole.',
    movement: 'teleport', maps: { only: ['neon'] }, unlockAt: 'neon', earnMult: 1.25,
    base: { speed: 3.0, patch: 2.8, turn: 1.6 }, patchFloor: 1.4,
    upgrades: [
      { key: 'terrain', name: 'Terrain Editor', affects: 'patch', desc: 'Reshapes terrain faster — quicker pothole repairs', step: 0.40, costs: [5000, 10000, 17500] },
    ],
  },
  {
    id: 'magma', name: 'MAGMA CRAWLER', hireCost: 30000,
    blurb: "A heat-shielded tracked crawler whose glowing-hot frame shoves traffic aside instead of slowing for it. Equally at home grinding across Embervale's lava country and Helix Drift's foundry decks — earns +25% cash per pothole on both.",
    movement: 'road', maps: { only: ['ember', 'helix'] }, unlockAt: 'ember', earnMult: 1.25,
    base: { speed: 3.2, patch: 2.6, turn: 1.7 }, patchFloor: 2.2,
    flags: { forcesTraffic: true },
    upgrades: [
      { key: 'treads', name: 'Treads', affects: 'speed', step: 0.6, costs: [4000, 8000, 14000] },
      { key: 'tools', name: 'Tools', affects: 'patch', step: 0.35, costs: [4500, 9000, 15000] },
    ],
  },
  {
    id: 'candyrig', name: 'CANDY RIG', hireCost: 42000,
    blurb: 'A glossy confectionery truck that hauls a bed of gumdrops and patches potholes with sticky sweet filler that sets in a flash. Exclusive to Candytown — earns +25% cash per pothole.',
    movement: 'road', maps: { only: ['candy'] }, unlockAt: 'candy', earnMult: 1.25,
    base: { speed: 3.0, patch: 2.4, turn: 1.7 }, patchFloor: 1.8,
    upgrades: [
      { key: 'engine', name: 'Engine', affects: 'speed', step: 0.6, costs: [5000, 10000, 17000] },
      { key: 'mixer', name: 'Mixer', affects: 'patch', step: 0.35, costs: [5500, 11000, 18000] },
    ],
  },
  {
    id: 'clockwork', name: 'CLOCKWORK RIG', hireCost: 55000,
    blurb: 'A wind-up tin truck that ticks through Toy Town with clockwork precision — fast and razor-sharp through corners. Exclusive to Toy Town — earns +25% cash per pothole.',
    movement: 'road', maps: { only: ['toy'] }, unlockAt: 'toy', earnMult: 1.25,
    base: { speed: 3.4, patch: 2.6, turn: 1.8 }, patchFloor: 1.8,
    upgrades: [
      { key: 'spring', name: 'Mainspring', affects: 'speed', step: 0.6, costs: [6000, 12000, 20000] },
      { key: 'gears', name: 'Gears', affects: 'turn', step: 0.9, costs: [5000, 10000, 17000] },
    ],
  },
  {
    id: 'skiff', name: 'BOG SKIFF', hireCost: 70000,
    blurb: "A flat-bottomed fan-boat that skims the bayou channels on a roaring caged propeller, shoving sluggish traffic aside. Exclusive to Mirewood Hollow — earns +25% cash per pothole.",
    movement: 'road', maps: { only: ['mire'] }, unlockAt: 'mire', earnMult: 1.25,
    base: { speed: 3.2, patch: 2.5, turn: 1.8 }, patchFloor: 2.0,
    flags: { forcesTraffic: true },
    upgrades: [
      { key: 'fan', name: 'Fan', affects: 'speed', step: 0.6, costs: [7000, 14000, 24000] },
      { key: 'tools', name: 'Tools', affects: 'patch', step: 0.35, costs: [7500, 15000, 25000] },
    ],
  },
  {
    id: 'papercrane', name: 'PAPER CRANE', hireCost: 120000,
    blurb: 'A folded origami crane that glides straight over the paper streets to any tear and creases it shut — no roads, no corners. Exclusive to Foldhaven — earns +25% cash per pothole.',
    movement: 'fly', maps: { only: ['fold'] }, unlockAt: 'fold', earnMult: 1.25,
    base: { speed: 2.9, patch: 2.4, turn: 2.5 }, patchFloor: 1.4,
    upgrades: [
      { key: 'wings', name: 'Wings', affects: 'speed', step: 0.7, costs: [13000, 26000, 44000] },
      { key: 'press', name: 'Fold Press', affects: 'patch', step: 0.40, costs: [14000, 28000, 46000] },
    ],
  },
];

// ---- Locations -------------------------------------------------------
PP.LOCATIONS = [
  // ============================ 1. ASPHALTON CITY =====================
  {
    id: 'asphalton',
    name: 'ASPHALTON CITY',
    tagline: 'Leafy suburbs and busy downtown blocks.',
    adReward: 500,
    theme: {
      ground: '#8ed167', groundAlt: '#84c95f',
      road: '#3f444d', curb: '#9aa3ad', line: '#ffc62e',
      buildings: ['#ff9e5a', '#ff7b86', '#ffc861', '#e0954a', '#c3d96b'],
      decor: 'tree', decorA: '#2f8a44', decorB: '#5cc063',
      waterColor: '#3fb6e0', park: 0.36,
      carStyle: 'car', holeStyle: 'pothole', transitColor: '#f2c14e',
    },
    cars: ['#e85d5d', '#5d9fe8', '#e8c45d', '#7fd08a', '#c98ad6', '#e8e3da', '#8a93a6'],
    districts: [
      { id: 'maple', name: 'MAPLE HEIGHTS', tagline: 'Quiet streets. Easy money.', landmark: 'watertower',
        cost: 100, w: 14, h: 9, roadRows: [2, 6], roadCols: [3, 10],
        payout: 1.3, maxPotholes: 9, spawn: { start: 5.0, min: 1.6, ramp: 0.030 },
        carEvery: 2.6, carSpeed: [1.5, 2.2], seed: 7 },
      { id: 'riverside', name: 'RIVERSIDE COMMERCIAL', tagline: 'More lanes, more traffic.', landmark: 'billboard',
        cost: 900, w: 16, h: 10, roadRows: [2, 7], roadCols: [2, 7, 12], water: [0],
        payout: 1.55, maxPotholes: 11, spawn: { start: 4.2, min: 1.3, ramp: 0.038 },
        carEvery: 1.9, carSpeed: [1.7, 2.5], seed: 23 },
      { id: 'downtown', name: 'DOWNTOWN CORE', tagline: 'Rush hour never ends.', landmark: 'skyscraper',
        cost: 1600, w: 18, h: 10, roadRows: [1, 4, 7], roadCols: [2, 6, 10, 14],
        payout: 1.75, maxPotholes: 13, spawn: { start: 3.4, min: 1.0, ramp: 0.050 },
        carEvery: 1.4, carSpeed: [1.9, 2.9], seed: 51 },
    ],
  },

  // ============================ 2. DUNES PROVINCE =====================
  {
    id: 'dunes',
    name: 'DUNES PROVINCE',
    tagline: 'Desert towns where the road sinks into quicksand.',
    adReward: 1200,
    theme: {
      ground: '#f0cd8f', groundAlt: '#e8c281',
      road: '#6b5d4a', curb: '#cdb892', line: '#f2e3c0',
      buildings: ['#e0a974', '#d99a5c', '#c98449', '#e6c08d', '#bd7d46'],
      decor: 'cactus', decorA: '#4f9a4a', decorB: '#6fbf64',
      waterColor: '#45c6d8', park: 0.30,
      carStyle: 'car', holeStyle: 'quicksand', transitColor: '#caa14a',
    },
    cars: ['#d98b4f', '#c2a36b', '#b56b3f', '#e0c98a', '#8a5a3a', '#5f8a7a', '#d6c2a0'],
    districts: [
      { id: 'dunes-oasis', name: 'OASIS ROW', tagline: 'Slow desert traffic — for now.', landmark: 'palm',
        cost: 2500, w: 15, h: 9, roadRows: [2, 6], roadCols: [3, 11],
        payout: 1.95, maxPotholes: 10, spawn: { start: 4.6, min: 1.4, ramp: 0.034 },
        carEvery: 2.3, carSpeed: [1.6, 2.4], seed: 101 },
      { id: 'dunes-market', name: 'MARKET DISTRICT', tagline: 'Bustling bazaar crossroads.', landmark: 'minaret',
        cost: 4200, w: 17, h: 10, roadRows: [2, 7], roadCols: [2, 8, 13],
        payout: 2.15, maxPotholes: 12, spawn: { start: 3.9, min: 1.2, ramp: 0.040 },
        carEvery: 1.8, carSpeed: [1.7, 2.6], seed: 113 },
      { id: 'dunes-core', name: 'SANDSTORM CORE', tagline: 'Grit, heat and gridlock.', landmark: 'pyramid',
        cost: 6000, w: 18, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13],
        payout: 2.4, maxPotholes: 14, spawn: { start: 3.2, min: 0.95, ramp: 0.052 },
        carEvery: 1.4, carSpeed: [1.9, 3.0], seed: 127 },
    ],
  },

  // ============================ 3. SKYHAVEN (above the clouds) ========
  {
    id: 'skyhaven',
    name: 'SKYHAVEN',
    tagline: 'A kingdom on the clouds — birds for traffic, tornados for potholes.',
    adReward: 2500,
    theme: {
      // pale cloud "platforms" (ground), open-sky lanes (road) the birds fly
      ground: '#eaf4ff', groundAlt: '#dfeefc',
      road: '#7ec3ef', curb: '#ffffff', line: '#ffffff',
      buildings: ['#bfe0ff', '#f6c9e0', '#d8c9f6', '#c9f0e8', '#ffe6b0'],
      decor: 'cloud', decorA: '#ffffff', decorB: '#cfe2f5',
      waterColor: '#3f9ad8', park: 0.42,                 // open blue = gaps in the clouds
      carStyle: 'bird', holeStyle: 'tornado', transitColor: '#e8ddc4',
      fx: { type: 'clouds', color: 'rgba(255,255,255,0.55)', n: 9 },
    },
    cars: ['#ff6b5e', '#5fb0ff', '#ffd24d', '#6be08a', '#c08aff', '#ffffff', '#ff9a3d'],
    districts: [
      { id: 'sky-commons', name: 'CIRRUS COMMONS', tagline: 'Gentle breezes over the high meadows.', landmark: 'balloon',
        cost: 7500, w: 15, h: 9, roadRows: [2, 6], roadCols: [3, 11],
        payout: 2.7, maxPotholes: 11, spawn: { start: 4.2, min: 1.25, ramp: 0.038 },
        carEvery: 1.9, carSpeed: [1.7, 2.6], seed: 301 },
      { id: 'sky-market', name: 'STORMGATE MARKET', tagline: 'Sky bazaars beside the open blue.', landmark: 'windmill',
        cost: 9800, w: 17, h: 10, roadRows: [2, 7], roadCols: [2, 8, 13], water: [0],
        payout: 3.0, maxPotholes: 13, spawn: { start: 3.5, min: 1.05, ramp: 0.045 },
        carEvery: 1.6, carSpeed: [1.9, 2.8], seed: 313 },
      { id: 'sky-core', name: 'TEMPEST CROWN', tagline: 'Endless gales over the cloud capital.', landmark: 'cloudcastle',
        cost: 11500, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17],
        payout: 3.35, maxPotholes: 15, spawn: { start: 2.9, min: 0.85, ramp: 0.058 },
        carEvery: 1.2, carSpeed: [2.0, 3.2], seed: 327 },
    ],
  },

  // ============================ 4. OLD LONDINIUM ======================
  {
    id: 'londinium',
    name: 'OLD LONDINIUM',
    tagline: 'Foggy brick lanes, red double-deckers and black cabs.',
    adReward: 4500,
    theme: {
      ground: '#8b9187', groundAlt: '#838a80',
      road: '#3a3d42', curb: '#9aa0a6', line: '#e8e8e8',
      buildings: ['#7d4b42', '#9a6b5f', '#6b6f76', '#85564a', '#5e6168'],
      decor: 'hedge', decorA: '#3f5c3a', decorB: '#4f6f47',
      waterColor: '#5a6f7a', park: 0.26,
      carStyle: 'car', holeStyle: 'pothole', transitColor: '#c0392b',
      fx: { type: 'fog', color: 'rgba(210,214,210,0.05)', n: 7 },
    },
    cars: ['#1f2226', '#c0392b', '#2d3a4a', '#6b7178', '#8a1f1f', '#3a4a3a', '#d8d2c4'],
    districts: [
      { id: 'london-cobble', name: 'COBBLE LANE', tagline: 'Narrow, drizzly and cobbled.', landmark: 'phonebox',
        cost: 13000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], water: [0],
        payout: 3.7, maxPotholes: 11, spawn: { start: 4.4, min: 1.3, ramp: 0.036 },
        carEvery: 2.1, carSpeed: [1.5, 2.3], seed: 201 },
      { id: 'london-thames', name: 'THAMES CROSSING', tagline: 'Bridges, buses and Big Ben.', landmark: 'bigben',
        cost: 14800, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], water: [0],
        payout: 4.15, maxPotholes: 13, spawn: { start: 3.7, min: 1.1, ramp: 0.042 },
        carEvery: 1.7, carSpeed: [1.7, 2.6], seed: 213 },
      { id: 'london-core', name: 'WESTMINSTER CORE', tagline: 'The capital at full tilt.', landmark: 'londoneye',
        cost: 16200, w: 19, h: 10, roadRows: [1, 4, 7], roadCols: [3, 7, 11, 15],
        payout: 4.55, maxPotholes: 15, spawn: { start: 3.0, min: 0.9, ramp: 0.055 },
        carEvery: 1.3, carSpeed: [1.9, 3.0], seed: 227 },
    ],
  },

  // ============================ 5. FROSTVALE ==========================
  {
    id: 'frostvale',
    name: 'FROSTVALE',
    tagline: 'Snowy pines and cracked, frozen roads.',
    adReward: 8000,
    theme: {
      ground: '#dfe8ef', groundAlt: '#d4dde6',
      road: '#4a525c', curb: '#eef4f8', line: '#cfd8df',
      buildings: ['#6b7d8c', '#5a6b78', '#8295a3', '#4f5e69', '#73838f'],
      decor: 'pine', decorA: '#3f6b4f', decorB: '#2f5640',
      waterColor: '#bcd9e8', park: 0.32,
      carStyle: 'car', holeStyle: 'ice', transitColor: '#e8a33d',
      fx: { type: 'snow', color: 'rgba(255,255,255,0.9)', n: 70 },
    },
    cars: ['#6b8ca3', '#b5483f', '#7d8b96', '#4f6b7d', '#c7d2da', '#5a6e62', '#a36b6b'],
    districts: [
      { id: 'frost-pine', name: 'PINE HOLLOW', tagline: 'Crisp air, careful drivers.', landmark: 'cabin',
        cost: 17500, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11],
        payout: 5.2, maxPotholes: 11, spawn: { start: 4.0, min: 1.2, ramp: 0.040 },
        carEvery: 2.0, carSpeed: [1.4, 2.2], seed: 401 },
      { id: 'frost-lake', name: 'FROZEN LAKE', tagline: 'Icy crossings and snowdrifts.', landmark: 'lighthouse',
        cost: 23000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], water: [0],
        payout: 5.9, maxPotholes: 13, spawn: { start: 3.3, min: 1.0, ramp: 0.048 },
        carEvery: 1.5, carSpeed: [1.6, 2.5], seed: 413 },
      { id: 'frost-core', name: 'GLACIER CORE', tagline: 'The frozen city that never sleeps.', landmark: 'icespire',
        cost: 29000, w: 19, h: 11, roadRows: [1, 4, 8], roadCols: [3, 8, 13, 17],
        payout: 6.55, maxPotholes: 15, spawn: { start: 2.7, min: 0.8, ramp: 0.060 },
        carEvery: 1.2, carSpeed: [1.8, 3.0], seed: 427 },
    ],
  },

  // ============================ 6. CORAL KINGDOM (underwater) =========
  {
    id: 'coral',
    name: 'CORAL KINGDOM',
    tagline: 'An undersea city — fish for traffic, geysers for potholes.',
    adReward: 14000,
    theme: {
      ground: '#9fc6b0', groundAlt: '#95bca6',
      road: '#5f7d72', curb: '#bfe0d0', line: '#dff5ec',
      buildings: ['#ff8a6b', '#ff6f9a', '#ffb36b', '#9b6bff', '#5fc5c5'],
      decor: 'coral', decorA: '#ff7a9a', decorB: '#ffb86b',
      waterColor: '#3aa6c4', park: 0.40,
      carStyle: 'fish', holeStyle: 'geyser', transitColor: '#6fb0d8',
      tint: 'rgba(30,110,160,0.18)',
      fx: { type: 'bubbles', color: 'rgba(220,245,255,0.5)', n: 40 },
    },
    cars: ['#ff8a3d', '#5fd0ff', '#ffd24d', '#ff5f8a', '#9b6bff', '#ffffff', '#6bffb0'],
    districts: [
      { id: 'coral-reef', name: 'REEF GARDENS', tagline: 'Schools of fish drift past the coral.', landmark: 'clam',
        cost: 35000, w: 15, h: 9, roadRows: [2, 6], roadCols: [3, 11],
        payout: 7.95, maxPotholes: 12, spawn: { start: 4.0, min: 1.2, ramp: 0.040 },
        carEvery: 1.9, carSpeed: [1.5, 2.4], seed: 501 },
      { id: 'coral-lagoon', name: 'LAGOON MARKET', tagline: 'Crowded currents and trade routes.', landmark: 'shipwreck',
        cost: 45000, w: 17, h: 10, roadRows: [2, 7], roadCols: [2, 8, 13],
        payout: 8.9, maxPotholes: 14, spawn: { start: 3.3, min: 1.0, ramp: 0.048 },
        carEvery: 1.5, carSpeed: [1.7, 2.7], seed: 513 },
      { id: 'coral-abyss', name: 'ABYSS CAPITAL', tagline: 'The deep city, geysers everywhere.', landmark: 'poseidon',
        cost: 55000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17],
        payout: 9.9, maxPotholes: 16, spawn: { start: 2.7, min: 0.8, ramp: 0.060 },
        carEvery: 1.2, carSpeed: [1.9, 3.0], seed: 527 },
    ],
  },

  // ============================ 7. LUNA BASE (the moon) ===============
  {
    id: 'luna',
    name: 'LUNA BASE',
    tagline: 'Moon colony — rovers and shuttles dodge meteor craters.',
    adReward: 24000,
    theme: {
      ground: '#9a9aa2', groundAlt: '#90909a',
      road: '#5a5a64', curb: '#c4c4cc', line: '#ffd14a',
      buildings: ['#c0c4cc', '#9aa0aa', '#7d8590', '#aeb4be', '#d0d4da'],
      decor: 'rock', decorA: '#6a6a72', decorB: '#86868f',
      waterColor: '#5a6f7a', park: 0.34,
      carStyle: 'rover', holeStyle: 'meteor', transitColor: '#d0d4da',
      tint: 'rgba(18,18,44,0.16)',
      fx: { type: 'stars', color: 'rgba(255,255,255,0.9)', n: 90 },
    },
    cars: ['#d0d4da', '#ff5f5f', '#5fd0ff', '#ffd24d', '#b0b6c0', '#9b6bff', '#ffffff'],
    districts: [
      { id: 'luna-landing', name: 'LANDING ZONE', tagline: 'First boots on the regolith.', landmark: 'lander',
        cost: 65000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11],
        payout: 12.0, maxPotholes: 12, spawn: { start: 3.9, min: 1.15, ramp: 0.042 },
        carEvery: 1.9, carSpeed: [1.5, 2.4], seed: 601 },
      { id: 'luna-crater', name: 'CRATER COLONY', tagline: 'Domes ringed by impact sites.', landmark: 'dome',
        cost: 82000, w: 17, h: 10, roadRows: [2, 7], roadCols: [3, 9, 14],
        payout: 13.3, maxPotholes: 14, spawn: { start: 3.2, min: 0.95, ramp: 0.050 },
        carEvery: 1.5, carSpeed: [1.7, 2.7], seed: 613 },
      { id: 'luna-base', name: 'TRANQUILITY CORE', tagline: 'Meteor showers over the capital.', landmark: 'rocket',
        cost: 98000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17],
        payout: 15.2, maxPotholes: 16, spawn: { start: 2.6, min: 0.78, ramp: 0.062 },
        carEvery: 1.2, carSpeed: [1.9, 3.1], seed: 627 },
    ],
  },

  // ============================ 8. NEON NEXUS (cyber city) ============
  {
    id: 'neon',
    name: 'NEON NEXUS',
    tagline: 'A cyber metropolis of hover-cars and energy rifts.',
    adReward: 40000,
    theme: {
      ground: '#20233a', groundAlt: '#1b1e33',
      road: '#14162a', curb: '#3df0ff', line: '#ff3df0',
      buildings: ['#5a2d6a', '#2d5a6a', '#6a2d4a', '#2d6a4a', '#41416a'],
      decor: 'pylon', decorA: '#3df0ff', decorB: '#ff3df0',
      waterColor: '#2d6a8a', park: 0.30,
      carStyle: 'hover', holeStyle: 'rift', transitColor: '#b54dff',
      tint: 'rgba(40,0,70,0.20)',
      fx: { type: 'sparks', color: 'rgba(120,240,255,0.8)', n: 46 },
    },
    cars: ['#ff3df0', '#3df0ff', '#b54dff', '#4dff9e', '#ffd24d', '#ff6f6f', '#ffffff'],
    districts: [
      { id: 'neon-grid', name: 'GRID SECTOR', tagline: 'Hover-cars hum down the data lanes.', landmark: 'hologram',
        cost: 110000, w: 15, h: 9, roadRows: [2, 6], roadCols: [3, 11],
        payout: 18.0, maxPotholes: 13, spawn: { start: 3.7, min: 1.1, ramp: 0.044 },
        carEvery: 1.8, carSpeed: [1.7, 2.7], seed: 701 },
      { id: 'neon-market', name: 'HOLO MARKET', tagline: 'Neon bazaars and rift surges.', landmark: 'neonarch',
        cost: 145000, w: 17, h: 10, roadRows: [2, 7], roadCols: [2, 8, 13],
        payout: 20.5, maxPotholes: 15, spawn: { start: 3.0, min: 0.9, ramp: 0.054 },
        carEvery: 1.4, carSpeed: [1.9, 3.0], seed: 713 },
      { id: 'neon-core', name: 'NEXUS CORE', tagline: 'The final gauntlet of the grid.', landmark: 'reactor',
        cost: 185000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17],
        payout: 24.0, maxPotholes: 17, spawn: { start: 2.5, min: 0.72, ramp: 0.066 },
        carEvery: 1.1, carSpeed: [2.0, 3.3], seed: 727 },
    ],
  },

  // ============================ 9. EMBERVALE (volcano) ===============
  {
    id: 'ember',
    name: 'EMBERVALE',
    tagline: 'A volcano basin where the road keeps cracking open over molten rock.',
    adReward: 65000,
    theme: {
      ground: '#3a322f', groundAlt: '#332b29',
      road: '#2a2422', curb: '#5a4a42', line: '#ff8a3a',
      buildings: ['#5a4038', '#6e4a3a', '#7a3a2a', '#4a3530', '#8a5a3a'],
      decor: 'basaltspire', decorA: '#2a2420', decorB: '#ff7a2a',
      waterColor: '#ff6a2a', park: 0.32,
      carStyle: 'cinderhauler', holeStyle: 'lavacrack', transitColor: '#e0703a', blockStyle: 'rock',
      tint: 'rgba(80,20,0,0.16)',
      fx: { type: 'sparks', color: 'rgba(255,150,50,0.8)', n: 40 },
    },
    cars: ['#ff7a3a', '#ff6048', '#ffa24a', '#e8c25a', '#ff9152', '#ff8a6a', '#f0b85a'],
    districts: [
      { id: 'ember-flats', name: 'LAVA FLATS', tagline: 'Molten channels run beside the lanes.', landmark: 'volcano',
        cost: 220000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], feature: { type: 'molten', rows: [4] },
        payout: 27.0, maxPotholes: 13, spawn: { start: 3.6, min: 1.1, ramp: 0.046 },
        carEvery: 1.7, carSpeed: [1.6, 2.6], seed: 801 },
      { id: 'ember-canyon', name: 'DARK CANYON', tagline: 'A black obsidian rift splits the town.', landmark: 'obsidian',
        cost: 270000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], feature: { type: 'chasm', rows: [5] },
        payout: 30.0, maxPotholes: 15, spawn: { start: 3.0, min: 0.9, ramp: 0.054 },
        carEvery: 1.4, carSpeed: [1.8, 2.9], seed: 813 },
      { id: 'ember-core', name: 'ASHFALL', tagline: 'Cracked, smoldering ground underfoot.', landmark: 'forge',
        cost: 330000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17], feature: { type: 'ash', rows: [6] },
        payout: 33.0, maxPotholes: 17, spawn: { start: 2.5, min: 0.72, ramp: 0.066 },
        carEvery: 1.1, carSpeed: [2.0, 3.3], seed: 827 },
    ],
  },

  // ============================ 10. CANDYTOWN (sweets) ==============
  {
    id: 'candy',
    name: 'CANDYTOWN',
    tagline: 'Frosting streets and gumdrop traffic through a town made of sweets.',
    adReward: 90000,
    theme: {
      ground: '#ffe0ea', groundAlt: '#ffd5e2',
      road: '#f4e4d0', curb: '#ffffff', line: '#ff9ec2',
      buildings: ['#ff8ab0', '#8ad6c0', '#ffd36b', '#c79bff', '#ff9e7a'],
      decor: 'lollipop', decorA: '#ffffff', decorB: '#ff5d8a',
      waterColor: '#7a4a2a', park: 0.40,
      carStyle: 'gumdrop', holeStyle: 'crackle', transitColor: '#ff7ab0', blockStyle: 'candy',
      fx: { type: 'petals', color: 'rgba(255,180,210,0.85)', n: 44 },
    },
    cars: ['#ff5d8a', '#5fd0c4', '#ffd24d', '#9b6bff', '#ff8a5d', '#7ad0ff', '#ff9ec2'],
    districts: [
      { id: 'candy-choco', name: 'CHOCO RIVER', tagline: 'A chocolate river winds through.', landmark: 'gingerbread',
        cost: 400000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], feature: { type: 'choco', rows: [4] },
        payout: 37.0, maxPotholes: 13, spawn: { start: 3.5, min: 1.05, ramp: 0.048 },
        carEvery: 1.7, carSpeed: [1.5, 2.5], seed: 901 },
      { id: 'candy-syrup', name: 'SYRUP SPRINGS', tagline: 'Sticky syrup pools by the road.', landmark: 'candyfountain',
        cost: 480000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], feature: { type: 'syrup', rows: [5] },
        payout: 41.0, maxPotholes: 15, spawn: { start: 2.9, min: 0.88, ramp: 0.056 },
        carEvery: 1.4, carSpeed: [1.7, 2.8], seed: 913 },
      { id: 'candy-core', name: 'WAFER HILLS', tagline: 'Crunchy wafer ridges everywhere.', landmark: 'cakespire',
        cost: 580000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17], feature: { type: 'wafer', rows: [6] },
        payout: 45.0, maxPotholes: 17, spawn: { start: 2.4, min: 0.7, ramp: 0.068 },
        carEvery: 1.1, carSpeed: [1.9, 3.2], seed: 927 },
    ],
  },

  // ============================ 11. TOY TOWN (wind-up toys) =========
  {
    id: 'toy',
    name: 'TOY TOWN',
    tagline: 'A bright clockwork town where wind-up tin cars tick along the playmat.',
    adReward: 140000,
    theme: {
      ground: '#7ec96b', groundAlt: '#74bf61',
      road: '#c0c6cc', curb: '#ff5d5d', line: '#ffd24d',
      buildings: ['#ff5d5d', '#5d9fe8', '#ffd24d', '#7fd08a', '#ff9e3d'],
      decor: 'toyblock', decorA: '#ff5d5d', decorB: '#5d9fe8',
      waterColor: '#5fb0e8', park: 0.40,
      carStyle: 'windup', holeStyle: 'gearpit', transitColor: '#ffcf3a', blockStyle: 'gift',
      fx: { type: 'sparks', color: 'rgba(255,240,180,0.7)', n: 24 },
    },
    cars: ['#ff5d5d', '#5d9fe8', '#ffd24d', '#7fd08a', '#c98ad6', '#ff9e3d', '#ffffff'],
    districts: [
      { id: 'toy-music', name: 'MUSIC BOX', tagline: 'A clockwork turntable spins downtown.', landmark: 'clock',
        cost: 700000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], feature: { type: 'turntable', rows: [4] },
        payout: 50.0, maxPotholes: 13, spawn: { start: 3.4, min: 1.0, ramp: 0.050 },
        carEvery: 1.6, carSpeed: [1.6, 2.6], seed: 1001 },
      { id: 'toy-marble', name: 'MARBLE RUN', tagline: 'A marble channel rolls past.', landmark: 'jackbox',
        cost: 850000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], feature: { type: 'marble', rows: [5] },
        payout: 55.0, maxPotholes: 15, spawn: { start: 2.8, min: 0.85, ramp: 0.058 },
        carEvery: 1.3, carSpeed: [1.8, 2.9], seed: 1013 },
      { id: 'toy-core', name: 'DOMINO ROW', tagline: 'Standing dominoes line the lanes.', landmark: 'carousel',
        cost: 1000000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17], feature: { type: 'domino', rows: [6] },
        payout: 61.0, maxPotholes: 17, spawn: { start: 2.3, min: 0.68, ramp: 0.070 },
        carEvery: 1.0, carSpeed: [2.0, 3.3], seed: 1027 },
    ],
  },

  // ============================ 12. MIREWOOD HOLLOW (bayou) =========
  {
    id: 'mire',
    name: 'MIREWOOD HOLLOW',
    tagline: 'A drowsy black-water bayou of leaning stilt-shacks where the ground always seems to be breathing.',
    adReward: 200000,
    theme: {
      ground: '#4f5e3a', groundAlt: '#46532f',
      road: '#4a4332', curb: '#7a7e5c', line: '#9bbf6e',
      buildings: ['#6b5240', '#7d6a4a', '#5a6b4a', '#8a6b3f', '#4f5e44'],
      decor: 'cypressknee', decorA: '#5a4632', decorB: '#8aa06a',
      waterColor: '#3a4a3e', park: 0.42,
      carStyle: 'airboat', holeStyle: 'gasvent', transitColor: '#5a8a6a', blockStyle: 'shack',
      tint: 'rgba(40,60,30,0.12)',
      fx: { type: 'fireflies', color: 'rgba(190,255,120,0.85)', n: 28 },
    },
    cars: ['#6a8a4a', '#7d9a5a', '#5a7a6a', '#8a9a4a', '#6e8a7a', '#9aaa5a', '#7a8a6a'],
    districts: [
      { id: 'mire-shallows', name: 'CYPRESS SHALLOWS', tagline: 'Mirror-still black water doubles the shacks above.', landmark: 'stillhouse',
        cost: 1150000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], feature: { type: 'bog', rows: [4] },
        payout: 68.0, maxPotholes: 13, spawn: { start: 3.6, min: 1.1, ramp: 0.046 },
        carEvery: 1.7, carSpeed: [1.5, 2.4], seed: 1101 },
      { id: 'mire-tangle', name: 'MANGROVE TANGLE', tagline: 'Sticky root-maze mudflats — neither land nor water.', landmark: 'roottower',
        cost: 1400000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], feature: { type: 'mud', rows: [5] },
        payout: 75.0, maxPotholes: 15, spawn: { start: 3.0, min: 0.9, ramp: 0.054 },
        carEvery: 1.4, carSpeed: [1.7, 2.7], seed: 1113 },
      { id: 'mire-chapel', name: 'SUNKEN CHAPEL', tagline: 'The capital sinks into a quaking grey bog.', landmark: 'drownedspire',
        cost: 1700000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17], feature: { type: 'peat', rows: [6] },
        payout: 83.0, maxPotholes: 17, spawn: { start: 2.5, min: 0.72, ramp: 0.066 },
        carEvery: 1.1, carSpeed: [1.9, 3.0], seed: 1127 },
    ],
  },

  // ============================ 13. HELIX DRIFT (asteroid station) ==
  {
    id: 'helix',
    name: 'HELIX DRIFT',
    tagline: 'A grinding asteroid-belt mining station where the road is a catwalk and a hull breach vents you to the void.',
    adReward: 300000,
    theme: {
      ground: '#2e333b', groundAlt: '#272b32',
      road: '#3a4049', curb: '#7a828c', line: '#e8a23a',
      buildings: ['#5a626c', '#444b54', '#6e5a4a', '#3f4650', '#828a94'],
      decor: 'oreknob', decorA: '#5a606a', decorB: '#e8a23a',
      waterColor: '#1a2740', park: 0.34,
      carStyle: 'maghauler', holeStyle: 'breach', transitColor: '#8a929c', blockStyle: 'crate',
      tint: 'rgba(20,30,55,0.18)',
      fx: { type: 'snow', color: 'rgba(200,205,215,0.45)', n: 30 },
    },
    cars: ['#8a929c', '#6e7682', '#a0a8b2', '#5a626c', '#c0c6ce', '#7a828c', '#9aa2ac'],
    districts: [
      { id: 'helix-slag', name: 'SLAG BELT', tagline: 'Ore trundles across a living conveyor.', landmark: 'gantry',
        cost: 2000000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], feature: { type: 'conveyor', rows: [4] },
        payout: 92.0, maxPotholes: 13, spawn: { start: 3.5, min: 1.05, ramp: 0.048 },
        carEvery: 1.6, carSpeed: [1.6, 2.6], seed: 1201 },
      { id: 'helix-ring', name: 'TETHER RING', tagline: 'The deck plating is simply gone — open void.', landmark: 'dockarm',
        cost: 2400000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], feature: { type: 'void', rows: [5] },
        payout: 102.0, maxPotholes: 15, spawn: { start: 2.9, min: 0.88, ramp: 0.056 },
        carEvery: 1.4, carSpeed: [1.8, 2.8], seed: 1213 },
      { id: 'helix-core', name: 'CORE FOUNDRY', tagline: 'Molten smelt bathes the deck in furnace orange.', landmark: 'refinery',
        cost: 2900000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17], feature: { type: 'molten', rows: [6] },
        payout: 113.0, maxPotholes: 17, spawn: { start: 2.4, min: 0.7, ramp: 0.068 },
        carEvery: 1.1, carSpeed: [2.0, 3.2], seed: 1227 },
    ],
  },

  // ============================ 14. FOLDHAVEN (paper world) ========
  {
    id: 'fold',
    name: 'FOLDHAVEN',
    tagline: 'An entire world of folded construction paper, where origami crane-cars glide on kraft-paper streets that can tear.',
    adReward: 450000,
    theme: {
      ground: '#d9c4a0', groundAlt: '#cdb791',
      road: '#4a4640', curb: '#a89a82', line: '#ffffff',
      buildings: ['#e8806b', '#6bb0e8', '#f2d06b', '#9bd86b', '#c88ad6'],
      decor: 'papertree', decorA: '#cd8a5a', decorB: '#e89a6a',
      waterColor: '#8ec8e8', park: 0.40,
      carStyle: 'origami', holeStyle: 'tear', transitColor: '#e8806b', blockStyle: 'paper',
      tint: 'rgba(120,100,70,0.08)',
      fx: { type: 'petals', color: 'rgba(245,235,215,0.85)', n: 40 },
    },
    cars: ['#e8806b', '#6bb0e8', '#f2d06b', '#9bd86b', '#c88ad6', '#ff9e7a', '#7ad0c0'],
    districts: [
      { id: 'fold-crease', name: 'CREASE QUARTER', tagline: 'A crisp paper canyon folds through the streets.', landmark: 'paperpagoda',
        cost: 3400000, w: 15, h: 9, roadRows: [2, 6], roadCols: [4, 11], feature: { type: 'foldtrench', rows: [4] },
        payout: 125.0, maxPotholes: 13, spawn: { start: 3.4, min: 1.0, ramp: 0.050 },
        carEvery: 1.6, carSpeed: [1.6, 2.6], seed: 1301 },
      { id: 'fold-popup', name: 'POP-UP PARK', tagline: 'Paper panels spring upright like a pop-up book.', landmark: 'popupcastle',
        cost: 4000000, w: 17, h: 10, roadRows: [3, 7], roadCols: [3, 9, 14], feature: { type: 'foldridge', rows: [5] },
        payout: 138.0, maxPotholes: 15, spawn: { start: 2.8, min: 0.85, ramp: 0.058 },
        carEvery: 1.3, carSpeed: [1.8, 2.9], seed: 1313 },
      { id: 'fold-capital', name: 'ORIGAMI CAPITAL', tagline: 'Even the water is paper — boats slide over creased waves.', landmark: 'cranespire',
        cost: 4800000, w: 19, h: 11, roadRows: [2, 5, 8], roadCols: [3, 8, 13, 17], feature: { type: 'paperwater', rows: [6] },
        payout: 152.0, maxPotholes: 17, spawn: { start: 2.3, min: 0.68, ramp: 0.070 },
        carEvery: 1.1, carSpeed: [2.0, 3.2], seed: 1327 },
    ],
  },
];

// ---- Flatten into the ordered district list -------------------------
PP.DISTRICTS = [];
PP.LOCATIONS.forEach((loc) => {
  loc.districts.forEach((d) => {
    d.locationId = loc.id;
    d.locationName = loc.name;
    d.theme = loc.theme;
    d.carColors = loc.cars;
    if (!d.water) d.water = [];
    PP.DISTRICTS.push(d);
  });
});

// ---- Tutorial "training yard" ---------------------------------------
// A hidden test district used ONLY by the first-run tutorial. It shares
// MAPLE HEIGHTS' exact road layout (4 roads), but strips everything else:
// no buildings, no trees, no landmark, no water — just the roads on a flat
// grey slab. `tutorial: true` makes game.js skip all automatic pothole/
// traffic spawning so the tutorial can place each one by hand. It is NOT in
// PP.DISTRICTS, so it never shows on the patrol/travel menu.
PP.TUTORIAL_DISTRICT = {
  id: '__tutorial__', name: 'TRAINING YARD', tagline: '',
  locationId: '__tutorial__', locationName: 'TRAINING',
  tutorial: true,
  cost: 0, w: 14, h: 9, roadRows: [2, 6], roadCols: [3, 10], water: [],
  landmark: null, payout: 1, maxPotholes: 9,
  spawn: { start: 9999, min: 9999, ramp: 0 },   // never auto-spawns (tutorial drives it)
  carEvery: 9999, carSpeed: [1.2, 1.2], seed: 7,
  theme: {
    ground: '#9aa0a6', groundAlt: '#9aa0a6',     // identical -> one flat grey slab
    road: '#41454d', curb: '#c6ccd2', line: '#ffc62e',
    buildings: ['#9aa0a6'], decor: 'tree', decorA: '#9aa0a6', decorB: '#9aa0a6',
    waterColor: '#4f9fce', park: 0,
    carStyle: 'car', holeStyle: 'pothole', transitColor: '#f2c14e',
    flat: true,                                  // render.js: plain grey ground, no decor/blocks
  },
  carColors: ['#e85d5d'],                        // the tutorial's lone red car
};

// ---- Landmark metadata ----------------------------------------------
// Per landmark type: visual `scale` (× the entity unit), `count` placed on
// the map (small props repeat), `tall` = how many road tiles above its
// footprint it occludes (potholes won't spawn there), and optional
// `foot:[w,h]` = the tile area it occupies (whole block reserved, structure
// centred over it).
PP.LANDMARK_META = {
  watertower: { scale: 0.80, count: 1, tall: 2 },
  billboard:  { scale: 0.85, count: 1, tall: 2 },
  skyscraper: { scale: 0.95, count: 1, tall: 2 },
  palm:       { scale: 0.70, count: 2, tall: 1 },
  minaret:    { scale: 0.80, count: 1, tall: 2 },
  pyramid:    { scale: 0.62, count: 1, tall: 2 },
  balloon:    { scale: 0.72, count: 2, tall: 2 },
  windmill:   { scale: 0.85, count: 1, tall: 2 },
  cloudcastle:{ scale: 0.95, count: 1, tall: 2 },
  phonebox:   { scale: 0.45, count: 3, tall: 1 },
  bigben:     { scale: 0.95, count: 1, tall: 2 },
  londoneye:  { scale: 0.90, count: 1, tall: 2 },
  cabin:      { scale: 0.80, count: 2, tall: 1 },
  lighthouse: { scale: 0.90, count: 1, tall: 2 },
  icespire:   { scale: 1.20, count: 1, tall: 1, foot: [2, 2] },
  clam:       { scale: 0.60, count: 2, tall: 1 },
  shipwreck:  { scale: 0.85, count: 1, tall: 1 },
  poseidon:   { scale: 0.85, count: 1, tall: 2 },
  lander:     { scale: 0.70, count: 2, tall: 1 },
  dome:       { scale: 0.60, count: 2, tall: 1 },
  rocket:     { scale: 0.90, count: 1, tall: 2 },
  hologram:   { scale: 0.65, count: 2, tall: 1 },
  neonarch:   { scale: 0.60, count: 1, tall: 2 },
  reactor:    { scale: 0.95, count: 1, tall: 2 },
  volcano:      { scale: 0.95, count: 1, tall: 2 },
  obsidian:     { scale: 0.80, count: 1, tall: 2 },
  forge:        { scale: 0.85, count: 1, tall: 2 },
  gingerbread:  { scale: 0.85, count: 1, tall: 2 },
  candyfountain:{ scale: 0.78, count: 1, tall: 2 },
  cakespire:    { scale: 0.90, count: 1, tall: 2 },
  clock:        { scale: 0.85, count: 1, tall: 2 },
  jackbox:      { scale: 0.70, count: 2, tall: 1 },
  carousel:     { scale: 0.90, count: 1, tall: 2 },
  stillhouse:   { scale: 0.78, count: 2, tall: 1 },
  roottower:    { scale: 0.95, count: 1, tall: 2 },
  drownedspire: { scale: 0.90, count: 1, tall: 2 },
  gantry:       { scale: 0.95, count: 1, tall: 2 },
  dockarm:      { scale: 0.85, count: 1, tall: 2 },
  refinery:     { scale: 0.95, count: 1, tall: 2 },
  paperpagoda:  { scale: 0.85, count: 1, tall: 2 },
  popupcastle:  { scale: 0.90, count: 1, tall: 2 },
  cranespire:   { scale: 0.95, count: 1, tall: 2 },
};

PP.firstDistrictId = PP.DISTRICTS[0].id;          // always unlocked at the start
PP.districtById = (id) => PP.DISTRICTS.find((d) => d.id === id);
PP.districtIndex = (id) => PP.DISTRICTS.findIndex((d) => d.id === id);
PP.locationById = (id) => PP.LOCATIONS.find((l) => l.id === id);

// ---- Vehicle helpers -------------------------------------------------
PP.vehicleById = (id) => PP.VEHICLES.find((v) => v.id === id);

// Is `def` hireable/usable on the given location?
PP.vehicleAllowedOn = function (def, locationId) {
  const m = def && def.maps;
  if (!m || m === 'all') return true;
  if (m.only) return m.only.includes(locationId);
  if (m.except) return !m.except.includes(locationId);
  return true;
};

// Has the player REACHED `locId` (unlocked at least its first district)?
PP.locationReached = function (locId, unlocked) {
  const loc = PP.locationById(locId);
  if (!loc) return false;
  return loc.districts.some((d) => unlocked.includes(d.id));
};

// Is this vehicle type available to hire yet? (its world has been reached)
PP.vehicleUnlocked = function (def, unlocked) {
  return !def.unlockAt || PP.locationReached(def.unlockAt, unlocked);
};

// Human-readable map restriction (for the hire carousel).
PP.vehicleMapsLabel = function (def) {
  const m = def && def.maps;
  if (!m || m === 'all') return 'All districts';
  const names = (ids) => ids.map((id) => { const l = PP.locationById(id); return l ? l.name : id; }).join(', ');
  if (m.only) return m.only.length === 1 ? names(m.only) + ' only' : 'Only: ' + names(m.only);
  if (m.except) return 'All except ' + names(m.except);
  return 'All districts';
};

// Home-screen ad reward scales with the current location (prices rise).
PP.adRewardFor = function (districtId) {
  const d = PP.districtById(districtId);
  const loc = d && PP.locationById(d.locationId);
  return (loc && loc.adReward) || PP.CONFIG.ECON.adFundsReward;
};

// The next district that can be unlocked: the first locked one in order.
PP.nextLockedDistrict = function (unlocked) {
  return PP.DISTRICTS.find((d) => !unlocked.includes(d.id)) || null;
};

PP.log = function () {
  if (PP.DEBUG) console.log('[PP]', ...arguments);
};
