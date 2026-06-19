/* ====================================================================
   POTHOLE PATROL — game.js
   Core simulation: grid + road network, pothole spawning, truck
   dispatch/pathfinding/patching, traffic, reputation, combo, economy,
   and the pause/resume system that drives gameplayStart/gameplayStop.

   Positions are in TILE UNITS: (x, y) = (col + 0.5, row + 0.5) is the
   center of tile (col, row). js/render.js converts to pixels.
   ==================================================================== */

PP.Game = (function () {
  const E = PP.CONFIG.ECON;

  const G = {
    state: 'boot',            // boot | menu | playing | gameover
    pauseReasons: new Set(),  // 'user' | 'menu' | 'ad' | 'portrait' | 'hidden'
    district: null,
    grid: null,               // { w, h, road:Uint8Array, roadTiles:[{x,y}] }
    run: null,
    ambient: null,            // menu backdrop: live traffic, no gameplay
    selectedTruck: null,
    drag: null,               // { truck, x, y } while dragging a truck
    wasPlaying: false,
  };

  const rnd = (a, b) => a + Math.random() * (b - a);

  // ------------------------------------------------------------------
  // Grid & pathfinding
  // ------------------------------------------------------------------
  // Maps whose bottom-right vertical road sits under the "Fix All Potholes"
  // button (the widest cores) — potholes are kept off its bottom tile.
  const BUTTON_BLOCKED_DISTRICTS = ['sky-core', 'frost-core', 'coral-abyss', 'luna-base', 'neon-core',
    'ember-core', 'candy-core', 'toy-core', 'mire-chapel', 'helix-core', 'fold-capital'];

  // The vehicles the player is fielding on district `d`: the deploy-flagged
  // ones allowed on this map, capped to ECON.deployCap. Returns empty when the
  // player hasn't deployed anything — the start-game gate handles that case.
  function activeLoadout(d) {
    const sv = PP.Save.data;
    const cap = E.deployCap;
    const out = [];
    for (const v of sv.fleet) {
      if (!v.deploy) continue;
      const def = PP.vehicleById(v.type);
      if (!def || !PP.vehicleAllowedOn(def, d.locationId)) continue;
      out.push(v);
      if (out.length >= cap) break;
    }
    return out;
  }

  // Resolve a fleet entry (type + upgrade levels) into concrete run stats.
  function vehicleStats(entry) {
    const def = PP.vehicleById(entry.type) || PP.VEHICLES[0];
    const up = entry.up || {};
    let speed = def.base.speed, patch = def.base.patch, turn = def.base.turn;
    for (const u of def.upgrades) {
      const lvl = up[u.key] | 0;
      if (!lvl) continue;
      if (u.affects === 'speed') speed += u.step * lvl;
      else if (u.affects === 'patch') patch -= u.step * lvl;
      else if (u.affects === 'turn') turn += u.step * lvl;
    }
    return {
      speed, patchDur: Math.max(def.patchFloor, patch), turn,
      movement: def.movement, flags: def.flags || {}, earnMult: def.earnMult || 1,
    };
  }

  // Depot squares: one per truck — off-road ground tiles on the row just
  // above the SECOND horizontal road (kept clear of the top menu bar),
  // fanning out from the corner (left of the first road, then right of it).
  // Each exits onto the road tile directly below it.
  function depotSlots(d, trucks) {
    const roadRow = d.roadRows[1] !== undefined ? d.roadRows[1] : d.roadRows[0];
    const row = roadRow - 1, exitRow = roadRow;
    const isCol = (c) => c >= 0 && c < d.w && !d.roadCols.includes(c);
    const cols = [];
    for (let c = d.roadCols[0] - 1; cols.length < trucks && c >= 0; c--) if (isCol(c)) cols.push(c);
    for (let c = d.roadCols[0] + 1; cols.length < trucks && c < d.w; c++) if (isCol(c)) cols.push(c);
    return cols.map((c) => ({ x: c, y: row, exitX: c, exitY: exitRow }));
  }

  // Parking spot for the i-th truck: one truck centred in its own square.
  function parkPos(depots, i) {
    const sq = depots[i] || depots[depots.length - 1];
    return { sq, px: sq.x + 0.5, py: sq.y + 0.55 };
  }

  // A fully-parked fleet truck, ready to be dispatched. `entry` is a fleet
  // record { type, up } — its vehicle def drives the movement style + stats.
  function makeTruck(i, depots, entry) {
    const { sq, px, py } = parkPos(depots, i);
    const st = vehicleStats(entry);
    return {
      id: i + 1,
      vehType: entry.type, movement: st.movement,
      home: { tileX: sq.x, tileY: sq.y, px, py, exitX: sq.exitX, exitY: sq.exitY },
      x: px, y: py,
      tileX: sq.exitX, tileY: sq.exitY,   // road tile used as the BFS start while parked
      state: 'parked',                     // parked | driving | patching | returning
      wps: null, pathI: 0,                 // lane-offset waypoints + cursor
      angle: Math.PI / 2,                  // nose toward the road (facing down)
      hx: 0, hy: 1,
      speed: st.speed, patchDur: st.patchDur, turn: st.turn,
      flags: st.flags, earnMult: st.earnMult,
      patchT: 0, target: null,
    };
  }

  function buildGrid(d) {
    const w = d.w, h = d.h;
    const road = new Uint8Array(w * h);
    for (const r of d.roadRows) for (let x = 0; x < w; x++) road[r * w + x] = 1;
    for (const c of d.roadCols) for (let y = 0; y < h; y++) road[y * w + c] = 1;
    const roadTiles = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (road[y * w + x]) roadTiles.push({ x, y });

    const loadout = activeLoadout(d);
    const depots = depotSlots(d, loadout.length);
    const depotSet = new Set(depots.map((t) => t.y * w + t.x));

    // place the district's signature landmark(s) and mark the road tiles
    // they overhang so potholes can't spawn hidden behind a structure
    const landmarks = placeLandmarks(d, w, h, road, depotSet);
    const blocked = new Set();
    for (const lm of landmarks) {
      const meta = (PP.LANDMARK_META && PP.LANDMARK_META[lm.type]) || {};
      const fw = (meta.foot && meta.foot[0]) || 1;   // footprint columns
      const fh = (meta.foot && meta.foot[1]) || 1;   // footprint rows
      const tall = meta.tall || 1;                   // extra rows overhung above
      const topRow = lm.y - fh + 1 - tall;           // highest road row it covers
      for (let bx = lm.x; bx < lm.x + fw && bx < w; bx++) {
        for (let ry = topRow; ry <= lm.y; ry++) {
          if (ry < 0) continue;
          const k = ry * w + bx;
          if (road[k]) blocked.add(k);
        }
      }
    }

    // keep potholes clear of the on-screen UI: the top of every vertical road
    // sits under the top HUD bar, so block its topmost tile on every map…
    for (const c of d.roadCols) blocked.add(c);                 // (c, 0)
    // …and on the widest "core" maps the bottom-right "Fix All Potholes"
    // button overlaps the bottom of the right-most vertical road.
    if (BUTTON_BLOCKED_DISTRICTS.includes(d.id)) {
      const rc = Math.max.apply(null, d.roadCols);
      blocked.add((h - 1) * w + rc);                            // (rightmost col, h-1)
    }

    return { w, h, road, roadTiles, landmarks, blocked, depots, loadout };
  }

  // Choose `count` spread-out ground tiles (beside a road, with room above)
  // for the district's landmark. Deterministic: central seed + farthest-point.
  function placeLandmarks(d, w, h, road, depotSet) {
    if (!d.landmark) return [];
    const meta = (PP.LANDMARK_META && PP.LANDMARK_META[d.landmark]) || { count: 1 };
    const count = meta.count || 1;
    const fw = (meta.foot && meta.foot[0]) || 1;   // footprint columns (right room)
    const fh = (meta.foot && meta.foot[1]) || 1;   // footprint rows (room above)
    const isFeature = (x, y) => {
      const f = d.feature;
      return !!f && ((f.rows && f.rows.indexOf(y) !== -1) || (f.cols && f.cols.indexOf(x) !== -1));
    };
    const isGround = (x, y) =>
      !road[y * w + x] && !d.water.includes(y) && !isFeature(x, y) && !(depotSet && depotSet.has(y * w + x));

    const cand = [];
    // anchor at the footprint's bottom-left: leave fh rows above and fw cols right
    for (let y = Math.max(1, fh - 1); y < h; y++) for (let x = 0; x <= w - fw; x++) {
      if (!isGround(x, y)) continue;
      const adj = (x > 0 && road[y * w + x - 1]) || (x < w - 1 && road[y * w + x + 1]) ||
                  (y > 0 && road[(y - 1) * w + x]) || (y < h - 1 && road[(y + 1) * w + x]);
      if (adj) cand.push({ x, y });
    }
    if (!cand.length) return [];

    const cx = (w / 2) | 0, cy = (h / 2) | 0;
    cand.sort((a, b) => (Math.abs(a.x - cx) + Math.abs(a.y - cy)) - (Math.abs(b.x - cx) + Math.abs(b.y - cy)));
    const chosen = [cand[0]];
    while (chosen.length < count && chosen.length < cand.length) {
      let best = null, bestDist = -1;
      for (const c of cand) {
        if (chosen.some((s) => s.x === c.x && s.y === c.y)) continue;
        let md = Infinity;
        for (const s of chosen) md = Math.min(md, Math.abs(c.x - s.x) + Math.abs(c.y - s.y));
        if (md > bestDist) { bestDist = md; best = c; }
      }
      if (!best) break;
      chosen.push(best);
    }
    return chosen.map((c) => ({ x: c.x, y: c.y, type: d.landmark }));
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // Shortest path between two road tiles (BFS over the road network).
  function bfsPath(grid, sx, sy, tx, ty) {
    const { w, h, road } = grid;
    const start = sy * w + sx, goal = ty * w + tx;
    if (start === goal) return [{ x: sx, y: sy }];
    const prev = new Int32Array(w * h).fill(-2); // -2 unseen, -1 = start marker
    prev[start] = -1;
    const q = [start];
    let qi = 0, found = false;
    while (qi < q.length) {
      const k = q[qi++];
      if (k === goal) { found = true; break; }
      const x = k % w, y = (k - x) / w;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx;
        if (prev[nk] !== -2 || !road[nk]) continue;
        prev[nk] = k;
        q.push(nk);
      }
    }
    if (!found) return null;
    const path = [];
    let k = goal;
    while (k !== -1) {
      const x = k % w;
      path.push({ x, y: (k - x) / w });
      k = prev[k];
    }
    path.reverse();
    return path;
  }

  // Road-distance map from one tile to everywhere (to pick nearest truck).
  function bfsDist(grid, sx, sy) {
    const { w, h, road } = grid;
    const dist = new Int32Array(w * h).fill(-1);
    const start = sy * w + sx;
    dist[start] = 0;
    const q = [start];
    let qi = 0;
    while (qi < q.length) {
      const k = q[qi++];
      const x = k % w, y = (k - x) / w;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx;
        if (dist[nk] !== -1 || !road[nk]) continue;
        dist[nk] = dist[k] + 1;
        q.push(nk);
      }
    }
    return dist;
  }

  // ------------------------------------------------------------------
  // Pause / resume — single source of truth for gameplayStart/Stop
  // ------------------------------------------------------------------
  function effectivePlaying() {
    return G.state === 'playing' && G.pauseReasons.size === 0;
  }

  function syncGameplay() {
    const now = effectivePlaying();
    if (now === G.wasPlaying) return;
    G.wasPlaying = now;
    // [GAMEPLAY] tell CrazyGames when real play starts/stops
    if (now) PP.SDK.gameplayStart();
    else PP.SDK.gameplayStop();
  }

  function pause(reason) { G.pauseReasons.add(reason); syncGameplay(); }
  function resume(reason) { G.pauseReasons.delete(reason); syncGameplay(); }

  // ------------------------------------------------------------------
  // Run lifecycle
  // ------------------------------------------------------------------
  function setDistrictById(id) {
    G.district = PP.DISTRICTS.find((d) => d.id === id) || PP.DISTRICTS[0];
  }

  function startRun() {
    G.ambient = null;          // the menu backdrop hands the city over to the run
    const d = G.district;
    G.grid = buildGrid(d);

    // the run fields exactly the loadout the grid was sized for, one truck
    // per depot square (in the same order)
    const loadout = G.grid.loadout || activeLoadout(d);
    const trucks = [];
    for (let i = 0; i < loadout.length; i++) trucks.push(makeTruck(i, G.grid.depots, loadout[i]));

    G.run = {
      t: 0,
      funds: 0, patched: 0,
      combo: 0, bestCombo: 0,
      rep: 100,
      potholes: [], trucks, cars: [],
      decals: [], parts: [], floaters: [],
      shake: 0,                 // current screen-shake magnitude (px), decays each frame
      spawnT: 1.6, carT: 0.4,
      adCd: 0,
      nextId: 1,
      newBest: false,
      tutorial: !!d.tutorial,   // training-yard run: no automatic spawning (the tutorial drives it)
    };

    G.selectedTruck = null;
    G.drag = null;
    G.pauseReasons.delete('user');
    G.pauseReasons.delete('menu');
    G.state = 'playing';
    PP.Render.onDistrictChanged();
    syncGameplay();    // [GAMEPLAY] -> gameplayStart()
  }

  // ------------------------------------------------------------------
  // Tutorial "training yard" run — same machinery as a normal run, but on
  // the hidden flat-grey TUTORIAL_DISTRICT with auto-spawning switched off
  // (run.tutorial). The tutorial places each pothole and the lone car itself
  // via the helpers below.
  // ------------------------------------------------------------------
  function startTutorialRun() {
    G.district = PP.TUTORIAL_DISTRICT;
    startRun();
  }

  // Spawn one pothole dead-centre along horizontal road `roadRow`, sitting in
  // the LANE a car travelling `dir` uses (so an un-patched hole is squarely in
  // that car's path). Returns the pothole.
  function tutorialSpawnPothole(tileX, roadRow, dir) {
    const run = G.run;
    if (!run) return null;
    const p = {
      id: run.nextId++,
      tx: tileX, ty: roadRow,
      x: tileX + 0.5, y: roadRow + 0.5 + LANE * dir,
      born: run.t, sev: 0,
      state: 'open', truck: null,
      hitFlash: 0,
      seed: Math.random() * 100,
      pts: makeBlob(),
    };
    run.potholes.push(p);
    PP.Audio.play('crack');
    return p;
  }

  // Spawn the tutorial's single car on horizontal road `roadRow`, entering from
  // the right (dir -1) or left (dir +1) at a fixed slow speed. Returns the car.
  function tutorialSpawnCar(roadRow, dir, speed) {
    const run = G.run, d = G.district;
    if (!run) return null;
    const car = {
      axis: 'h', dir, laneIdx: roadRow, speed,
      color: (d.carColors && d.carColors[0]) || '#e85d5d',
      variant: 0, transit: false,
      hurtT: 0, lastHole: -1, gone: false, boost: 1, uturnT: 0,
      y: roadRow + 0.5 + LANE * dir,
      x: dir > 0 ? -0.8 : d.w + 0.8,
    };
    run.cars.push(car);
    return car;
  }

  // Dispatch a specific truck to a specific pothole (used by the tutorial's
  // gated taps). Thin wrapper so the tutorial doesn't reach into internals.
  function tutorialDispatch(p, truck) {
    return requestDispatch(p, truck || (G.run && G.run.trucks[0]));
  }

  // Pay the tutorial's fixed reward and pop a floater where the hole was.
  function tutorialAward(amount, x, y) {
    const run = G.run;
    if (!run) return;
    run.funds += amount;
    fxFloater(x, y - 0.25, '+$' + amount, '#ffd14a', 18);
    PP.Audio.play('reward');
    PP.UI.fundsPop();
  }

  function endRun() {
    if (G.state !== 'playing') return;
    const run = G.run, sv = PP.Save.data;
    G.state = 'gameover';
    run.shake = 0;     // never freeze the game-over scene mid-shake
    syncGameplay();    // [GAMEPLAY] -> gameplayStop()

    let newBest = false;
    if (run.patched > sv.best.patched) { sv.best.patched = run.patched; newBest = true; }
    if (run.bestCombo > sv.best.combo) { sv.best.combo = run.bestCombo; newBest = true; }
    if (run.funds > sv.best.funds)     { sv.best.funds = run.funds;     newBest = true; }
    run.newBest = newBest;

    sv.totalFunds += run.funds;
    sv.adClaimed = 0;  // finishing a run restores the home-screen ad reward
    PP.Save.save();    // [DATA SAVE] bank the run + best stats

    if (newBest) PP.SDK.happytime();   // [HAPPYTIME] new personal best
    PP.Audio.play('gameover');
    PP.UI.showSummary(run);
  }

  function toMenu() {
    G.run = null;
    G.state = 'menu';
    syncGameplay();
  }

  // ------------------------------------------------------------------
  // Potholes
  // ------------------------------------------------------------------
  function makeBlob() {
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push(rnd(0.72, 1.25));
    return pts;
  }

  function activePotholeCount() {
    let n = 0;
    for (const p of G.run.potholes) if (p.state !== 'patched') n++;
    return n;
  }

  // Is tile (tx,ty) on a road an Advanced Truck has currently shut down?
  // (no new potholes appear on a closed road while it's being patched)
  function roadClosedAt(tx, ty) {
    if (!G.run) return false;
    for (const tr of G.run.trucks) {
      const cr = tr.closedRoad;
      if (cr && (cr.axis === 'h' ? ty === cr.idx : tx === cr.idx)) return true;
    }
    return false;
  }

  function spawnPothole() {
    const grid = G.grid, d = G.district, run = G.run;
    const occupied = new Set();
    for (const p of run.potholes) occupied.add(p.ty * grid.w + p.tx);

    let tile = null;
    for (let tries = 0; tries < 16; tries++) {
      const c = grid.roadTiles[(Math.random() * grid.roadTiles.length) | 0];
      const k = c.y * grid.w + c.x;
      // skip occupied tiles, tiles hidden behind a structure, and any road an
      // Advanced Truck has shut down
      if (!occupied.has(k) && !(grid.blocked && grid.blocked.has(k)) && !roadClosedAt(c.x, c.y)) { tile = c; break; }
    }
    if (!tile) return;

    // jitter inside the tile, constrained to stay on the lane
    const onH = d.roadRows.includes(tile.y);
    const onV = d.roadCols.includes(tile.x);
    let jx, jy;
    if (onH && onV)      { jx = rnd(-0.16, 0.16); jy = rnd(-0.16, 0.16); }
    else if (onH)        { jx = rnd(-0.30, 0.30); jy = rnd(-0.17, 0.17); }
    else                 { jx = rnd(-0.17, 0.17); jy = rnd(-0.30, 0.30); }

    run.potholes.push({
      id: run.nextId++,
      tx: tile.x, ty: tile.y,
      x: tile.x + 0.5 + jx, y: tile.y + 0.5 + jy,
      born: run.t,
      sev: 0,                 // severity 0..1, grows with age
      state: 'open',          // open | assigned | patching | patched
      truck: null,
      hitFlash: 0,
      seed: Math.random() * 100,
      pts: makeBlob(),
    });
    PP.Audio.play('crack');
  }

  // ------------------------------------------------------------------
  // Dispatch & patching
  // ------------------------------------------------------------------
  // A truck can take a new job when parked at the depot or on its way back.
  function isAvailable(tr) { return tr.state === 'parked' || tr.state === 'returning'; }

  // The road tile a truck pathfinds FROM: its depot exit when parked, else
  // the last road tile it passed.
  function startTile(tr) {
    return tr.state === 'parked'
      ? { x: tr.home.exitX, y: tr.home.exitY }
      : { x: tr.tileX, y: tr.tileY };
  }

  function requestDispatch(p, preferredTruck) {
    const run = G.run;
    if (!run || !p) return false;
    if (p.state !== 'open') {
      if (p.state !== 'patched') PP.UI.toast('CREW ALREADY ON IT!');
      return false;
    }

    let truck = (preferredTruck && isAvailable(preferredTruck)) ? preferredTruck : null;
    if (!truck) {
      // nearest available truck: flyers measure straight-line, road
      // vehicles measure actual road distance
      const dist = bfsDist(G.grid, p.tx, p.ty);
      let best = Infinity;
      for (const tr of run.trucks) {
        if (!isAvailable(tr)) continue;
        let dd;
        if (tr.movement === 'road') {
          const s = startTile(tr);
          dd = dist[s.y * G.grid.w + s.x];
        } else {
          // fly / dig / teleport all reach straight to the tile, ignoring roads
          dd = Math.hypot(tr.x - (p.tx + 0.5), tr.y - (p.ty + 0.5));
        }
        if (dd >= 0 && dd < best) { best = dd; truck = tr; }
      }
    }
    if (!truck) {
      PP.Audio.play('error');
      PP.UI.toast('ALL TRUCKS BUSY!');
      return false;
    }

    if (!routeTo(truck, p.tx, p.ty)) { PP.Audio.play('error'); return false; }
    truck.state = 'driving';            // siren on, en route
    truck.target = p;
    p.state = 'assigned';
    p.truck = truck;
    PP.Audio.play('dispatch');
    return true;
  }

  // Build the waypoint route a truck follows to reach tile (tx,ty). Flyers go
  // straight to the tile centre (no roads); road vehicles follow the BFS
  // path with the lane offset baked in. Returns false if unreachable.
  function routeTo(tr, tx, ty) {
    if (tr.movement === 'teleport') {       // warp out, then in above the pothole
      startTeleport(tr, tx + 0.5, ty + 0.5);
      tr.wps = null; tr.pathI = 0;
      return true;
    }
    if (tr.movement === 'fly' || tr.movement === 'dig') {   // straight line, ignore roads
      tr.wps = [{ tx, ty, x: tx + 0.5, y: ty + 0.5 }];
      tr.pathI = 0;
      return true;
    }
    const s = startTile(tr);
    const path = bfsPath(G.grid, s.x, s.y, tx, ty);
    if (!path) return false;
    tr.wps = makeWaypoints(path, null);
    tr.pathI = 0;
    // if the truck is already rolling, drop a leading waypoint only when it's
    // BEHIND us AND very close (the tile we just left) — otherwise a redirect
    // loops back to it (a needless ~360°). The distance cap is essential: never
    // drop the whole route, or the truck would beeline in a straight line
    // off-road to a far node.
    while (tr.wps.length > 1) {
      const w0 = tr.wps[0];
      const bx = w0.x - tr.x, by = w0.y - tr.y;
      if (bx * tr.hx + by * tr.hy < -0.02 && bx * bx + by * by < 0.9) tr.wps.shift();
      else break;
    }
    return true;
  }

  // Send an idle/recalled truck back to its depot bay (siren off).
  function sendHome(tr) {
    tr.target = null;
    // if recalled mid-job, free any still-coned potholes on the road it closed
    if (tr.roadQueue) for (const o of tr.roadQueue) {
      if (o.state === 'patching' && o.truck === tr) { o.state = 'open'; o.truck = null; }
    }
    tr.closedRoad = null; tr.cones = null; tr.roadQueue = null;   // lift any road closure
    if (tr.movement === 'teleport') {                    // warp back to the bay
      startTeleport(tr, tr.home.px, tr.home.py);
      tr.state = 'returning'; tr.wps = null; tr.pathI = 0; return;
    }
    if (tr.movement === 'fly' || tr.movement === 'dig') {  // glide/dig straight back to the bay
      tr.wps = [{ tx: tr.home.exitX, ty: tr.home.exitY, x: tr.home.px, y: tr.home.py }];
      tr.state = 'returning'; tr.pathI = 0; return;
    }
    const path = bfsPath(G.grid, tr.tileX, tr.tileY, tr.home.exitX, tr.home.exitY);
    if (!path) { tr.state = 'parked'; tr.wps = null; return; }
    path.push({ x: tr.home.tileX, y: tr.home.tileY });   // final node: pull into the bay
    tr.state = 'returning';
    tr.wps = makeWaypoints(path, { x: tr.home.px, y: tr.home.py });   // final aim = exact bay
    tr.pathI = 0;
  }

  function beginPatch(tr) {
    const p = tr.target;
    if (!p || p.state === 'patched') {  // hole vanished (instant repair) mid-drive
      sendHome(tr);
      return;
    }
    tr.state = 'patching';
    tr.patchT = tr.patchDur;
    p.state = 'patching';               // cones are out: cars no longer hit it
    // the truck stops where it arrived — the lane centre of the pothole's tile
    // (positioned by the road, not snapped onto the jittered hole)
    if (tr.flags && tr.flags.roadClose && !tr.closedRoad) closeRoad(tr, p);   // close once, on first arrival
    PP.Audio.play('cone');
  }

  // Advanced Truck: shut down the ENTIRE road the target sits on. Every open
  // pothole on that road line is coned off (so cars stop hitting it) and queued
  // — the truck then drives to and fixes them ONE BY ONE. Traffic cones are
  // dropped in the middle of each CROSSING road, one tile either side of every
  // intersection, fencing the closed road off.
  function closeRoad(tr, p) {
    const d = G.district, grid = G.grid, run = G.run;
    const onH = d.roadRows.includes(p.ty);
    const idx = onH ? p.ty : p.tx;
    tr.closedRoad = { axis: onH ? 'h' : 'v', idx };

    // queue every open pothole on this road (plus the target); cone them off so
    // cars can't hit them while they wait their turn
    tr.roadQueue = [];
    for (const o of run.potholes) {
      if (o !== p && o.state !== 'open') continue;
      if ((onH ? o.ty : o.tx) !== idx) continue;
      if (o !== p) { o.state = 'patching'; o.truck = tr; }
      tr.roadQueue.push(o);
    }

    // fence cones on the crossing roads, just past each intersection (close to
    // the closed road) so they read as gates blocking the way in
    tr.cones = [];
    const roadAt = (x, y) => x >= 0 && y >= 0 && x < grid.w && y < grid.h && grid.road[y * grid.w + x];
    if (onH) {
      for (const c of d.roadCols) {
        if (roadAt(c, idx - 1)) tr.cones.push({ x: c + 0.5, y: idx - 0.3 });
        if (roadAt(c, idx + 1)) tr.cones.push({ x: c + 0.5, y: idx + 1.3 });
      }
    } else {
      for (const r of d.roadRows) {
        if (roadAt(idx - 1, r)) tr.cones.push({ x: idx - 0.3, y: r + 0.5 });
        if (roadAt(idx + 1, r)) tr.cones.push({ x: idx + 1.3, y: r + 0.5 });
      }
    }
  }

  // The next still-unpatched pothole on the closed road, nearest by road
  // distance — the Advanced Truck visits them in turn.
  function nextRoadHole(tr) {
    if (!tr.roadQueue) return null;
    const dist = bfsDist(G.grid, tr.tileX, tr.tileY);
    let best = null, bd = Infinity;
    for (const o of tr.roadQueue) {
      if (o.state === 'patched') continue;
      const dd = dist[o.ty * G.grid.w + o.tx];
      if (dd >= 0 && dd < bd) { bd = dd; best = o; }
    }
    return best;
  }

  function completePatch(p, truck, instant) {
    if (p.state === 'patched') return;
    const run = G.run, d = G.district;
    p.state = 'patched';
    p.truck = null;

    run.decals.push({ x: p.x, y: p.y, r: 0.15 + 0.14 * p.sev, t: run.t });
    if (run.decals.length > 50) run.decals.shift();

    run.patched++;

    // tutorial patches don't pay or build combo (and don't refill reputation,
    // so the "you lost rep" lesson stays clear) — the script pays a fixed $100
    if (run.tutorial) {
      fxBurst(p.x, p.y, '#ffb73a', 10);
      if (!instant) { PP.Audio.play('patch', 1); PP.UI.fundsPop(); fxShake(2.5); hapticPatch(); }
      return;
    }

    if (!instant) {
      run.combo++;
      run.bestCombo = Math.max(run.bestCombo, run.combo);
      if (run.combo === E.comboCap) PP.SDK.happytime();   // [HAPPYTIME] combo maxed out
    }

    // funds: base + speed bonus (faster patch = bigger tip), x combo
    const age = run.t - p.born;
    const base = E.patchBase * d.payout;
    const speedBonus = instant ? 0
      : Math.max(0, E.speedBonus * d.payout * (1 - Math.min(age / E.speedBonusWindow, 1)));
    const mult = 1 + Math.min(run.combo, E.comboCap) * E.comboStep;
    const earnMult = (truck && truck.earnMult) || 1;   // exclusive vehicles earn +25%
    const gain = Math.round((base + speedBonus) * mult * earnMult);
    run.funds += gain;

    run.rep = Math.min(100, run.rep + E.repPatch);

    // Reward feedback escalates with the combo so a long streak feels louder:
    // bigger "+$" text, more particles, stronger shake, plus a celebration pop
    // at the ×4 / ×8 / ×12 milestones.
    const comboN = run.combo;
    const cc = Math.min(comboN, E.comboCap);
    const floatSize = instant ? 13 : 16 + cc * 0.7;          // grows up to ~24px
    fxFloater(p.x, p.y - 0.25, '+$' + gain, '#ffd14a', floatSize);
    fxBurst(p.x, p.y, '#ffb73a', instant ? 6 : 8 + cc);      // 8 → 20 particles
    if (!instant) {
      PP.Audio.play('patch', run.combo);
      PP.UI.fundsPop();
      fxShake(2.2 + cc * 0.25);                              // small, climbs with combo
      hapticPatch();
      if (comboN === 4 || comboN === 8 || comboN === E.comboCap) {
        fxFloater(p.x, p.y - 0.95, 'COMBO ×' + comboN + '!', '#ffe25a', 22);
        fxBurst(p.x, p.y, '#fff1a8', 16);                   // bright confetti pop
        fxShake(6 + comboN * 0.3);
        PP.Audio.play('combo', comboN);                     // celebratory sting
        hapticMilestone();
      }
    }
  }

  // ------------------------------------------------------------------
  // Traffic
  // ------------------------------------------------------------------
  const CAR_COLORS = ['#e85d5d', '#5d9fe8', '#e8c45d', '#7fd08a', '#c98ad6', '#e8e3da', '#8a93a6'];

  // Roads currently shut down by an Advanced Truck (for car spawning + U-turns).
  function closedRoads() {
    if (!G.run) return [];
    const list = [];
    for (const tr of G.run.trucks) if (tr.closedRoad) list.push(tr.closedRoad);
    return list;
  }

  function spawnCar(cars) {
    const d = G.district;
    const palette = d.carColors || CAR_COLORS;   // cars change per location
    const lanes = [];
    for (const r of d.roadRows) lanes.push({ axis: 'h', idx: r });
    for (const c of d.roadCols) lanes.push({ axis: 'v', idx: c });
    const closed = closedRoads();
    let lane = lanes[(Math.random() * lanes.length) | 0];
    for (let tries = 0; tries < 6 && closed.some((cr) => cr.axis === lane.axis && cr.idx === lane.idx); tries++) {
      lane = lanes[(Math.random() * lanes.length) | 0];   // never spawn onto a closed road
    }
    const dir = Math.random() < 0.5 ? 1 : -1;
    const speed = rnd(d.carSpeed[0], d.carSpeed[1]);
    const side = LANE * dir; // opposite directions keep to opposite sides (same offset as trucks)

    const transit = Math.random() < E.transitChance;   // occasional bus/tram/whale/pod
    const car = {
      axis: lane.axis, dir, laneIdx: lane.idx, speed: transit ? speed * 0.82 : speed,
      color: palette[(Math.random() * palette.length) | 0],
      variant: Math.random() < 0.5 ? 0 : 1,   // e.g. rover vs. mini-saucer
      transit,
      hurtT: 0, lastHole: -1, gone: false,
      boost: 1, uturnT: 0,
    };
    if (lane.axis === 'h') {
      car.y = lane.idx + 0.5 + side;
      car.x = dir > 0 ? -0.8 : d.w + 0.8;
    } else {
      car.x = lane.idx + 0.5 - side;
      car.y = dir > 0 ? -0.8 : d.h + 0.8;
    }
    cars.push(car);
  }

  function carHit(c, p) {
    const run = G.run;
    run.rep = Math.max(0, run.rep - E.repHit);
    run.combo = 0;                       // combo broken!
    p.hitFlash = 0.5;
    c.hurtT = 0.9;
    fxFloater(c.x, c.y - 0.3, '-' + E.repHit + ' REP', '#ff5d6a', 14);
    fxBurst(c.x, c.y, '#9aa3ad', 9);
    PP.Audio.play('hit');
    PP.UI.repShake();
    fxShake(6.5);            // a real jolt — the map lurches when a car bottoms out
    hapticHit();
  }

  // Smooth U-turn arc: swing forward (Rf) while crossing to the opposite lane
  // (±LANE), the body rotating a full 180° with the motion.
  const UTURN_DUR = 0.6, UTURN_FWD = 0.5;

  // Car-following gaps (world units): ease off from CAR_FOLLOW, full stop by CAR_STOP.
  const CAR_STOP = 0.5, CAR_FOLLOW = 1.3;

  function startUTurn(c) {
    c.turning = true;
    c.turnT = 0;
    c.turnDir = c.dir;                       // original travel direction
    c.turnPivot = (c.axis === 'h') ? c.x : c.y;     // along-lane pivot
    c.turnLaneC = c.laneIdx + 0.5;                  // cross-lane centre line
  }

  function stepUTurn(c, dt) {
    c.turnT += dt;
    const f = Math.min(1, c.turnT / UTURN_DUR);
    const th = Math.PI * f, dir = c.turnDir;
    const s = Math.sin(th), co = Math.cos(th);
    if (c.axis === 'h') {
      c.x = c.turnPivot + UTURN_FWD * dir * s;
      c.y = c.turnLaneC + LANE * dir * co;
      c.angle = Math.atan2(-LANE * dir * s, UTURN_FWD * dir * co);
    } else {
      c.y = c.turnPivot + UTURN_FWD * dir * s;
      c.x = c.turnLaneC - LANE * dir * co;
      c.angle = Math.atan2(UTURN_FWD * dir * co, LANE * dir * s);
    }
    if (f >= 1) {                            // settle on the opposite lane, reversed
      c.turning = false;
      c.dir = -c.turnDir;
      c.uturnT = 1.2;                        // brief re-trigger guard
      if (c.axis === 'h') c.y = c.laneIdx + 0.5 + LANE * c.dir;
      else c.x = c.laneIdx + 0.5 - LANE * c.dir;
    }
  }

  function updateCar(c, dt, potholes, trucks, cars) {
    if (c.hurtT > 0) c.hurtT -= dt;
    if (c.uturnT > 0) c.uturnT -= dt;

    if (c.turning) { stepUTurn(c, dt); return; }   // mid U-turn: follow the arc, nothing else

    let speedUp = 1, brake = 1;
    if (trucks && trucks.length) {
      // U-turn away from a fleet truck working on a pothole ahead in our lane
      if (c.uturnT <= 0) {
        for (const tr of trucks) {
          if (tr.state !== 'patching') continue;
          // U-turn away from a truck working anywhere on our road ahead. The
          // lateral window spans BOTH lanes (≈2·LANE) so a car in the opposite
          // lane to the parked truck still turns instead of crawling through it,
          // and the look-ahead reaches further so it reacts in good time.
          let block = false;
          if (c.axis === 'h') {
            if (Math.abs(tr.y - c.y) <= 0.7) { const a = (tr.x - c.x) * c.dir; block = a > 0 && a < 2.1; }
          } else {
            if (Math.abs(tr.x - c.x) <= 0.7) { const a = (tr.y - c.y) * c.dir; block = a > 0 && a < 2.1; }
          }
          if (block) { startUTurn(c); stepUTurn(c, dt); return; }
        }
        // U-turn when approaching an intersection with a shut-down road (cars on
        // a crossing road turn back rather than driving onto the closed road)
        for (const tr of trucks) {
          const cr = tr.closedRoad;
          if (!cr) continue;
          let near = false;
          if (cr.axis === 'h' && c.axis === 'v') { const a = (cr.idx + 0.5 - c.y) * c.dir; near = a > 0.3 && a < 1.6; }
          else if (cr.axis === 'v' && c.axis === 'h') { const a = (cr.idx + 0.5 - c.x) * c.dir; near = a > 0.3 && a < 1.6; }
          if (near) { startUTurn(c); stepUTurn(c, dt); return; }
        }
      }
      // avoid overlapping fleet trucks: speed up to clear one coming up behind
      // (a Submarine shoves even harder), or ease off for one right ahead in our
      // lane so we tuck in behind it instead of driving through it
      for (const tr of trucks) {
        if (tr.state === 'parked') continue;
        // the drill is underground and the teleporter is mid-warp — cars on the
        // road don't react to either
        if (tr.movement === 'dig' || tr.movement === 'teleport') continue;
        const forces = tr.flags && tr.flags.forcesTraffic;
        const lat = c.axis === 'h' ? Math.abs(tr.y - c.y) : Math.abs(tr.x - c.x);
        const ahead = c.axis === 'h' ? (tr.x - c.x) * c.dir : (tr.y - c.y) * c.dir;
        const sameDir = c.axis === 'h' ? Math.sign(tr.hx) === c.dir : Math.sign(tr.hy) === c.dir;
        if (tr.state === 'driving' && sameDir && lat <= 0.5 && ahead < 0 && ahead > -3) {
          speedUp = Math.max(speedUp, forces ? 2.4 : 1.8);
        }
        // ease off (right down to a full stop) for a truck right in front in our
        // lane — but a Submarine shoves traffic aside rather than being braked for
        if (!forces && lat <= 0.35 && ahead > 0 && ahead < 0.95) {
          brake = Math.min(brake, Math.max(0, (ahead - 0.12) / 0.83));
        }
      }
    }
    // queue behind the nearest car ahead in our own lane (same axis/lane/dir) so
    // traffic tucks in nose-to-tail instead of driving through itself
    if (cars && cars.length > 1) {
      for (const o of cars) {
        if (o === c || o.gone || o.turning) continue;
        if (o.axis !== c.axis || o.laneIdx !== c.laneIdx || o.dir !== c.dir) continue;
        const ahead = c.axis === 'h' ? (o.x - c.x) * c.dir : (o.y - c.y) * c.dir;
        if (ahead > 0 && ahead < CAR_FOLLOW) brake = Math.min(brake, Math.max(0, (ahead - CAR_STOP) / (CAR_FOLLOW - CAR_STOP)));
      }
    }
    const want = brake < 1 ? brake : speedUp;        // avoiding an overlap takes priority
    c.boost += (want - c.boost) * Math.min(1, dt * 11);   // snappier: brake hard, surge back fast

    const sp = c.speed * c.boost * (c.hurtT > 0 ? 0.6 : 1);
    if (c.axis === 'h') c.x += sp * dt * c.dir;
    else c.y += sp * dt * c.dir;
    c.angle = (c.axis === 'h') ? (c.dir > 0 ? 0 : Math.PI) : (c.dir > 0 ? Math.PI / 2 : -Math.PI / 2);

    // pothole collisions (patching holes are coned off = safe)
    for (const p of potholes) {
      if (p.state === 'patched' || p.state === 'patching') continue;
      const dx = p.x - c.x, dy = p.y - c.y;
      const r = 0.18 + 0.16 * p.sev;
      if (dx * dx + dy * dy < r * r && c.lastHole !== p.id) {
        c.lastHole = p.id;
        carHit(c, p);
      }
    }

    const d = G.district;
    if (c.x < -1.2 || c.x > d.w + 1.2 || c.y < -1.2 || c.y > d.h + 1.2) c.gone = true;
  }

  // ------------------------------------------------------------------
  // Trucks
  // ------------------------------------------------------------------
  // shortest signed angle to rotate from a to b, in [-PI, PI]
  function angDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Trucks (like cars) keep to the side of the road for their travel
  // direction. Rather than a centre-line path plus a lagging offset (which
  // swung wide through corners), the lane offset is baked into each waypoint
  // so the truck follows the real lane line — including the turns.
  const LANE = 0.26;     // how far off-centre each travel-side lane sits (also sets
                         // how tight a right turn is vs how far a left turn runs on)
  const ARRIVE = 0.18;   // count a waypoint reached within this radius (no position snap)

  // Turn a tile path into lane-offset waypoints. Each waypoint sits on the
  // travel-side lane of its tile (offset by the OUTGOING direction), so a
  // straight run hugs one lane and a corner is a short hop to the next lane.
  // `finalAim`, if given, overrides the last waypoint (used to pull into a bay).
  function makeWaypoints(path, finalAim) {
    const wps = [];
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      // incoming + outgoing tile directions (each is a unit step on the grid)
      let ix = 0, iy = 0, ox = 0, oy = 0;
      if (i > 0) { ix = n.x - path[i - 1].x; iy = n.y - path[i - 1].y; }
      if (i < path.length - 1) { ox = path[i + 1].x - n.x; oy = path[i + 1].y - n.y; }
      if (!ix && !iy) { ix = ox; iy = oy; }   // first node: use the outgoing dir
      if (!ox && !oy) { ox = ix; oy = iy; }   // last node:  use the incoming dir
      // right-hand lane offset of each segment ( (-dy,dx)*LANE )
      const inX = -iy * LANE, inY = ix * LANE;
      const outX = -oy * LANE, outY = ox * LANE;
      // combine per-axis: at a corner this lands on the INSIDE intersection of
      // the incoming and outgoing lanes, so the turn is one clean sweep with no
      // wrong-way wiggle; on a straight it's just the normal lane offset
      const offX = Math.abs(inX) > Math.abs(outX) ? inX : outX;
      const offY = Math.abs(inY) > Math.abs(outY) ? inY : outY;
      wps.push({ tx: n.x, ty: n.y, x: n.x + 0.5 + offX, y: n.y + 0.5 + offY });
    }
    if (finalAim && wps.length) { const w = wps[wps.length - 1]; w.x = finalAim.x; w.y = finalAim.y; }
    return wps;
  }

  // Steer toward the current waypoint like a real car: rotate toward it at the
  // vehicle's turn rate (radians/sec) and DROP SPEED while badly misaligned, so
  // it visibly slows for a corner, swings round, then accelerates away. The
  // turn upgrade raises the rate, sharpening the corner. Smooth and
  // frame-independent. `yieldCars` (en route only) also eases off for a car
  // right in front. Returns true once the route is finished.
  function steerAlong(tr, dt, yieldCars) {
    const wps = tr.wps;
    if (!wps || tr.pathI >= wps.length) return true;

    // advance past any waypoint we've effectively reached. We do NOT snap the
    // truck onto the node — snapping made it visibly jump forward when it
    // stopped at a pothole; it just keeps driving/turning from where it is. The
    // radius grows with speed so a fast vehicle can't step clean over a node in
    // one frame and miss it (which made it circle).
    const arrive = Math.max(ARRIVE, tr.speed * dt * 1.3);
    while (tr.pathI < wps.length) {
      const w = wps[tr.pathI];
      if (Math.hypot(w.x - tr.x, w.y - tr.y) < arrive) { tr.tileX = w.tx; tr.tileY = w.ty; tr.pathI++; }
      else break;
    }
    if (tr.pathI >= wps.length) return true;

    const wp = wps[tr.pathI];
    const dx = wp.x - tr.x, dy = wp.y - tr.y;
    const dist = Math.hypot(dx, dy) || 1e-6;
    const desired = Math.atan2(dy, dx);

    // rotate the body toward the target bearing. Brisk so the tight arc it
    // drives keeps the truck on its lane — and since it then drives ALONG this
    // facing, the body always matches the motion. Much sharper on a near-reverse
    // so a U-turn (a job dispatched behind the truck) snaps round tightly rather
    // than swinging out in a lazy arc. The "slow turn" feel comes from the speed
    // slow-down below.
    const d = angDiff(tr.angle, desired);
    const baseRate = Math.max(5, (tr.turn || 1.6) * 3.3);   // body rotation speed (rad/s)
    const turnRate = baseRate * (Math.abs(d) > 1.7 ? 1.6 : 1);
    const maxStep = turnRate * dt;
    tr.angle += (Math.abs(d) <= maxStep) ? d : Math.sign(d) * maxStep;
    tr.hx = Math.cos(tr.angle); tr.hy = Math.sin(tr.angle);

    // ANTICIPATE the next corner and brake for it EARLY. Look ahead along the
    // route (the corner may be a node or two off) and gauge how much road is
    // still to go; start slowing well before it — and sooner the faster we're
    // going. The corner speed scales with the turn rate, so an upgraded
    // (sharper-turning) vehicle barely slows.
    const err = Math.abs(angDiff(tr.angle, desired));
    let moveFactor = 1;
    const brakeDist = 2.2 + 0.45 * (tr.speed || 2);        // how far out to begin braking
    let turnAng = 0, distAhead = dist, inDir = desired;
    for (let j = tr.pathI; j < wps.length - 1 && distAhead < brakeDist; j++) {
      const a = wps[j], b = wps[j + 1];
      const outDir = Math.atan2(b.y - a.y, b.x - a.x);
      const ta = Math.abs(angDiff(inDir, outDir));
      if (ta > 0.3) { turnAng = ta; break; }               // next corner found, distAhead away
      inDir = outDir;
      distAhead += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (turnAng > 0.3) {
      // corner speed scales with turn rate (upgrade), but is also capped so the
      // turning arc (speed / rotation rate) stays within the lane — a fast,
      // low-turn vehicle therefore slows more so it doesn't swing wide / circle
      const turnCeil = Math.max(0.3, Math.min(1, 0.2 + 0.18 * (tr.turn || 1.6)));
      const cornerSpeed = Math.min(turnCeil, 0.38 * baseRate / (tr.speed || 2));
      // reach corner speed a little BEFORE the corner (not right at it)
      const ramp = Math.max(0, Math.min(1, (distAhead - 0.6) / (brakeDist - 0.6)));
      moveFactor = cornerSpeed + (1 - cornerSpeed) * ramp;
    }
    // ease down approaching the final destination so a fast vehicle pulls up at
    // the pothole instead of overshooting and circling it
    if (tr.pathI === wps.length - 1) moveFactor = Math.min(moveFactor, 0.3 + 0.6 * Math.min(1, dist));
    // a sharp near-reverse (the next node is well behind us — e.g. after
    // redirecting the truck the opposite way) can't be arced onto, so ease down
    // to a near-stop and pivot on the spot. Graduated above ~97° so it doesn't
    // arc wide off the lane; normal 90° corners stay free to roll through.
    if (err > 1.7) {
      const rev = Math.min(1, (err - 1.7) / 0.8);   // 0 at ~97°, 1 by ~143°
      moveFactor = Math.min(moveFactor, 0.4 * (1 - rev) + 0.04 * rev);
    }

    let slow = 1;
    if (yieldCars) {
      for (const c of yieldCars) {
        const rx = c.x - tr.x, ry = c.y - tr.y;
        const along = rx * tr.hx + ry * tr.hy;
        const lat = Math.abs(rx * -tr.hy + ry * tr.hx);
        if (along > 0.05 && along < 1.0 && lat < 0.40) slow = Math.min(slow, 0.45 + 0.55 * along);
      }
    }

    // drive ALONG the facing so the body always matches the motion; the brisk
    // turn rate keeps the arc tight enough to stay on the lane
    const step = tr.speed * dt * slow * moveFactor;
    tr.x += tr.hx * step; tr.y += tr.hy * step;
    return false;
  }

  // ---- Teleporter: warp out from where it stands, then warp in at the
  // target after a short beam animation. teleT counts the whole animation
  // down; at the half-way point we snap from teleFrom to teleTo (vanished
  // out, about to reappear). The render layer reads teleT/teleMax to draw
  // the beam and scale the pod in/out.
  const TELE_DUR = 1.0;          // seconds for the full out + in warp

  function startTeleport(tr, wx, wy) {
    tr.teleFrom = { x: tr.x, y: tr.y };
    tr.teleTo = { x: wx, y: wy };
    tr.teleT = TELE_DUR;
    tr.teleMax = TELE_DUR;
    tr.teleSnapped = false;
  }

  function stepTeleport(tr, dt) {
    tr.teleT -= dt;
    const half = tr.teleMax / 2;
    if (!tr.teleSnapped && tr.teleT <= half) {   // fully beamed out: jump to the destination
      tr.teleSnapped = true;
      tr.x = tr.teleTo.x; tr.y = tr.teleTo.y;
    }
    if (tr.teleT <= 0) {
      tr.teleT = 0;
      tr.x = tr.teleTo.x; tr.y = tr.teleTo.y;
      if (tr.state === 'returning') {            // home: park, siren stays off
        tr.state = 'parked';
        tr.x = tr.home.px; tr.y = tr.home.py;
        tr.tileX = tr.home.exitX; tr.tileY = tr.home.exitY;
        tr.wps = null; tr.hx = 0; tr.hy = 1; tr.angle = Math.PI / 2;
      } else {                                   // arrived above the pothole
        if (tr.target) { tr.tileX = tr.target.tx; tr.tileY = tr.target.ty; }
        beginPatch(tr);
      }
    }
  }

  // ---- Drill: a churning trail of dirt clods thrown up above ground as it
  // tunnels. Throttled so it doesn't flood the particle buffer.
  const DIRT_TONES = ['#9c7440', '#b08a4e', '#7c5d33'];
  function emitDigTrail(tr, dt) {
    const run = G.run;
    if (!run) return;
    tr.digEmit = (tr.digEmit || 0) - dt;
    if (tr.digEmit > 0) return;
    tr.digEmit = 0.04;
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.4 + Math.random() * 0.9;
      run.parts.push({
        x: tr.x - tr.hx * 0.18 + (Math.random() - 0.5) * 0.24,
        y: tr.y - tr.hy * 0.18 + (Math.random() - 0.5) * 0.24,
        vx: Math.cos(a) * s * 0.5, vy: Math.sin(a) * s * 0.5 - 0.6,
        t: 0, life: 0.45 + Math.random() * 0.4,
        color: DIRT_TONES[(Math.random() * DIRT_TONES.length) | 0],
        r: 2 + Math.random() * 3,
      });
    }
    if (run.parts.length > 170) run.parts.splice(0, run.parts.length - 170);
  }

  function updateTruck(tr, dt, cars) {
    if (tr.movement === 'teleport' && (tr.state === 'driving' || tr.state === 'returning')) {
      stepTeleport(tr, dt);     // warping: no steering, no patch-on-arrive here
      return;
    }
    if (tr.state === 'driving') {
      // road vehicles ease for cars in front (unless they shove traffic, like
      // the Submarine); flyers and the drill don't yield
      const yc = (tr.movement === 'road' && !(tr.flags && tr.flags.forcesTraffic)) ? cars : null;
      if (tr.movement === 'dig') emitDigTrail(tr, dt);
      if (steerAlong(tr, dt, yc)) beginPatch(tr);
    } else if (tr.state === 'returning') {
      if (tr.movement === 'dig') emitDigTrail(tr, dt);
      const done = steerAlong(tr, dt, null);
      // also park once we're basically at the bay — guards against a truck that
      // can't quite arc onto the off-road bay and would otherwise circle forever
      const atBay = Math.hypot(tr.x - tr.home.px, tr.y - tr.home.py) < 0.45;
      if (done || atBay) {                             // home: park, siren stays off
        tr.state = 'parked';
        tr.x = tr.home.px; tr.y = tr.home.py;
        tr.tileX = tr.home.exitX; tr.tileY = tr.home.exitY;
        tr.wps = null;
        tr.hx = 0; tr.hy = 1; tr.angle = Math.PI / 2;
      }
    } else if (tr.state === 'patching') {
      tr.patchT -= dt;
      if (tr.patchT <= 0) {
        const p = tr.target;
        if (p) completePatch(p, tr, false);
        // Advanced Truck: keep the road closed and move on to the next pothole
        // on it, fixing them one by one; reopen the road once it's all clear.
        if (tr.flags && tr.flags.roadClose && tr.roadQueue) {
          const next = nextRoadHole(tr);
          if (next && routeTo(tr, next.tx, next.ty)) {
            tr.target = next; tr.state = 'driving';
            return;
          }
          for (const o of tr.roadQueue) if (o.state !== 'patched') completePatch(o, tr, true); // stragglers
          tr.closedRoad = null; tr.cones = null; tr.roadQueue = null;
        }
        sendHome(tr);
      }
    }
  }

  // ------------------------------------------------------------------
  // Effects (floating text + particle bursts), in tile units
  // ------------------------------------------------------------------
  function fxFloater(x, y, text, color, size) {
    const run = G.run;
    run.floaters.push({ x, y, text, color, size: size || 15, t: 0, life: 1.15 });
    if (run.floaters.length > 30) run.floaters.shift();
  }

  // Screen shake: bump the run's shake magnitude (keeps the strongest of the
  // current value and the requested one so rapid events don't cancel out).
  // Read + applied as a camera offset by PP.Render.draw(); decayed in updateFx.
  function fxShake(mag) {
    const run = G.run;
    if (run) run.shake = Math.min(14, Math.max(run.shake, mag));
  }

  // Haptic feedback (mobile) — guarded; a silent no-op on desktop / unsupported.
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }
  const hapticPatch     = () => vibrate(12);
  const hapticMilestone = () => vibrate([10, 20, 18]);
  const hapticHit       = () => vibrate(40);

  function fxBurst(x, y, color, n) {
    const run = G.run;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.5 + Math.random() * 1.6;
      run.parts.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.4,
        t: 0, life: 0.4 + Math.random() * 0.35,
        color, r: 2 + Math.random() * 3,
      });
    }
    if (run.parts.length > 140) run.parts.splice(0, run.parts.length - 140);
  }

  function updateFx(dt) {
    const run = G.run;
    if (run.shake > 0) run.shake = Math.max(0, run.shake - dt * 42);   // ~0.3s to settle from a big hit
    for (const f of run.floaters) { f.t += dt; f.y -= dt * 0.55; }
    run.floaters = run.floaters.filter((f) => f.t < f.life);
    for (const pt of run.parts) {
      pt.t += dt;
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vy += dt * 1.5;
    }
    run.parts = run.parts.filter((pt) => pt.t < pt.life);
  }

  // ------------------------------------------------------------------
  // Ambient menu backdrop: the last-played district with live traffic
  // and the player's fleet parked at the depot. No potholes, no scoring.
  // ------------------------------------------------------------------
  const NO_POTHOLES = [];

  function parkedFleet(d) {
    const loadout = (G.grid && G.grid.loadout) || activeLoadout(d);
    const depots = (G.grid && G.grid.depots) || depotSlots(d, loadout.length);
    const trucks = [];
    for (let i = 0; i < loadout.length; i++) {
      const { px, py } = parkPos(depots, i);
      const def = PP.vehicleById(loadout[i].type);
      trucks.push({ x: px, y: py, state: 'parked', angle: Math.PI / 2,
        vehType: loadout[i].type, movement: def && def.movement });
    }
    return trucks;
  }

  function startAmbient() {
    setDistrictById(PP.Save.data.district);
    G.grid = buildGrid(G.district);
    G.ambient = { cars: [], carT: 0.3, trucks: parkedFleet(G.district) };
    PP.Render.onDistrictChanged();

    // pre-roll some traffic so the menu doesn't open on empty streets
    for (let i = 0; i < 90; i++) updateAmbient(0.1);
  }

  // keep the parked fleet in sync after a hire / upgrade / loadout change in
  // Your Fleet — the depot square count can change, so rebuild the grid + map
  // layer too, then re-park the (possibly different) loadout behind the menu
  function refreshFleet() {
    if (!G.ambient) return;
    G.grid = buildGrid(G.district);
    G.ambient.trucks = parkedFleet(G.district);
    PP.Render.onDistrictChanged();
  }

  function updateAmbient(dt) {
    const amb = G.ambient;
    if (!amb) return;
    amb.carT -= dt;
    if (amb.carT <= 0) {
      amb.carT = G.district.carEvery * rnd(0.5, 1.1);
      if (amb.cars.length < 14) spawnCar(amb.cars);
    }
    for (const c of amb.cars) updateCar(c, dt, NO_POTHOLES, amb.trucks, amb.cars);
    amb.cars = amb.cars.filter((c) => !c.gone);
  }

  // ------------------------------------------------------------------
  // Rewarded-ad boons
  // ------------------------------------------------------------------
  function grantInstantRepair() {
    const run = G.run;
    if (!run) return;
    // recall any crews already en route / mid-patch back to the depot
    for (const tr of run.trucks) {
      if (tr.state === 'driving' || tr.state === 'patching') sendHome(tr);
    }
    let n = 0;
    for (const p of run.potholes) {
      if (p.state !== 'patched') { completePatch(p, null, true); n++; }
    }
    PP.Audio.play('reward');
    PP.UI.fundsPop();
    PP.UI.toast(n > 0 ? 'EMERGENCY CREW PATCHED ' + n + ' POTHOLES!' : 'STREETS ALREADY CLEAN!');
  }

  // ------------------------------------------------------------------
  // Hit-testing (for taps & drags), radius in tile units
  // ------------------------------------------------------------------
  function potholeAt(x, y, r) {
    if (!G.run) return null;
    let best = null, bd = r * r;
    for (const p of G.run.potholes) {
      if (p.state === 'patched') continue;
      const dx = p.x - x, dy = p.y - y, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = p; }
    }
    return best;
  }

  function idleTruckAt(x, y, r) {
    if (!G.run) return null;
    let best = null, bd = r * r;
    for (const tr of G.run.trucks) {
      if (!isAvailable(tr)) continue;
      const dx = tr.x - x, dy = tr.y - y, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = tr; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Main update — only called while effectivePlaying()
  // ------------------------------------------------------------------
  function update(dt) {
    const run = G.run, d = G.district;
    if (!run) return;
    run.t += dt;
    if (run.adCd > 0) run.adCd = Math.max(0, run.adCd - dt);

    // automatic pothole + traffic spawning — OFF during the tutorial, where
    // the script hand-places every hazard
    if (!run.tutorial) {
      // pothole spawning ramps up over the run
      run.spawnT -= dt;
      if (run.spawnT <= 0) {
        const interval = Math.max(d.spawn.min, d.spawn.start - d.spawn.ramp * run.t);
        run.spawnT = interval * rnd(0.75, 1.25);
        if (activePotholeCount() < d.maxPotholes) spawnPothole();
      }

      // traffic
      run.carT -= dt;
      if (run.carT <= 0) {
        run.carT = d.carEvery * rnd(0.6, 1.4);
        if (run.cars.length < 18) spawnCar(run.cars);
      }
    }
    for (const c of run.cars) updateCar(c, dt, run.potholes, run.trucks, run.cars);
    run.cars = run.cars.filter((c) => !c.gone);

    // potholes age & flash decay; drop patched ones (decals remain)
    for (const p of run.potholes) {
      p.sev = Math.min(1, (run.t - p.born) / 14);
      if (p.hitFlash > 0) p.hitFlash -= dt;
    }
    run.potholes = run.potholes.filter((p) => p.state !== 'patched');

    for (const tr of run.trucks) updateTruck(tr, dt, run.cars);
    updateFx(dt);

    if (run.rep <= 0) endRun();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  return {
    get state() { return G.state; },
    get run() { return G.run; },
    get grid() { return G.grid; },
    get district() { return G.district; },
    get ambient() { return G.ambient; },
    get selectedTruck() { return G.selectedTruck; },
    get drag() { return G.drag; },

    setDistrictById,
    startRun, endRun, toMenu,
    startTutorialRun, tutorialSpawnPothole, tutorialSpawnCar, tutorialDispatch, tutorialAward,
    startAmbient, updateAmbient, refreshFleet,
    update,
    pause, resume, effectivePlaying,

    deployableCount() { return activeLoadout(G.district || PP.DISTRICTS[0]).length; },
    requestDispatch, potholeAt, idleTruckAt,
    selectTruck(t) { G.selectedTruck = t; },
    clearSelection() { G.selectedTruck = null; },
    setDrag(truck, x, y) { G.drag = truck ? { truck, x, y } : null; },

    grantInstantRepair,
    setAdCooldown(s) { if (G.run) G.run.adCd = s; },

    debugSpawnPothole() { if (G.run) spawnPothole(); },
    debugEndRun() { endRun(); },
  };
})();
