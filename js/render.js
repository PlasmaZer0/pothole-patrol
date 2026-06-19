/* ====================================================================
   POTHOLE PATROL — render.js
   All canvas drawing. Flat-design 2D, no image assets.

   The map fills the ENTIRE viewport while on shift: tiles use
   independent horizontal/vertical sizes (tsx, tsy) so the grid
   stretches edge-to-edge, while entities (trucks, cars, potholes,
   cones, rings) are sized from `es` = min(tsx, tsy) so they never
   look distorted. The HUD floats on top of the map.

   The static city (ground, buildings, roads, depot) is pre-rendered to
   an offscreen "map layer" whenever the district or viewport changes;
   each frame only blits it and draws the dynamic entities on top.

   SPRITE SWAP NOTE: every entity has its own draw function below
   (drawTruck, drawCar, drawPothole, ...). To move to image sprites
   later, replace the body of a draw function with ctx.drawImage —
   call sites and coordinate handling stay identical.
   ==================================================================== */

PP.Render = (function () {
  let canvas, ctx;
  let W = 0, H = 0, dpr = 1;
  let tsx = 32, tsy = 32, es = 32;   // per-axis tile size + entity scale
  let mapLayer = null;

  // ------------------------------------------------------------------
  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout();
  }

  // the grid covers the whole viewport; recomputed on resize/rotation
  function layout() {
    const g = PP.Game.grid;
    if (!g) return;
    tsx = W / g.w;
    tsy = H / g.h;
    es = Math.min(tsx, tsy);
    buildMapLayer();
  }

  function onDistrictChanged() { layout(); }

  const tx2px = (x) => x * tsx;
  const ty2px = (y) => y * tsy;
  function pxToTile(px, py) { return { x: px / tsx, y: py / tsy }; }
  // tile coords -> screen pixels (used by the tutorial to aim the pointer at a pothole)
  function tileToPx(x, y) { return { x: x * tsx, y: y * tsy }; }

  // rounded-rect helper (with fallback for older browsers)
  // radius is clamped to a non-negative value that fits the box, so a
  // decoration with an odd/negative dimension can never throw.
  function rr(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // a thick rounded bar between two points — used for jointed crane arms
  function thickSeg(c, x1, y1, x2, y2, w) {
    const a = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1);
    c.save(); c.translate(x1, y1); c.rotate(a);
    rr(c, 0, -w / 2, len, w, w * 0.4); c.fill();
    c.restore();
  }

  // deterministic per-tile randomness so the city looks the same every frame
  function sr(n, seed) {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // ------------------------------------------------------------------
  // Static map layer
  // ------------------------------------------------------------------
  function buildMapLayer() {
    const g = PP.Game.grid, d = PP.Game.district;
    if (!g || !d) { mapLayer = null; return; }
    const th = d.theme;

    mapLayer = document.createElement('canvas');
    mapLayer.width = Math.round(W * dpr);
    mapLayer.height = Math.round(H * dpr);
    const m = mapLayer.getContext('2d');
    m.setTransform(dpr, 0, 0, dpr, 0, 0);

    m.fillStyle = '#1d2024';
    m.fillRect(0, 0, W, H);

    const depotSet = new Set((g.depots || []).map((t) => t.y * g.w + t.x));
    const lmSet = new Set((g.landmarks || []).map((l) => l.y * g.w + l.x));

    // tile rects are snapped to whole pixels so stretching leaves no seams
    for (let y = 0; y < g.h; y++) {
      const py = Math.round(y * tsy);
      const ph = Math.round((y + 1) * tsy) - py;
      for (let x = 0; x < g.w; x++) {
        const px = Math.round(x * tsx);
        const pw = Math.round((x + 1) * tsx) - px;
        const k = y * g.w + x;
        const ftype = featureAt(d, x, y);
        if (g.road[k]) drawRoadTile(m, d, g, x, y, px, py, pw, ph);
        else if (ftype) drawFeatureTile(m, ftype, x, y, px, py, pw, ph, d);
        else if (depotSet.has(k)) drawDepotTile(m, px, py, pw, ph);
        else if (lmSet.has(k)) {    // bare ground; landmark drawn live, above traffic
          m.fillStyle = (x + y) % 2 === 0 ? d.theme.ground : d.theme.groundAlt;
          m.fillRect(px, py, pw, ph);
        } else drawGroundTile(m, d, x, y, px, py, pw, ph, k);
      }
    }
  }

  // landmarks are drawn live (after traffic) so vehicles pass behind them;
  // sorted by row so nearer structures overlap farther ones correctly.
  function drawLandmarks(th, t) {
    const g = PP.Game.grid;
    if (!g || !g.landmarks || !g.landmarks.length) return;
    const sorted = g.landmarks.slice().sort((a, b) => a.y - b.y);
    for (const lm of sorted) {
      drawLandmark(ctx, lm.type, lm.x * tsx, lm.y * tsy, tsx, tsy, th, t || 0);
    }
  }

  // ------------------------------------------------------------------
  // Signature landmarks. Drawn rising from a ground line kept inside the
  // tile (so the base shadow doesn't spill onto the building below), at a
  // per-type scale tuned against the size of the cars.
  // ------------------------------------------------------------------
  function drawLandmark(m, type, px, py, pw, ph, th, t) {
    t = t || 0;
    const meta = PP.LANDMARK_META && PP.LANDMARK_META[type];
    const fw = (meta && meta.foot && meta.foot[0]) || 1;
    const cx = px + pw * fw / 2;   // centred across the footprint width
    const by = py + ph * 0.84;     // ground line at the base row (kept in-tile)
    const u = es * (meta ? meta.scale : 0.85);
    m.save();
    m.fillStyle = 'rgba(0,0,0,0.2)';   // base shadow, kept under the structure
    const shW = u * 0.5 * (fw > 1 ? fw * 0.7 : 1);
    m.beginPath(); m.ellipse(cx, by, shW, u * 0.13, 0, 0, 7); m.fill();

    switch (type) {
      case 'watertower': {
        const tw = u * 0.9, ty = by - u * 1.9, tankH = u * 0.7;
        m.strokeStyle = '#7d8590'; m.lineWidth = u * 0.08;
        m.beginPath();
        m.moveTo(cx - tw * 0.4, ty + tankH); m.lineTo(cx - tw * 0.25, by);
        m.moveTo(cx + tw * 0.4, ty + tankH); m.lineTo(cx + tw * 0.25, by);
        m.moveTo(cx - tw * 0.4, ty + tankH); m.lineTo(cx + tw * 0.25, by);
        m.moveTo(cx + tw * 0.4, ty + tankH); m.lineTo(cx - tw * 0.25, by);
        m.stroke();
        m.fillStyle = '#d8d2c4'; rr(m, cx - tw / 2, ty, tw, tankH, u * 0.12); m.fill();
        m.fillStyle = '#b04a3a';
        m.beginPath(); m.moveTo(cx - tw / 2 - 2, ty); m.lineTo(cx, ty - u * 0.5); m.lineTo(cx + tw / 2 + 2, ty); m.closePath(); m.fill();
        const wbk = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(t * 2.5), 3);                    // apex hazard light blinks
        m.save(); m.shadowBlur = wbk * 8; m.shadowColor = '#ff5f5f';
        m.fillStyle = `rgba(255,95,95,${0.5 + wbk * 0.5})`; m.beginPath(); m.arc(cx, ty - u * 0.5, u * 0.05, 0, 7); m.fill(); m.restore();
        break;
      }
      case 'billboard': {
        m.strokeStyle = '#6b6f76'; m.lineWidth = u * 0.1;
        m.beginPath(); m.moveTo(cx - u * 0.4, by); m.lineTo(cx - u * 0.4, by - u * 1.5);
        m.moveTo(cx + u * 0.4, by); m.lineTo(cx + u * 0.4, by - u * 1.5); m.stroke();
        const bw = u * 1.5, bh = u * 0.8, bx = cx - bw / 2, byy = by - u * 2.2;
        m.fillStyle = '#2e3440'; rr(m, bx - 2, byy - 2, bw + 4, bh + 4, 3); m.fill();
        m.fillStyle = '#ffc62e'; rr(m, bx, byy, bw, bh, 2); m.fill();
        m.fillStyle = '#e85d5d'; m.fillRect(bx + 4, byy + 4, bw - 8, bh * 0.4);
        m.fillStyle = '#16181c'; for (let i = 0; i < 3; i++) m.fillRect(bx + 8 + i * (bw * 0.3), byy + bh * 0.6, bw * 0.2, bh * 0.22);
        break;
      }
      case 'skyscraper': {
        const sw = u * 0.9, sh = u * 2.3, sx = cx - sw / 2, sy = by - sh;
        m.fillStyle = 'rgba(0,0,0,0.25)'; rr(m, sx + 3, sy + 4, sw, sh, 3); m.fill();
        m.fillStyle = '#5b6470'; rr(m, sx, sy, sw, sh, 3); m.fill();
        m.fillStyle = '#9fd8ff';
        for (let r = 0; r < 7; r++) for (let c = 0; c < 3; c++) {
          if ((r * 3 + c) % 5 === 0) continue;
          m.globalAlpha = 0.55 + ((r + c) % 2) * 0.3;
          m.fillRect(sx + u * 0.13 + c * u * 0.26, sy + u * 0.2 + r * u * 0.3, u * 0.16, u * 0.18);
        }
        m.globalAlpha = 1;
        m.strokeStyle = '#c4c4cc'; m.lineWidth = u * 0.05;
        m.beginPath(); m.moveTo(cx, sy); m.lineTo(cx, sy - u * 0.5); m.stroke();
        const bk = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * 3), 3);                    // beacon blinks
        m.save(); m.shadowBlur = bk * 10; m.shadowColor = '#ff5f5f';
        m.fillStyle = `rgba(255,95,95,${0.5 + bk * 0.5})`; m.beginPath(); m.arc(cx, sy - u * 0.5, u * 0.07, 0, 7); m.fill();
        m.restore();
        break;
      }
      case 'palm': {
        m.fillStyle = '#4fb3c4'; m.beginPath(); m.ellipse(cx, by - u * 0.05, u * 0.7, u * 0.22, 0, 0, 7); m.fill();
        m.strokeStyle = '#8a6a3a'; m.lineWidth = u * 0.14; m.lineCap = 'round';
        m.beginPath(); m.moveTo(cx - u * 0.1, by - u * 0.1); m.quadraticCurveTo(cx + u * 0.2, by - u * 1.1, cx + u * 0.05, by - u * 1.7); m.stroke();
        m.lineCap = 'butt'; m.fillStyle = '#4f8a4a';
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.55 + Math.sin(t * 1.2 + i) * 0.08;             // fronds sway in the breeze
          m.save(); m.translate(cx + u * 0.05, by - u * 1.7); m.rotate(a);
          m.beginPath(); m.ellipse(u * 0.5, 0, u * 0.5, u * 0.15, 0, 0, 7); m.fill(); m.restore();
        }
        m.fillStyle = '#7a4b2a'; m.beginPath(); m.arc(cx + u * 0.05, by - u * 1.62, u * 0.1, 0, 7); m.fill();
        break;
      }
      case 'minaret': {
        const tw = u * 0.5, mh = u * 1.9, tx = cx - tw / 2, ty = by - mh;
        m.fillStyle = '#ece1c6'; rr(m, tx, ty, tw, mh, u * 0.1); m.fill();
        m.fillStyle = '#5a8a7a'; m.fillRect(tx - u * 0.1, ty + u * 0.6, tw + u * 0.2, u * 0.12);
        m.fillStyle = '#3a7a6a'; m.beginPath(); m.arc(cx, ty, tw * 0.7, Math.PI, 0); m.fill();
        m.strokeStyle = '#caa14a'; m.lineWidth = u * 0.05;
        m.beginPath(); m.moveTo(cx, ty - tw * 0.7); m.lineTo(cx, ty - tw * 1.15); m.stroke();
        m.save(); m.shadowBlur = 3 + 5 * (0.5 + 0.5 * Math.sin(t * 1.8)); m.shadowColor = '#ffe0a0';   // finial glints
        m.fillStyle = '#caa14a'; m.beginPath(); m.arc(cx, ty - tw * 1.25, u * 0.1, 0, 7); m.fill(); m.restore();
        break;
      }
      case 'pyramid': {
        const pw2 = u * 2.2, pyh = u * 1.7;
        m.fillStyle = '#caa05a'; m.beginPath(); m.moveTo(cx, by - pyh); m.lineTo(cx - pw2 / 2, by); m.lineTo(cx + pw2 / 2, by); m.closePath(); m.fill();
        m.fillStyle = '#b5854a'; m.beginPath(); m.moveTo(cx, by - pyh); m.lineTo(cx + pw2 / 2, by); m.lineTo(cx, by); m.closePath(); m.fill();
        m.strokeStyle = 'rgba(0,0,0,0.15)'; m.lineWidth = 1;
        for (let i = 1; i < 4; i++) { const yy = by - pyh * i / 4, hw = pw2 / 2 * (1 - i / 4); m.beginPath(); m.moveTo(cx - hw, yy); m.lineTo(cx + hw, yy); m.stroke(); }
        const sgl = 0.5 + 0.5 * Math.sin(t * 1.4);                                            // desert sun shimmers
        m.save(); m.shadowBlur = 6 + sgl * 12; m.shadowColor = '#ffd86b';
        m.fillStyle = '#ffd86b'; m.beginPath(); m.arc(cx + pw2 * 0.42, by - pyh * 0.95, u * (0.16 + sgl * 0.04), 0, 7); m.fill(); m.restore();
        break;
      }
      case 'balloon': {
        const r2 = u * 0.7, cyb = by - u * 1.18;            // envelope centre
        m.save(); m.translate(0, Math.sin(t * 1.1) * u * 0.08);   // gentle drift bob
        m.fillStyle = '#7a5230'; rr(m, cx - u * 0.2, by - u * 0.36, u * 0.4, u * 0.32, u * 0.05); m.fill();   // basket
        m.fillStyle = '#5e3f24'; m.fillRect(cx - u * 0.2, by - u * 0.36, u * 0.4, u * 0.06);                  // basket rim
        m.strokeStyle = 'rgba(40,30,20,0.5)'; m.lineWidth = Math.max(1, u * 0.03);                            // ropes
        m.beginPath();
        m.moveTo(cx - u * 0.18, by - u * 0.36); m.lineTo(cx - r2 * 0.55, cyb + r2 * 0.6);
        m.moveTo(cx + u * 0.18, by - u * 0.36); m.lineTo(cx + r2 * 0.55, cyb + r2 * 0.6);
        m.stroke();
        m.fillStyle = '#d94f5d';                            // neck taper to the basket
        m.beginPath();
        m.moveTo(cx - r2 * 0.55, cyb + r2 * 0.5); m.lineTo(cx + r2 * 0.55, cyb + r2 * 0.5);
        m.lineTo(cx + r2 * 0.16, cyb + r2 * 1.0); m.lineTo(cx - r2 * 0.16, cyb + r2 * 1.0); m.closePath(); m.fill();
        m.fillStyle = '#ff6f7d';                            // envelope
        m.beginPath(); m.arc(cx, cyb, r2, 0, 7); m.fill();
        m.fillStyle = '#ffd24d';                            // gore stripes
        m.beginPath(); m.ellipse(cx, cyb, r2 * 0.22, r2, 0, 0, 7); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.32)';
        m.beginPath(); m.ellipse(cx - r2 * 0.46, cyb, r2 * 0.15, r2 * 0.92, 0, 0, 7); m.fill();
        m.beginPath(); m.ellipse(cx + r2 * 0.46, cyb, r2 * 0.15, r2 * 0.92, 0, 0, 7); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.4)';              // highlight
        m.beginPath(); m.arc(cx - r2 * 0.34, cyb - r2 * 0.34, r2 * 0.18, 0, 7); m.fill();
        m.restore();
        break;
      }
      case 'windmill': {
        const tw = u * 0.6, mh = u * 1.5, tx = cx - tw / 2, ty = by - mh;
        m.fillStyle = '#eef2f7';                            // tapered tower
        m.beginPath(); m.moveTo(tx - u * 0.06, by); m.lineTo(tx + tw * 0.2, ty); m.lineTo(tx + tw * 0.8, ty); m.lineTo(tx + tw + u * 0.06, by); m.closePath(); m.fill();
        m.fillStyle = 'rgba(0,0,0,0.07)';                   // stone bands
        for (let i = 1; i < 4; i++) m.fillRect(tx - u * 0.04, ty + mh * i / 4, tw + u * 0.08, u * 0.04);
        m.fillStyle = '#7a8aa0'; rr(m, cx - u * 0.1, by - u * 0.4, u * 0.2, u * 0.4, u * 0.04); m.fill();      // door
        m.fillStyle = '#5a6b8a';                            // conical cap
        m.beginPath(); m.moveTo(tx + tw * 0.1, ty); m.lineTo(cx, ty - u * 0.45); m.lineTo(tx + tw * 0.9, ty); m.closePath(); m.fill();
        const huby = ty - u * 0.02;                         // sails (4 blades) turn
        m.save(); m.translate(cx, huby); m.rotate(0.35 + t * 0.7);
        for (let i = 0; i < 4; i++) {
          m.rotate(Math.PI / 2);
          m.fillStyle = '#dbe4f0';
          m.beginPath(); m.moveTo(0, 0); m.lineTo(u * 0.12, -u * 0.9); m.lineTo(-u * 0.06, -u * 0.95); m.closePath(); m.fill();
          m.strokeStyle = '#8a96a8'; m.lineWidth = u * 0.03; m.stroke();
        }
        m.restore();
        m.fillStyle = '#3a4250'; m.beginPath(); m.arc(cx, huby, u * 0.1, 0, 7); m.fill();                     // hub
        break;
      }
      case 'cloudcastle': {
        m.fillStyle = '#ffffff';                            // the cloud it floats on (lifted + slimmer so it clears the road)
        for (const [ox, oy, rad] of [[0, -0.55, 0.78], [-0.46, -0.42, 0.46], [0.46, -0.42, 0.46]]) {
          m.beginPath(); m.arc(cx + ox * u, by + oy * u, u * rad * 0.7, 0, 7); m.fill();
        }
        const bw = u * 1.2, bh = u * 1.05, bx = cx - bw / 2, byy = by - u * 0.5 - bh;
        m.fillStyle = '#cdd7ea'; rr(m, bx, byy, bw, bh, u * 0.05); m.fill();                                  // keep
        m.fillStyle = 'rgba(0,0,0,0.1)'; m.fillRect(bx, byy + bh - u * 0.12, bw, u * 0.12);
        m.fillStyle = '#cdd7ea';                            // battlements
        for (let i = 0; i < 5; i++) m.fillRect(bx + i * (bw / 5), byy - u * 0.12, bw / 5 * 0.6, u * 0.12);
        const tower = (txc, tw, th2) => {                   // spired tower helper
          m.fillStyle = '#bcc8e0'; m.fillRect(txc - tw / 2, byy - th2, tw, th2 + bh * 0.2);
          m.fillStyle = '#7f8db5';
          m.beginPath(); m.moveTo(txc - tw * 0.7, byy - th2); m.lineTo(txc, byy - th2 - tw * 1.2); m.lineTo(txc + tw * 0.7, byy - th2); m.closePath(); m.fill();
          m.strokeStyle = '#5a6b8a'; m.lineWidth = u * 0.03;
          m.beginPath(); m.moveTo(txc, byy - th2 - tw * 1.2); m.lineTo(txc, byy - th2 - tw * 1.6); m.stroke();
          m.fillStyle = '#ff6f7d';
          m.beginPath(); m.moveTo(txc, byy - th2 - tw * 1.55); m.lineTo(txc + tw * 0.7, byy - th2 - tw * 1.4); m.lineTo(txc, byy - th2 - tw * 1.25); m.closePath(); m.fill();
        };
        tower(bx + u * 0.2, u * 0.32, u * 0.5);
        tower(bx + bw - u * 0.2, u * 0.32, u * 0.5);
        tower(cx, u * 0.42, u * 0.95);
        m.fillStyle = '#6b7895'; rr(m, cx - u * 0.16, byy + bh - u * 0.5, u * 0.32, u * 0.5, u * 0.14); m.fill();   // gate
        m.fillStyle = '#9fd8ff';                            // lit windows
        for (const ox of [-0.32, 0.32]) m.fillRect(cx + ox * u - u * 0.05, byy + u * 0.25, u * 0.1, u * 0.18);
        break;
      }
      case 'phonebox': {
        const bw = u * 0.62, bh = u * 1.3, bx = cx - bw / 2, byy = by - bh;
        m.fillStyle = 'rgba(0,0,0,0.25)'; rr(m, bx + 2, byy + 3, bw, bh, 3); m.fill();
        m.fillStyle = '#c0392b'; rr(m, bx, byy, bw, bh, u * 0.08); m.fill();
        m.fillStyle = '#f4efe6'; m.fillRect(bx + u * 0.08, byy + u * 0.12, bw - u * 0.16, u * 0.12);
        m.fillStyle = '#7fb0c0'; m.fillRect(bx + u * 0.1, byy + u * 0.35, bw - u * 0.2, bh - u * 0.5);
        m.strokeStyle = '#c0392b'; m.lineWidth = u * 0.05; m.strokeRect(bx + u * 0.1, byy + u * 0.35, bw - u * 0.2, bh - u * 0.5);
        break;
      }
      case 'bigben': {
        const tw = u * 0.72, tth = u * 2.4, tx = cx - tw / 2, ty = by - tth;
        m.fillStyle = 'rgba(0,0,0,0.25)'; m.fillRect(tx + 3, ty + 4, tw, tth);
        m.fillStyle = '#b89a6a'; m.fillRect(tx, ty, tw, tth);
        m.fillStyle = '#9a7f52'; for (let r = 0; r < 6; r++) m.fillRect(tx, ty + u * 0.3 + r * u * 0.36, tw, u * 0.04);
        m.fillStyle = '#f4efe6'; m.beginPath(); m.arc(cx, ty + u * 0.55, tw * 0.32, 0, 7); m.fill();
        m.strokeStyle = '#16181c'; m.lineWidth = u * 0.04;
        m.beginPath(); m.arc(cx, ty + u * 0.55, tw * 0.32, 0, 7); m.stroke();
        const fcy = ty + u * 0.55, fr2 = tw * 0.32, mA = t * 1.1 - Math.PI / 2, hA = t * 0.09 - Math.PI / 2;   // hands sweep
        m.beginPath(); m.moveTo(cx, fcy); m.lineTo(cx + Math.cos(mA) * fr2 * 0.85, fcy + Math.sin(mA) * fr2 * 0.85);
        m.moveTo(cx, fcy); m.lineTo(cx + Math.cos(hA) * fr2 * 0.55, fcy + Math.sin(hA) * fr2 * 0.55); m.stroke();
        m.fillStyle = '#5a7d6a'; m.beginPath(); m.moveTo(tx - 2, ty); m.lineTo(cx, ty - u * 0.7); m.lineTo(tx + tw + 2, ty); m.closePath(); m.fill();
        break;
      }
      case 'londoneye': {
        const r2 = u * 1.1, cyc = by - r2 - u * 0.2;
        m.strokeStyle = '#9aa0a6'; m.lineWidth = u * 0.08;
        m.beginPath(); m.moveTo(cx - u * 0.5, by); m.lineTo(cx, cyc); m.moveTo(cx + u * 0.5, by); m.lineTo(cx, cyc); m.stroke();
        m.strokeStyle = '#bcdcff'; m.lineWidth = u * 0.06; m.beginPath(); m.arc(cx, cyc, r2, 0, 7); m.stroke();
        const spin = t * 0.25;                                                                // the wheel slowly turns
        m.lineWidth = u * 0.03; for (let i = 0; i < 10; i++) { const a = i / 10 * 7 + spin; m.beginPath(); m.moveTo(cx, cyc); m.lineTo(cx + Math.cos(a) * r2, cyc + Math.sin(a) * r2); m.stroke(); }
        m.fillStyle = '#5fd0ff'; for (let i = 0; i < 10; i++) { const a = i / 10 * 7 + spin; m.beginPath(); m.arc(cx + Math.cos(a) * r2, cyc + Math.sin(a) * r2, u * 0.08, 0, 7); m.fill(); }
        break;
      }
      case 'cabin': {
        const bw = u * 1.4, bh = u * 0.9, bx = cx - bw / 2, byy = by - bh;
        m.fillStyle = '#7a5436'; rr(m, bx, byy, bw, bh, u * 0.06); m.fill();
        m.fillStyle = '#6a4730'; for (let r = 0; r < 3; r++) m.fillRect(bx, byy + u * 0.18 + r * u * 0.22, bw, u * 0.04);
        m.fillStyle = '#3a3d42'; m.fillRect(cx + bw * 0.25, byy - u * 0.5, u * 0.18, u * 0.5);
        m.fillStyle = '#eef4f8'; m.beginPath(); m.moveTo(bx - u * 0.1, byy); m.lineTo(cx, byy - u * 0.6); m.lineTo(bx + bw + u * 0.1, byy); m.closePath(); m.fill();
        m.fillStyle = '#ffd86b'; m.fillRect(cx - u * 0.12, byy + u * 0.32, u * 0.24, u * 0.3);
        for (let i = 0; i < 3; i++) {                                                         // chimney smoke curls up
          const ph2 = (t * 0.4 + i / 3) % 1;
          m.fillStyle = `rgba(235,238,242,${0.5 * (1 - ph2)})`;
          m.beginPath(); m.arc(cx + bw * 0.34 + Math.sin(ph2 * 5 + i) * u * 0.08, byy - u * 0.55 - ph2 * u * 0.9, u * (0.08 + ph2 * 0.12), 0, 7); m.fill();
        }
        break;
      }
      case 'lighthouse': {
        const tw = u * 0.7, lh = u * 1.8, tx = cx - tw / 2, ty = by - lh;
        const body = () => { m.beginPath(); m.moveTo(tx, by); m.lineTo(tx + tw * 0.15, ty); m.lineTo(tx + tw * 0.85, ty); m.lineTo(tx + tw, by); m.closePath(); };
        m.fillStyle = '#f4efe6'; body(); m.fill();
        m.save(); body(); m.clip();
        m.fillStyle = '#c0392b'; for (let i = 0; i < 3; i++) m.fillRect(tx - 2, ty + u * 0.2 + i * u * 0.55, tw + 4, u * 0.28);
        m.restore();
        m.fillStyle = '#2e3440'; m.fillRect(cx - tw * 0.45, ty - u * 0.3, tw * 0.9, u * 0.3);
        const lampY = ty - u * 0.15;                                                          // beam sweeps back and forth
        m.save(); m.translate(cx, lampY); m.rotate(Math.sin(t * 0.8) * 0.5);
        const beam = m.createLinearGradient(0, 0, u * 1.6, 0);
        beam.addColorStop(0, 'rgba(255,235,150,0.45)'); beam.addColorStop(1, 'rgba(255,235,150,0)');
        m.fillStyle = beam; m.beginPath(); m.moveTo(0, 0); m.lineTo(u * 1.6, -u * 0.35); m.lineTo(u * 1.6, u * 0.35); m.closePath(); m.fill();
        m.restore();
        m.save(); m.shadowBlur = 8 + 6 * Math.abs(Math.sin(t * 0.8)); m.shadowColor = '#ffe14d';
        m.fillStyle = '#ffe14d'; m.beginPath(); m.arc(cx, lampY, u * 0.14, 0, 7); m.fill(); m.restore();
        break;
      }
      case 'icespire': {
        const spike = (ox, h, w, col) => { m.fillStyle = col; m.beginPath(); m.moveTo(cx + ox - w, by); m.lineTo(cx + ox, by - h); m.lineTo(cx + ox + w, by); m.closePath(); m.fill(); };
        spike(-u * 0.5, u * 1.2, u * 0.3, '#8fc6e0');
        spike(u * 0.45, u * 1.4, u * 0.32, '#bce0f0');
        spike(-u * 0.05, u * 2.0, u * 0.42, '#a6d4ea');
        m.fillStyle = 'rgba(255,255,255,0.6)'; m.beginPath(); m.moveTo(cx - u * 0.07, by - u * 1.0); m.lineTo(cx, by - u * 2.0); m.lineTo(cx + u * 0.04, by - u * 1.0); m.closePath(); m.fill();
        break;
      }
      case 'clam': {
        m.fillStyle = '#ff9ec4'; m.beginPath(); m.ellipse(cx, by - u * 0.2, u * 0.95, u * 0.7, 0, Math.PI, 0); m.fill();
        m.strokeStyle = '#d96f96'; m.lineWidth = u * 0.05;
        for (let i = -3; i <= 3; i++) { m.beginPath(); m.moveTo(cx, by - u * 0.2); m.lineTo(cx + i * u * 0.26, by - u * 0.85); m.stroke(); }
        m.fillStyle = '#ffd8e8'; m.beginPath(); m.ellipse(cx, by - u * 0.1, u * 0.95, u * 0.3, 0, 0, Math.PI); m.fill();
        const pp = 0.5 + 0.5 * Math.sin(t * 1.6);                                             // pearl glows
        m.save(); m.shadowBlur = 4 + pp * 8; m.shadowColor = '#cfe8ff';
        m.fillStyle = '#fff'; m.beginPath(); m.arc(cx, by - u * 0.32, u * (0.18 + pp * 0.03), 0, 7); m.fill(); m.restore();
        break;
      }
      case 'shipwreck': {
        m.save(); m.translate(cx, by); m.rotate(-0.12);
        m.fillStyle = '#6a4a30'; m.beginPath(); m.moveTo(-u * 1.0, -u * 0.2); m.quadraticCurveTo(0, u * 0.5, u * 1.0, -u * 0.2); m.lineTo(u * 0.8, -u * 0.7); m.lineTo(-u * 0.8, -u * 0.7); m.closePath(); m.fill();
        m.fillStyle = '#5a3d28'; for (let i = 0; i < 3; i++) m.fillRect(-u * 0.9, -u * 0.6 + i * u * 0.2, u * 1.8, u * 0.05);
        m.strokeStyle = '#4a3320'; m.lineWidth = u * 0.1; m.beginPath(); m.moveTo(0, -u * 0.7); m.lineTo(u * 0.1, -u * 1.7); m.stroke();
        m.fillStyle = 'rgba(230,225,210,0.55)'; m.beginPath(); m.moveTo(u * 0.1, -u * 1.6); m.lineTo(u * 0.7, -u * 1.2); m.lineTo(u * 0.12, -u * 0.9); m.closePath(); m.fill();
        m.restore();
        break;
      }
      case 'poseidon': {
        m.fillStyle = '#8aa6b0'; rr(m, cx - u * 0.5, by - u * 0.4, u * 1.0, u * 0.4, u * 0.05); m.fill();
        m.fillStyle = '#a6c0c8'; rr(m, cx - u * 0.22, by - u * 1.6, u * 0.44, u * 1.2, u * 0.12); m.fill();
        m.beginPath(); m.arc(cx, by - u * 1.72, u * 0.22, 0, 7); m.fill();
        m.strokeStyle = '#caa14a'; m.lineWidth = u * 0.07;
        m.beginPath(); m.moveTo(cx + u * 0.42, by - u * 0.2); m.lineTo(cx + u * 0.42, by - u * 2.0); m.stroke();
        m.lineWidth = u * 0.05;
        for (const ox of [-u * 0.16, 0, u * 0.16]) { m.beginPath(); m.moveTo(cx + u * 0.42 + ox, by - u * 1.95); m.lineTo(cx + u * 0.42 + ox, by - u * 2.3); m.stroke(); }
        break;
      }
      case 'lander': {
        m.fillStyle = '#c4b04a';
        m.beginPath(); m.moveTo(cx - u * 0.5, by - u * 0.8); m.lineTo(cx + u * 0.5, by - u * 0.8); m.lineTo(cx + u * 0.35, by - u * 1.3); m.lineTo(cx - u * 0.35, by - u * 1.3); m.closePath(); m.fill();
        m.fillStyle = '#9aa0aa'; rr(m, cx - u * 0.3, by - u * 1.55, u * 0.6, u * 0.3, u * 0.05); m.fill();
        m.strokeStyle = '#8a8f96'; m.lineWidth = u * 0.06;
        m.beginPath(); m.moveTo(cx - u * 0.4, by - u * 0.8); m.lineTo(cx - u * 0.7, by); m.moveTo(cx + u * 0.4, by - u * 0.8); m.lineTo(cx + u * 0.7, by); m.stroke();
        m.strokeStyle = '#d0d4da'; m.lineWidth = u * 0.04; m.beginPath(); m.moveTo(cx + u * 0.6, by - u * 1.0); m.lineTo(cx + u * 0.6, by - u * 1.6); m.stroke();
        m.fillStyle = '#5fd0ff'; m.fillRect(cx + u * 0.6, by - u * 1.6, u * 0.4, u * 0.24);
        break;
      }
      case 'dome': {
        m.fillStyle = '#aeb4be'; m.beginPath(); m.arc(cx, by - u * 0.1, u * 1.0, Math.PI, 0); m.fill();
        m.fillStyle = '#bcdcff'; m.beginPath(); m.arc(cx, by - u * 0.1, u * 0.7, Math.PI, 0); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.4)'; m.beginPath(); m.arc(cx - u * 0.3, by - u * 0.4, u * 0.25, Math.PI, 0); m.fill();
        m.strokeStyle = '#8a8f96'; m.lineWidth = u * 0.05; m.beginPath(); m.moveTo(cx + u * 0.6, by - u * 0.6); m.lineTo(cx + u * 0.95, by - u * 1.2); m.stroke();   // mast
        m.save(); m.translate(cx + u * 0.95, by - u * 1.2); m.rotate(Math.sin(t * 0.6) * 0.6);   // dish scans the sky
        m.fillStyle = '#d0d4da'; m.beginPath(); m.arc(0, 0, u * 0.18, Math.PI * 0.2, Math.PI * 1.2); m.fill();
        m.strokeStyle = '#9aa0aa'; m.lineWidth = u * 0.03; m.beginPath(); m.moveTo(0, 0); m.lineTo(0, -u * 0.2); m.stroke();
        m.restore();
        break;
      }
      case 'rocket': {
        m.strokeStyle = '#7d8590'; m.lineWidth = u * 0.06; m.beginPath(); m.moveTo(cx + u * 0.5, by); m.lineTo(cx + u * 0.5, by - u * 1.8); m.stroke();
        m.fillStyle = '#e8e3da'; m.beginPath(); m.moveTo(cx - u * 0.3, by - u * 0.2); m.lineTo(cx - u * 0.3, by - u * 1.6); m.quadraticCurveTo(cx, by - u * 2.2, cx + u * 0.3, by - u * 1.6); m.lineTo(cx + u * 0.3, by - u * 0.2); m.closePath(); m.fill();
        m.fillStyle = '#c0392b'; m.beginPath(); m.moveTo(cx - u * 0.3, by - u * 1.55); m.quadraticCurveTo(cx, by - u * 2.2, cx + u * 0.3, by - u * 1.55); m.closePath(); m.fill();
        m.fillStyle = `rgba(95,208,255,${0.6 + 0.4 * Math.sin(t * 3)})`; m.beginPath(); m.arc(cx, by - u * 1.2, u * 0.12, 0, 7); m.fill();   // porthole pulses
        m.fillStyle = '#3a3d42';
        m.beginPath(); m.moveTo(cx - u * 0.3, by - u * 0.2); m.lineTo(cx - u * 0.55, by); m.lineTo(cx - u * 0.15, by); m.closePath(); m.fill();
        m.beginPath(); m.moveTo(cx + u * 0.3, by - u * 0.2); m.lineTo(cx + u * 0.55, by); m.lineTo(cx + u * 0.15, by); m.closePath(); m.fill();
        break;
      }
      case 'hologram': {
        m.fillStyle = '#2a2d4a'; rr(m, cx - u * 0.5, by - u * 0.3, u * 1.0, u * 0.3, u * 0.06); m.fill();
        m.save(); m.shadowBlur = 8 + 5 * Math.sin(t * 5); m.shadowColor = th.decorA;          // projection flickers
        m.fillStyle = `rgba(61,240,255,${0.25 + 0.18 * (0.5 + 0.5 * Math.sin(t * 8 + 1))})`;
        m.beginPath(); m.moveTo(cx - u * 0.4, by - u * 0.3); m.lineTo(cx - u * 0.7, by - u * 1.7); m.lineTo(cx + u * 0.7, by - u * 1.7); m.lineTo(cx + u * 0.4, by - u * 0.3); m.closePath(); m.fill();
        m.fillStyle = th.decorB;
        m.save(); m.translate(cx, by - u * 1.0); m.rotate(t * 1.2);                            // rotating glyph
        m.beginPath(); m.moveTo(0, -u * 0.4); m.lineTo(u * 0.3, 0); m.lineTo(0, u * 0.4); m.lineTo(-u * 0.3, 0); m.closePath(); m.fill();
        m.restore();
        m.restore();
        break;
      }
      case 'neonarch': {
        m.save(); m.shadowBlur = 8 + 8 * (0.5 + 0.5 * Math.sin(t * 2.5)); m.shadowColor = th.decorB;   // neon hums brighter / dimmer
        m.strokeStyle = th.decorB; m.lineWidth = u * 0.14;
        m.beginPath(); m.moveTo(cx - u * 0.8, by); m.lineTo(cx - u * 0.8, by - u * 1.0); m.arc(cx, by - u * 1.0, u * 0.8, Math.PI, 0); m.lineTo(cx + u * 0.8, by); m.stroke();
        m.strokeStyle = th.decorA; m.lineWidth = u * 0.05; m.stroke();
        m.restore();
        break;
      }
      case 'reactor': {
        m.fillStyle = '#2d3a5a'; m.beginPath(); m.moveTo(cx - u * 0.5, by); m.lineTo(cx - u * 0.3, by - u * 2.0); m.lineTo(cx + u * 0.3, by - u * 2.0); m.lineTo(cx + u * 0.5, by); m.closePath(); m.fill();
        const rpulse = 0.5 + 0.5 * Math.sin(t * 3);                                           // reactor surges
        m.save(); m.shadowBlur = 8 + rpulse * 14; m.shadowColor = th.decorA;
        m.strokeStyle = th.decorA; m.lineWidth = u * (0.05 + rpulse * 0.03);
        for (let i = 0; i < 3; i++) { const yy = by - u * 0.5 - i * u * 0.6; m.beginPath(); m.ellipse(cx, yy, u * 0.5 - i * u * 0.08, u * 0.14, 0, 0, 7); m.stroke(); }
        m.fillStyle = th.decorB; m.beginPath(); m.arc(cx, by - u * 2.0, u * (0.15 + rpulse * 0.06), 0, 7); m.fill();
        m.restore();
        break;
      }
      case 'volcano': {
        const vw = u * 2.0, vh = u * 1.6;
        m.fillStyle = '#3a302c'; m.beginPath(); m.moveTo(cx - vw / 2, by); m.lineTo(cx - vw * 0.16, by - vh); m.lineTo(cx + vw * 0.16, by - vh); m.lineTo(cx + vw / 2, by); m.closePath(); m.fill();
        m.fillStyle = '#2a221e'; m.beginPath(); m.moveTo(cx, by - vh); m.lineTo(cx + vw * 0.16, by - vh); m.lineTo(cx + vw / 2, by); m.lineTo(cx, by); m.closePath(); m.fill();   // shaded side
        for (let i = 0; i < 3; i++) {                                                  // rising ash plume
          const ph2 = (t * 0.25 + i / 3) % 1, sy = (by - vh) - ph2 * vh * 0.9;
          m.fillStyle = `rgba(92,84,80,${0.4 * (1 - ph2)})`;
          m.beginPath(); m.arc(cx + Math.sin(ph2 * 6 + i) * u * 0.18, sy, u * (0.12 + ph2 * 0.22), 0, 7); m.fill();
        }
        const gl = 0.5 + 0.5 * Math.sin(t * 2);                                        // crater lava pulses
        m.save(); m.shadowBlur = 6 + gl * 12; m.shadowColor = '#ff7a2a';
        m.fillStyle = '#ff7a2a'; m.beginPath(); m.ellipse(cx, by - vh, vw * 0.16, u * 0.1, 0, 0, 7); m.fill();
        m.strokeStyle = '#ffd34a'; m.lineWidth = u * 0.08; m.lineCap = 'round';        // lava drip
        m.beginPath(); m.moveTo(cx, by - vh); m.lineTo(cx - u * 0.18, by - vh * 0.4); m.stroke();
        m.restore(); m.lineCap = 'butt';
        break;
      }
      case 'obsidian': {
        m.fillStyle = '#1a1620';
        m.beginPath();
        m.moveTo(cx - u * 0.5, by); m.lineTo(cx - u * 0.2, by - u * 1.8); m.lineTo(cx + u * 0.1, by - u * 1.2); m.lineTo(cx + u * 0.4, by - u * 1.9); m.lineTo(cx + u * 0.5, by);
        m.closePath(); m.fill();
        m.fillStyle = `rgba(150,120,200,${0.25 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.5))})`;   // glassy sheen shimmers
        m.beginPath(); m.moveTo(cx - u * 0.12, by - u * 1.7); m.lineTo(cx, by - u * 0.6); m.lineTo(cx + u * 0.08, by - u * 1.1); m.closePath(); m.fill();
        break;
      }
      case 'forge': {
        const fw = u * 1.1, fh = u * 1.5;
        m.fillStyle = '#3a3236'; rr(m, cx - fw / 2, by - fh, fw, fh, u * 0.08); m.fill();                       // furnace body
        m.fillStyle = '#22202a'; rr(m, cx - fw * 0.18, by - fh - u * 0.7, fw * 0.36, u * 0.7, u * 0.05); m.fill(); // chimney
        const flick = 0.6 + 0.4 * Math.sin(t * 7 + 1.3) * Math.sin(t * 3.1);                  // irregular fire flicker
        m.save(); m.shadowBlur = 8 + flick * 10; m.shadowColor = '#ff7a2a';
        m.fillStyle = `rgb(255,${(120 + flick * 50) | 0},42)`; rr(m, cx - fw * 0.28, by - fh * 0.55, fw * 0.56, fh * 0.4, u * 0.06); m.fill();   // mouth glow
        m.restore();
        for (let i = 0; i < 2; i++) {                                                         // chimney smoke
          const ph2 = (t * 0.3 + i / 2) % 1, sy = (by - fh - u * 0.7) - ph2 * u * 1.0;
          m.fillStyle = `rgba(80,74,80,${0.4 * (1 - ph2)})`;
          m.beginPath(); m.arc(cx + Math.sin(ph2 * 5 + i) * u * 0.1, sy, u * (0.08 + ph2 * 0.12), 0, 7); m.fill();
        }
        m.fillStyle = `rgba(255,211,74,${0.6 + flick * 0.4})`; m.beginPath(); m.arc(cx, by - fh - u * 0.7, u * 0.12, 0, 7); m.fill();   // ember
        break;
      }
      case 'gingerbread': {
        const gw = u * 1.4, gh = u * 1.0;
        m.fillStyle = '#a9683a'; rr(m, cx - gw / 2, by - gh, gw, gh, u * 0.06); m.fill();        // body
        m.fillStyle = '#c98a52'; m.beginPath(); m.moveTo(cx - gw / 2 - u * 0.1, by - gh); m.lineTo(cx, by - gh - u * 0.7); m.lineTo(cx + gw / 2 + u * 0.1, by - gh); m.closePath(); m.fill();   // roof
        m.strokeStyle = '#fff4e6'; m.lineWidth = u * 0.06; m.lineCap = 'round';                  // icing trim
        m.beginPath(); m.moveTo(cx - gw / 2 - u * 0.1, by - gh); m.lineTo(cx, by - gh - u * 0.7); m.lineTo(cx + gw / 2 + u * 0.1, by - gh); m.stroke();
        m.lineCap = 'butt';
        m.fillStyle = '#ff5d8a';                                                                 // gumdrops
        for (let i = 0; i < 3; i++) { m.beginPath(); m.arc(cx - gw * 0.3 + i * gw * 0.3, by - gh * 0.4, u * 0.08, 0, 7); m.fill(); }
        m.fillStyle = '#5fd0c4'; rr(m, cx - u * 0.12, by - gh * 0.5, u * 0.24, gh * 0.5, 2); m.fill();   // door
        break;
      }
      case 'candyfountain': {
        m.fillStyle = '#ffb0c8'; rr(m, cx - u * 0.7, by - u * 0.3, u * 1.4, u * 0.3, u * 0.1); m.fill();   // basin
        m.fillStyle = '#ff7ab0'; rr(m, cx - u * 0.5, by - u * 0.9, u * 1.0, u * 0.3, u * 0.1); m.fill();   // mid tier
        m.fillStyle = '#ff5d8a'; rr(m, cx - u * 0.3, by - u * 1.4, u * 0.6, u * 0.3, u * 0.1); m.fill();    // top tier
        m.fillStyle = 'rgba(255,225,180,0.9)';                                                            // cascading syrup
        for (let i = 0; i < 3; i++) { const ph2 = (t * 0.9 + i / 3) % 1; m.beginPath(); m.arc(cx, (by - u * 1.4) + ph2 * u * 0.5, u * 0.05, 0, 7); m.fill(); }
        for (let i = 0; i < 3; i++) { const ph2 = (t * 0.9 + i / 3 + 0.15) % 1; m.beginPath(); m.arc(cx + (i - 1) * u * 0.3, (by - u * 0.9) + ph2 * u * 0.6, u * 0.045, 0, 7); m.fill(); }
        m.fillStyle = 'rgba(255,240,200,0.85)'; m.beginPath(); m.arc(cx, by - u * 1.5, u * (0.1 + 0.03 * Math.sin(t * 4)), 0, 7); m.fill();   // bubbling spout
        break;
      }
      case 'cakespire': {
        const tiers = [[1.4, '#ffd9a8'], [1.1, '#ffb0c8'], [0.8, '#a8e0d0'], [0.5, '#ffd36b']];
        let yy = by;
        for (const tr of tiers) {
          const tw2 = u * tr[0], th2 = u * 0.5;
          m.fillStyle = tr[1]; rr(m, cx - tw2 / 2, yy - th2, tw2, th2, u * 0.06); m.fill();
          m.fillStyle = 'rgba(255,255,255,0.5)'; m.fillRect(cx - tw2 / 2, yy - th2, tw2, 3);   // frosting line
          yy -= th2;
        }
        m.fillStyle = '#ff5d5d'; m.beginPath(); m.arc(cx, yy - u * 0.12, u * 0.12, 0, 7); m.fill();   // cherry on top
        break;
      }
      case 'clock': {
        const cw = u * 0.8, chh = u * 2.0;
        m.fillStyle = '#6e4a2a'; rr(m, cx - cw / 2, by - chh, cw, chh, u * 0.08); m.fill();   // case
        m.fillStyle = '#3a2616'; m.beginPath(); m.moveTo(cx - cw / 2, by - chh); m.lineTo(cx, by - chh - u * 0.4); m.lineTo(cx + cw / 2, by - chh); m.closePath(); m.fill();   // pediment
        const fx = cx, fy = by - chh + cw * 0.6, fr = cw * 0.42;                                            // face
        m.fillStyle = '#f4efe6'; m.beginPath(); m.arc(fx, fy, fr, 0, 7); m.fill();
        m.strokeStyle = '#16181c'; m.lineWidth = u * 0.05; m.lineCap = 'round';                              // sweeping hands
        const minA = t * 1.2 - Math.PI / 2, hrA = t * 0.1 - Math.PI / 2;
        m.beginPath(); m.moveTo(fx, fy); m.lineTo(fx + Math.cos(minA) * fr * 0.82, fy + Math.sin(minA) * fr * 0.82);
        m.moveTo(fx, fy); m.lineTo(fx + Math.cos(hrA) * fr * 0.5, fy + Math.sin(hrA) * fr * 0.5); m.stroke();
        m.lineCap = 'butt';
        const swing = Math.sin(t * 2.2) * 0.32;                                                              // pendulum swing
        const pivy = by - chh + cw * 1.0, plen = (by - u * 0.5) - pivy;
        const pbx = cx + Math.sin(swing) * plen, pby = pivy + Math.cos(swing) * plen;
        m.strokeStyle = '#b89a4a'; m.lineWidth = u * 0.04; m.beginPath(); m.moveTo(cx, pivy); m.lineTo(pbx, pby); m.stroke();
        m.fillStyle = '#ffd24d'; m.beginPath(); m.arc(pbx, pby, cw * 0.2, 0, 7); m.fill();
        break;
      }
      case 'jackbox': {
        const bw = u * 0.9;
        m.fillStyle = '#5d9fe8'; rr(m, cx - bw / 2, by - bw, bw, bw, u * 0.06); m.fill();   // box
        m.fillStyle = '#ffd24d'; m.fillRect(cx - bw / 2, by - bw, bw, bw * 0.18);            // lid band
        const bob = 0.5 + 0.5 * Math.sin(t * 3), sway = Math.sin(t * 1.6) * u * 0.14;          // springs up & sways
        const topY = by - bw * (1.55 + bob * 0.35);
        m.strokeStyle = '#ff5d5d'; m.lineWidth = u * 0.08; m.lineCap = 'round';                // spring
        m.beginPath(); m.moveTo(cx, by - bw); m.quadraticCurveTo(cx - u * 0.3 + sway, (by - bw + topY) / 2, cx + sway, topY); m.stroke();
        m.lineCap = 'butt';
        m.fillStyle = '#fff4e6'; m.beginPath(); m.arc(cx + sway, topY - u * 0.22, u * 0.28, 0, 7); m.fill();   // head
        m.fillStyle = '#ff5d5d'; m.beginPath(); m.arc(cx + sway, topY - u * 0.44, u * 0.12, 0, 7); m.fill();   // hat pompom
        break;
      }
      case 'carousel': {
        const cw = u * 1.6;
        m.fillStyle = '#fff4e6'; rr(m, cx - cw / 2, by - u * 0.5, cw, u * 0.4, u * 0.06); m.fill();   // platform
        for (let i = 0; i < 3; i++) {                                                        // horses circle round
          const a = t * 1.3 + i * (Math.PI * 2 / 3);
          const hx = cx + Math.cos(a) * cw * 0.4, depth = Math.sin(a);
          const hy = by - u * 0.62 - (0.06 + 0.05 * Math.sin(a)) * u, sc = 0.82 + depth * 0.18;
          m.globalAlpha = 0.68 + depth * 0.32;
          m.strokeStyle = '#d0a040'; m.lineWidth = u * 0.05;
          m.beginPath(); m.moveTo(hx, by - u * 0.5); m.lineTo(hx, by - u * 1.05); m.stroke();         // pole
          m.fillStyle = ['#ff7a9c', '#7fd0c4', '#ffd24d'][i];
          m.beginPath(); m.ellipse(hx, hy, u * 0.16 * sc, u * 0.1 * sc, 0, 0, 7); m.fill();           // horse
        }
        m.globalAlpha = 1;
        m.fillStyle = '#ff5d5d';                                                              // striped cone roof
        m.beginPath(); m.moveTo(cx, by - u * 1.9); m.lineTo(cx - cw / 2, by - u * 1.0); m.lineTo(cx + cw / 2, by - u * 1.0); m.closePath(); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.6)';
        for (let i = 0; i < 3; i++) { m.beginPath(); m.moveTo(cx - cw * 0.3 + i * cw * 0.3, by - u * 1.0); m.lineTo(cx, by - u * 1.9); m.lineTo(cx - cw * 0.3 + i * cw * 0.3 + cw * 0.12, by - u * 1.0); m.closePath(); m.fill(); }
        m.fillStyle = '#ffd24d'; m.beginPath(); m.arc(cx, by - u * 1.95, u * 0.1, 0, 7); m.fill();   // finial
        break;
      }
      case 'stillhouse': {   // leaning stilt-shack on crooked poles
        m.strokeStyle = '#4a3a28'; m.lineWidth = u * 0.1;                                     // stilts
        m.beginPath(); m.moveTo(cx - u * 0.4, by); m.lineTo(cx - u * 0.32, by - u * 0.9); m.moveTo(cx + u * 0.4, by); m.lineTo(cx + u * 0.32, by - u * 0.9); m.stroke();
        m.save(); m.translate(cx, by - u * 1.2); m.rotate(0.06);                              // slightly leaning shack
        m.fillStyle = '#7d6a4a'; rr(m, -u * 0.5, 0, u * 1.0, u * 0.7, u * 0.04); m.fill();
        m.fillStyle = '#5a4632'; m.beginPath(); m.moveTo(-u * 0.58, 0); m.lineTo(0, -u * 0.5); m.lineTo(u * 0.58, 0); m.closePath(); m.fill();   // tin roof
        m.fillStyle = '#3a2e20'; rr(m, -u * 0.12, u * 0.28, u * 0.24, u * 0.42, u * 0.02); m.fill();   // door
        m.restore();
        const lsw = Math.sin(t * 1.3) * u * 0.06;                                              // hanging lantern sways
        m.strokeStyle = 'rgba(60,50,36,0.6)'; m.lineWidth = u * 0.02;
        m.beginPath(); m.moveTo(cx + u * 0.4, by - u * 1.05); m.lineTo(cx + u * 0.4 + lsw, by - u * 0.95); m.stroke();
        m.save(); m.shadowBlur = 6 + 3 * Math.sin(t * 2); m.shadowColor = '#ffd86b';
        m.fillStyle = '#ffd86b'; m.beginPath(); m.arc(cx + u * 0.4 + lsw, by - u * 0.95, u * 0.08, 0, 7); m.fill();
        m.restore();
        break;
      }
      case 'roottower': {   // gnarled mangrove with arching prop-roots
        m.fillStyle = '#5a4632'; rr(m, cx - u * 0.18, by - u * 1.7, u * 0.36, u * 1.7, u * 0.06); m.fill();   // trunk
        m.strokeStyle = '#5a4632'; m.lineWidth = u * 0.12; m.lineCap = 'round';                              // prop-roots
        for (const sgn of [-1, 1]) { m.beginPath(); m.moveTo(cx + sgn * u * 0.15, by - u * 0.9); m.quadraticCurveTo(cx + sgn * u * 0.7, by - u * 0.5, cx + sgn * u * 0.55, by); m.stroke(); }
        m.lineCap = 'butt';
        m.fillStyle = '#3f6b3a'; for (const [ox, oy] of [[0, -1.9], [-0.5, -1.6], [0.5, -1.6]]) { m.beginPath(); m.arc(cx + ox * u + Math.sin(t * 1.1 + ox * 3) * u * 0.05, by + oy * u, u * 0.55, 0, 7); m.fill(); }   // canopy sways
        m.fillStyle = '#8aa06a'; for (let i = 0; i < 4; i++) { m.strokeStyle = '#8aa06a'; m.lineWidth = u * 0.04; m.beginPath(); m.moveTo(cx - u * 0.5 + i * u * 0.3, by - u * 1.3); m.lineTo(cx - u * 0.5 + i * u * 0.3, by - u * 0.9); m.stroke(); }   // vines
        break;
      }
      case 'drownedspire': {   // half-submerged tilted chapel steeple
        m.save(); m.translate(cx, by); m.rotate(-0.12);
        m.fillStyle = '#8a8e84'; rr(m, -u * 0.34, -u * 1.4, u * 0.68, u * 1.4, u * 0.04); m.fill();   // steeple body
        m.fillStyle = '#6b6f66'; m.beginPath(); m.moveTo(-u * 0.42, -u * 1.4); m.lineTo(0, -u * 2.0); m.lineTo(u * 0.42, -u * 1.4); m.closePath(); m.fill();   // spire roof
        m.fillStyle = '#2e3a30'; m.beginPath(); m.arc(0, -u * 0.9, u * 0.16, Math.PI, 0); m.fill();   // dark belfry arch
        m.fillStyle = '#caa14a'; m.beginPath(); m.arc(0, -u * 0.86, u * 0.1, 0, 7); m.fill();          // cracked bell
        m.restore();
        m.fillStyle = 'rgba(58,74,62,0.55)'; m.beginPath(); m.ellipse(cx, by, u * 0.6, u * 0.12, 0, 0, 7); m.fill();   // waterline
        const rp = (t * 0.4) % 1;                                                             // spreading ripple
        m.strokeStyle = `rgba(150,170,140,${0.4 * (1 - rp)})`; m.lineWidth = 1.5;
        m.beginPath(); m.ellipse(cx, by, u * (0.2 + rp * 0.5), u * (0.04 + rp * 0.1), 0, 0, 7); m.stroke();
        break;
      }
      case 'gantry': {   // ore-crusher gantry: braced frame + toothed wheel
        m.strokeStyle = '#5a626c'; m.lineWidth = u * 0.1;                                     // braced steel frame
        m.beginPath(); m.moveTo(cx - u * 0.6, by); m.lineTo(cx - u * 0.5, by - u * 1.4); m.lineTo(cx + u * 0.5, by - u * 1.4); m.lineTo(cx + u * 0.6, by); m.moveTo(cx - u * 0.55, by - u * 0.7); m.lineTo(cx + u * 0.55, by - u * 0.7); m.stroke();
        m.fillStyle = '#e8a23a'; m.fillRect(cx - u * 0.6, by - u * 0.16, u * 1.2, u * 0.16);   // hazard base
        m.save(); m.translate(cx, by - u * 0.95); m.rotate(t * 1.4);                          // toothed crushing wheel turns
        m.fillStyle = '#9aa0aa'; for (let i = 0; i < 8; i++) { const a = i / 8 * 7; m.fillRect(Math.cos(a) * u * 0.4 - u * 0.08, Math.sin(a) * u * 0.4 - u * 0.08, u * 0.16, u * 0.16); }
        m.beginPath(); m.arc(0, 0, u * 0.34, 0, 7); m.fill(); m.fillStyle = '#5a606a'; m.beginPath(); m.arc(0, 0, u * 0.14, 0, 7); m.fill();
        m.restore();
        break;
      }
      case 'dockarm': {   // jointed docking-clamp arm with a 3-finger grapple
        m.fillStyle = '#444b54'; rr(m, cx - u * 0.3, by - u * 0.5, u * 0.6, u * 0.5, u * 0.05); m.fill();   // base
        const sweep = Math.sin(t * 0.7);                                                      // slow reach in / out
        const ex = cx + (0.36 + sweep * 0.16) * u, ey = by - u * 1.05;                        // elbow joint
        const tx = ex - (0.45 - sweep * 0.12) * u, ty = by - (1.55 + sweep * 0.12) * u;       // grapple wrist
        m.strokeStyle = '#7a828c'; m.lineWidth = u * 0.13; m.lineCap = 'round';               // jointed arm
        m.beginPath(); m.moveTo(cx, by - u * 0.5); m.lineTo(ex, ey); m.lineTo(tx, ty); m.stroke();
        m.lineCap = 'butt';
        const grip = u * (0.18 + (0.5 + 0.5 * Math.sin(t * 1.6)) * 0.18);                     // fingers open & close
        m.strokeStyle = '#9aa2ac'; m.lineWidth = u * 0.07;
        for (const a of [-1, 0, 1]) { m.beginPath(); m.moveTo(tx, ty); m.lineTo(tx + a * grip, ty - u * 0.32); m.stroke(); }
        m.fillStyle = `rgba(255,180,60,${0.4 + 0.5 * Math.abs(Math.sin(t * 2.2))})`;          // blinking warning light
        m.beginPath(); m.arc(ex, ey, u * 0.07, 0, 7); m.fill();
        break;
      }
      case 'refinery': {   // refinery tower: ringed stack + glowing crucible
        m.fillStyle = '#4a515a'; for (let i = 0; i < 4; i++) { rr(m, cx - u * 0.4, by - u * (0.45 + i * 0.42), u * 0.8, u * 0.4, u * 0.05); m.fill(); }   // stacked rings
        m.strokeStyle = '#7a828c'; m.lineWidth = u * 0.04; for (let i = 0; i < 4; i++) { m.strokeRect(cx - u * 0.4, by - u * (0.45 + i * 0.42), u * 0.8, u * 0.4); }
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);                                          // crucible breathes
        m.save(); m.shadowBlur = 8 + pulse * 10; m.shadowColor = '#ff7a2a';
        m.fillStyle = '#ff8a2a'; m.beginPath(); m.arc(cx, by - u * 2.0, u * (0.22 + pulse * 0.06), 0, 7); m.fill(); m.restore();
        break;
      }
      case 'paperpagoda': {   // stacked pleated paper roofs to a crane finial
        for (let i = 0; i < 3; i++) {
          const ty = by - u * (0.3 + i * 0.55), tw = u * (1.0 - i * 0.26);
          m.fillStyle = i % 2 ? '#e8806b' : '#f2d06b';
          m.beginPath(); m.moveTo(cx - tw / 2, ty); m.lineTo(cx, ty - u * 0.42); m.lineTo(cx + tw / 2, ty); m.closePath(); m.fill();
          m.strokeStyle = 'rgba(0,0,0,0.18)'; m.lineWidth = 1; m.beginPath(); m.moveTo(cx, ty - u * 0.42); m.lineTo(cx, ty); m.stroke();   // centre crease
        }
        m.strokeStyle = '#6bb0e8'; m.lineWidth = u * 0.06; m.beginPath(); m.moveTo(cx, by - u * 1.85); m.lineTo(cx + u * 0.18, by - u * 2.05); m.stroke();   // crane finial
        break;
      }
      case 'popupcastle': {   // flat pop-up-book castle with cut-out windows
        m.fillStyle = '#c88ad6'; rr(m, cx - u * 0.7, by - u * 1.2, u * 1.4, u * 1.2, u * 0.04); m.fill();   // wall
        m.fillStyle = '#9bd86b'; for (const ox of [-0.7, -0.1, 0.5]) { m.fillRect(cx + ox * u, by - u * 1.5, u * 0.2, u * 0.3); }   // crenellations
        m.fillStyle = '#4a4640';                                                              // cut-out windows + drawbridge gap
        for (const ox of [-0.4, 0.2]) { m.fillRect(cx + ox * u, by - u * 0.9, u * 0.18, u * 0.26); }
        m.fillRect(cx - u * 0.14, by - u * 0.5, u * 0.28, u * 0.5);
        m.strokeStyle = 'rgba(0,0,0,0.18)'; m.lineWidth = 1; m.beginPath(); m.moveTo(cx, by - u * 1.2); m.lineTo(cx, by); m.stroke();   // fold crease
        break;
      }
      case 'cranespire': {   // colossal folded crane balanced on its beak
        m.fillStyle = '#f4efe4';
        m.beginPath(); m.moveTo(cx, by); m.lineTo(cx - u * 0.5, by - u * 1.0); m.lineTo(cx, by - u * 0.8); m.closePath(); m.fill();   // lower fold
        m.fillStyle = '#e8e0d0';
        m.beginPath(); m.moveTo(cx, by - u * 0.8); m.lineTo(cx - u * 0.7, by - u * 1.3); m.lineTo(cx + u * 0.1, by - u * 1.5); m.closePath(); m.fill();   // body
        m.fillStyle = '#fff8ee';
        m.beginPath(); m.moveTo(cx + u * 0.1, by - u * 1.5); m.lineTo(cx + u * 0.7, by - u * 1.2); m.lineTo(cx + u * 0.2, by - u * 1.9); m.closePath(); m.fill();   // wing
        m.beginPath(); m.moveTo(cx + u * 0.1, by - u * 1.5); m.lineTo(cx + u * 0.7, by - u * 1.9); m.lineTo(cx + u * 0.2, by - u * 1.9); m.closePath(); m.fill();   // head/neck
        m.strokeStyle = 'rgba(0,0,0,0.16)'; m.lineWidth = 1; m.beginPath(); m.moveTo(cx, by - u * 0.8); m.lineTo(cx + u * 0.1, by - u * 1.5); m.stroke();
        break;
      }
    }
    m.restore();
  }

  function drawGroundTile(m, d, x, y, px, py, pw, ph, k) {
    const th = d.theme;
    m.fillStyle = (x + y) % 2 === 0 ? th.ground : th.groundAlt;
    m.fillRect(px, py, pw, ph);

    // tutorial "training yard": a bare flat slab — no buildings, no decor
    if (th.flat) return;

    const r1 = sr(k * 1.7, d.seed);
    if (r1 < th.park) {
      // open lot: decorations whose style depends on the location
      const n = sr(k * 5.9, d.seed) > 0.55 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const cx = px + pw * (0.28 + sr(k * 3.3 + i * 7, d.seed) * 0.44);
        const cy = py + ph * (0.28 + sr(k * 4.1 + i * 13, d.seed) * 0.44);
        drawDecor(m, th, cx, cy, es * 0.17, sr(k * 7.7 + i * 5, d.seed));
      }
    } else {
      // filler "block": a building tower by default, but each themed world has
      // its own block style (paper sheets, cargo crates, shacks, candy, …) so
      // maps don't all read as the same coloured squares.
      const pal = th.buildings;
      const col = pal[(sr(k * 3.1, d.seed) * pal.length) | 0];
      drawBlock(m, th, col, px, py, pw, ph, k, d);
    }
  }

  // One filler block at a tile. `th.blockStyle` selects the look; colour comes
  // from the theme palette so each map still varies tile-to-tile.
  function drawBlock(m, th, col, px, py, pw, ph, k, d) {
    const inset = 3;
    const x = px + inset, y = py + inset, w = pw - inset * 2, h = ph - inset * 2;
    m.fillStyle = 'rgba(0,0,0,0.28)'; rr(m, x + 2, y + 3, w, h, 3); m.fill();   // soft drop shadow
    switch (th.blockStyle) {
      case 'paper': {                                   // folded construction-paper sheet
        m.fillStyle = col; rr(m, x, y, w, h, 2); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.22)';                                 // turned-up corner
        m.beginPath(); m.moveTo(x + w, y); m.lineTo(x + w, y + h * 0.5); m.lineTo(x + w * 0.5, y); m.closePath(); m.fill();
        m.strokeStyle = 'rgba(0,0,0,0.18)'; m.lineWidth = 1;                    // fold crease
        m.beginPath(); m.moveTo(x + w * 0.5, y); m.lineTo(x + w, y + h * 0.5); m.stroke();
        break;
      }
      case 'crate': {                                   // metal cargo crate
        m.fillStyle = col; rr(m, x, y, w, h, 1); m.fill();
        m.strokeStyle = 'rgba(0,0,0,0.32)'; m.lineWidth = 2; m.strokeRect(x + 2, y + 2, w - 4, h - 4);   // frame
        m.strokeStyle = 'rgba(0,0,0,0.18)'; m.lineWidth = 1; m.beginPath(); m.moveTo(x + w / 2, y); m.lineTo(x + w / 2, y + h); m.stroke();   // centre seam
        m.fillStyle = 'rgba(232,162,58,0.7)';                                   // corner rivets
        for (const rv of [[0.18, 0.22], [0.82, 0.22], [0.18, 0.78], [0.82, 0.78]]) { m.beginPath(); m.arc(x + w * rv[0], y + h * rv[1], Math.max(1, w * 0.05), 0, 7); m.fill(); }
        break;
      }
      case 'shack': {                                   // weathered wooden roof (top-down)
        m.fillStyle = col; rr(m, x, y, w, h, 2); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.1)'; m.fillRect(x, y, w, h * 0.5);    // lit upper slope
        m.strokeStyle = 'rgba(0,0,0,0.28)'; m.lineWidth = 1.5; m.beginPath(); m.moveTo(x, y + h * 0.5); m.lineTo(x + w, y + h * 0.5); m.stroke();   // ridge
        m.strokeStyle = 'rgba(0,0,0,0.12)'; m.lineWidth = 1;                    // plank seams
        for (let i = 1; i < 4; i++) { m.beginPath(); m.moveTo(x + w * i / 4, y); m.lineTo(x + w * i / 4, y + h); m.stroke(); }
        break;
      }
      case 'rock': {                                    // chunky volcanic boulder
        m.fillStyle = col;
        m.beginPath();
        m.moveTo(x + w * 0.1, y + h * 0.42); m.lineTo(x + w * 0.42, y + h * 0.08); m.lineTo(x + w * 0.82, y + h * 0.16);
        m.lineTo(x + w * 0.92, y + h * 0.62); m.lineTo(x + w * 0.58, y + h * 0.92); m.lineTo(x + w * 0.16, y + h * 0.8);
        m.closePath(); m.fill();
        m.fillStyle = 'rgba(0,0,0,0.24)';                                       // shaded facet
        m.beginPath(); m.moveTo(x + w * 0.58, y + h * 0.92); m.lineTo(x + w * 0.92, y + h * 0.62); m.lineTo(x + w * 0.58, y + h * 0.5); m.closePath(); m.fill();
        if (sr(k * 4.4, d.seed) > 0.6) { m.fillStyle = 'rgba(255,120,40,0.6)'; m.fillRect(x + w * 0.32, y + h * 0.52, w * 0.3, 2); }   // ember crack
        break;
      }
      case 'candy': {                                   // glossy frosted candy block
        m.fillStyle = col; rr(m, x, y, w, h, 4); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.55)';                                 // drippy frosting top
        m.beginPath(); m.moveTo(x, y); m.lineTo(x + w, y);
        for (let i = 4; i >= 0; i--) { m.lineTo(x + w * i / 4, y + h * (i % 2 ? 0.42 : 0.24)); }
        m.closePath(); m.fill();
        m.fillStyle = 'rgba(255,80,120,0.9)';                                   // sprinkles
        for (const sp of [[0.3, 0.62], [0.6, 0.76], [0.46, 0.52]]) { m.fillRect(x + w * sp[0], y + h * sp[1], w * 0.13, 2); }
        break;
      }
      case 'gift': {                                    // wrapped toy present
        m.fillStyle = col; rr(m, x, y, w, h, 2); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.7)'; m.fillRect(x + w * 0.42, y, w * 0.16, h); m.fillRect(x, y + h * 0.42, w, h * 0.16);   // ribbon cross
        m.fillStyle = '#ffd24d'; m.beginPath(); m.arc(x + w * 0.5, y + h * 0.5, Math.max(2, w * 0.1), 0, 7); m.fill();   // bow knot
        break;
      }
      default: {                                        // generic building tower
        m.fillStyle = col; rr(m, x, y, w, h, 3); m.fill();
        m.fillStyle = 'rgba(0,0,0,0.15)'; m.fillRect(x, y + h - 4, w, 4);       // base shade
        if (sr(k * 5.3, d.seed) > 0.45) { m.fillStyle = 'rgba(0,0,0,0.22)'; m.fillRect(x + w * 0.25, y + h * 0.25, w * 0.18, h * 0.18); }   // AC unit
        if (sr(k * 6.7, d.seed) > 0.75) { m.fillStyle = 'rgba(255,255,255,0.18)'; m.fillRect(x + w * 0.58, y + h * 0.5, w * 0.14, h * 0.14); }   // lit window
      }
    }
  }

  function drawWaterTile(m, x, px, py, pw, ph, d) {
    m.fillStyle = d.theme.waterColor || '#4f9fce';
    m.fillRect(px, py, pw, ph);
    m.strokeStyle = 'rgba(255,255,255,0.35)';
    m.lineWidth = 2;
    const wy = py + ph * (0.3 + sr(x * 9.1, d.seed) * 0.4);
    m.beginPath();
    m.moveTo(px + pw * 0.15, wy);
    m.quadraticCurveTo(px + pw * 0.5, wy - 3, px + pw * 0.85, wy);
    m.stroke();
  }

  // ------------------------------------------------------------------
  // Per-district "feature band": a non-road strip (river, chasm, ridge…)
  // that gives each district its own distinct landscape element. Generalises
  // the original water-row mechanic. Drawn into the STATIC map layer (like
  // water), so these shapes don't animate — they're terrain, not effects.
  // ------------------------------------------------------------------
  function featureAt(d, x, y) {
    const f = d.feature;
    if (f) {
      if (f.rows && f.rows.indexOf(y) !== -1) return f.type;
      if (f.cols && f.cols.indexOf(x) !== -1) return f.type;
    }
    if (d.water && d.water.indexOf(y) !== -1) return 'water';
    return null;
  }

  function drawFeatureTile(m, type, x, y, px, py, pw, ph, d) {
    if (type === 'water') { drawWaterTile(m, x, px, py, pw, ph, d); return; }
    const seed = d.seed, mn = Math.min(pw, ph);
    switch (type) {
      case 'molten': {                                    // glowing lava channel
        m.fillStyle = '#1e1410'; m.fillRect(px, py, pw, ph);                       // cooled crust base
        const g = m.createLinearGradient(px, py + ph * 0.2, px, py + ph * 0.8);
        g.addColorStop(0, '#ff6a1e'); g.addColorStop(0.5, '#ffd34a'); g.addColorStop(1, '#ff6a1e');
        m.fillStyle = g; m.fillRect(px, py + ph * 0.24, pw, ph * 0.52);            // molten channel
        m.fillStyle = 'rgba(255,245,200,0.55)'; m.fillRect(px, py + ph * 0.46, pw, ph * 0.08);   // bright core stripe
        m.fillStyle = '#2a1c14';                                                   // soft crust edges (no harsh line)
        m.fillRect(px, py + ph * 0.2, pw, 3); m.fillRect(px, py + ph * 0.77, pw, 3);
        break;
      }
      case 'chasm': {                                     // black rift in the ground
        m.fillStyle = '#0c0b10'; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(70,58,82,0.6)'; m.fillRect(px, py, pw, 3);            // lit upper rim
        m.fillStyle = 'rgba(120,80,160,0.16)'; m.fillRect(px, py + ph - 4, pw, 4); // faint depth glow
        break;
      }
      case 'ash': {                                       // cracked smoldering flats
        m.fillStyle = '#4a423e'; m.fillRect(px, py, pw, ph);
        m.strokeStyle = 'rgba(255,110,40,0.5)'; m.lineWidth = 1.5;     // ember cracks
        m.beginPath();
        m.moveTo(px + pw * sr(x * 2.3, seed), py);
        m.lineTo(px + pw * sr(x * 4.9, seed), py + ph); m.stroke();
        m.fillStyle = 'rgba(0,0,0,0.25)';
        m.beginPath(); m.arc(px + pw * 0.5, py + ph * 0.5, mn * 0.18, 0, 7); m.fill();
        break;
      }
      case 'choco': {                                     // chocolate river
        m.fillStyle = '#5a3320'; m.fillRect(px, py, pw, ph);
        m.fillStyle = '#7a4628'; m.fillRect(px, py + ph * 0.25, pw, ph * 0.5);
        m.strokeStyle = 'rgba(255,225,200,0.4)'; m.lineWidth = 2;      // glossy ripple
        const wy = py + ph * (0.35 + sr(x * 9.1, seed) * 0.3);
        m.beginPath(); m.moveTo(px, wy); m.quadraticCurveTo(px + pw * 0.5, wy - 3, px + pw, wy); m.stroke();
        break;
      }
      case 'syrup': {                                     // sticky amber syrup pool
        m.fillStyle = '#c77a1e'; m.fillRect(px, py, pw, ph);
        m.fillStyle = '#e0982e'; m.fillRect(px, py + ph * 0.2, pw, ph * 0.6);
        m.fillStyle = 'rgba(255,240,200,0.5)';                         // shine
        m.beginPath(); m.ellipse(px + pw * (0.3 + sr(x * 4.4, seed) * 0.4), py + ph * 0.4, pw * 0.16, ph * 0.1, 0, 0, 7); m.fill();
        break;
      }
      case 'wafer': {                                     // raised wafer / biscuit ridge
        m.fillStyle = '#caa46a'; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(255,240,210,0.5)'; m.fillRect(px, py, pw, 3);          // top highlight
        m.fillStyle = 'rgba(90,60,30,0.35)'; m.fillRect(px, py + ph - 4, pw, 4);   // base shadow
        m.strokeStyle = 'rgba(150,110,60,0.5)'; m.lineWidth = 1;
        for (let i = 1; i < 3; i++) { m.beginPath(); m.moveTo(px + pw * i / 3, py); m.lineTo(px + pw * i / 3, py + ph); m.stroke(); }
        break;
      }
      case 'turntable': {                                 // music-box gear recess (the gear spins live)
        m.fillStyle = '#b6bcc4'; m.fillRect(px, py, pw, ph);
        m.fillStyle = '#828a94'; m.beginPath(); m.arc(px + pw * 0.5, py + ph * 0.5, mn * 0.47, 0, 7); m.fill();   // socket
        break;
      }
      case 'marble': {                                    // marble-run channel (marbles roll live)
        m.fillStyle = '#9aa0a8'; m.fillRect(px, py, pw, ph);
        m.fillStyle = '#7a808a'; m.fillRect(px, py + ph * 0.3, pw, ph * 0.4);     // recessed trough
        m.fillStyle = 'rgba(0,0,0,0.18)'; m.fillRect(px, py + ph * 0.3, pw, 2); m.fillRect(px, py + ph * 0.7 - 2, pw, 2);   // trough lips
        break;
      }
      case 'domino': {                                    // a row of standing dominoes
        m.fillStyle = (x + y) % 2 === 0 ? d.theme.ground : d.theme.groundAlt; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(0,0,0,0.2)'; m.fillRect(px + pw * 0.22, py + ph * 0.58, pw * 0.56, ph * 0.22);  // shadow
        m.fillStyle = '#f4efe6'; rr(m, px + pw * 0.3, py + ph * 0.15, pw * 0.4, ph * 0.5, 2); m.fill();      // domino tile
        m.fillStyle = '#16181c';
        m.beginPath(); m.arc(px + pw * 0.5, py + ph * 0.28, ph * 0.045, 0, 7); m.fill();
        m.beginPath(); m.arc(px + pw * 0.5, py + ph * 0.5, ph * 0.045, 0, 7); m.fill();
        break;
      }
      case 'bog': {                                       // still black bayou water
        m.fillStyle = '#3a4a3e'; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(140,160,120,0.18)';                                  // mirror reflection streak
        m.fillRect(px, py + ph * (0.3 + sr(x * 9.1, seed) * 0.3), pw, 2);
        if (sr(x * 4.2, seed) > 0.6) {                                           // floating lily pad
          m.fillStyle = '#5a7a4a'; m.beginPath(); m.arc(px + pw * 0.5, py + ph * 0.55, mn * 0.16, 0.4, 7); m.fill();
        }
        break;
      }
      case 'mud': {                                       // root-maze mudflat
        m.fillStyle = '#5a4a32'; m.fillRect(px, py, pw, ph);
        m.strokeStyle = 'rgba(180,160,110,0.5)'; m.lineWidth = 1.5; m.lineCap = 'round';   // arching roots
        for (let i = 0; i < 2; i++) {
          const oy = py + ph * (0.3 + i * 0.4);
          m.beginPath(); m.moveTo(px, oy); m.quadraticCurveTo(px + pw * 0.5, oy - ph * 0.18, px + pw, oy + (sr(x * 3.3 + i, seed) - 0.5) * ph * 0.3); m.stroke();
        }
        m.lineCap = 'butt';
        break;
      }
      case 'peat': {                                      // quaking grey peat-bog
        m.fillStyle = '#5a5852'; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(40,42,38,0.5)';                                      // surface scum mottling
        m.beginPath(); m.ellipse(px + pw * (0.3 + sr(x * 5.1, seed) * 0.4), py + ph * 0.5, pw * 0.22, ph * 0.16, 0, 0, 7); m.fill();
        m.strokeStyle = 'rgba(120,118,110,0.4)'; m.lineWidth = 1.5;              // heaving wobble line
        m.beginPath(); m.moveTo(px, py + ph * 0.4); m.quadraticCurveTo(px + pw * 0.5, py + ph * 0.55, px + pw, py + ph * 0.42); m.stroke();
        break;
      }
      case 'conveyor': {                                  // recessed ore conveyor trough
        m.fillStyle = '#23262c'; m.fillRect(px, py, pw, ph);                     // (belt, chevrons + ore animate live)
        m.fillStyle = '#33373e'; m.fillRect(px, py + ph * 0.22, pw, ph * 0.56);  // belt
        m.fillStyle = '#2a2d33'; m.fillRect(px, py + ph * 0.22, pw, 2);          // top lip shadow
        m.fillRect(px, py + ph * 0.78 - 2, pw, 2);                               // bottom lip shadow
        break;
      }
      case 'void': {                                      // open vacuum gap to the stars
        m.fillStyle = '#0a0c14'; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(255,255,255,0.85)';                                  // stars through the gap
        for (let i = 0; i < 3; i++) { m.globalAlpha = 0.4 + sr(x * 7 + i * 3, seed) * 0.5; m.beginPath(); m.arc(px + pw * sr(x * 2.1 + i, seed), py + ph * sr(x * 4.3 + i * 5, seed), 1.1, 0, 7); m.fill(); }
        m.globalAlpha = 1;
        m.fillStyle = '#e8a23a'; m.fillRect(px, py, pw, 3); m.fillRect(px, py + ph - 3, pw, 3);   // yellow safety rails
        break;
      }
      case 'foldtrench': {                                // V-fold paper crease (sunken)
        m.fillStyle = d.theme.ground; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(0,0,0,0.28)'; m.beginPath(); m.moveTo(px, py); m.lineTo(px + pw * 0.5, py + ph); m.lineTo(px + pw * 0.5, py); m.closePath(); m.fill();   // shaded left facet
        m.fillStyle = 'rgba(255,250,235,0.25)'; m.beginPath(); m.moveTo(px + pw, py); m.lineTo(px + pw * 0.5, py + ph); m.lineTo(px + pw * 0.5, py); m.closePath(); m.fill();   // lit right facet
        m.strokeStyle = 'rgba(0,0,0,0.4)'; m.lineWidth = 1.5; m.beginPath(); m.moveTo(px + pw * 0.5, py); m.lineTo(px + pw * 0.5, py + ph); m.stroke();   // crease line
        break;
      }
      case 'foldridge': {                                 // standing paper panels (raised)
        m.fillStyle = d.theme.ground; m.fillRect(px, py, pw, ph);
        m.fillStyle = 'rgba(0,0,0,0.22)'; m.fillRect(px, py + ph * 0.62, pw, ph * 0.34);   // cast drop-shadow (outward/down)
        m.fillStyle = '#f0e4cc'; m.fillRect(px + pw * 0.12, py + ph * 0.12, pw * 0.76, ph * 0.52);   // upright panel face
        m.fillStyle = 'rgba(255,255,255,0.4)'; m.fillRect(px + pw * 0.12, py + ph * 0.12, pw * 0.76, 3);   // top highlight
        break;
      }
      case 'paperwater': {                                // flat paper lagoon (boat bobs live)
        m.fillStyle = '#8ec8e8'; m.fillRect(px, py, pw, ph);
        m.strokeStyle = 'rgba(255,255,255,0.6)'; m.lineWidth = 1.5;              // printed fold-line waves
        for (let i = 0; i < 2; i++) { const wy = py + ph * (0.32 + i * 0.34); m.beginPath(); m.moveTo(px, wy); m.lineTo(px + pw * 0.5, wy - 2); m.lineTo(px + pw, wy); m.stroke(); }
        break;
      }
      default: { m.fillStyle = '#888'; m.fillRect(px, py, pw, ph); }
    }
  }

  // ------------------------------------------------------------------
  // Live terrain motion. The static base of each feature tile lives in the
  // map layer; this pass paints only the moving parts on top, every frame —
  // scrolling conveyors, flowing lava, spinning turntables, rising bubbles.
  // ------------------------------------------------------------------
  const FEATURE_ANIM = {
    water: 1, molten: 1, choco: 1, syrup: 1, turntable: 1,
    void: 1, bog: 1, peat: 1, paperwater: 1,
  };
  // these flow as a continuous track across the whole row (handled separately)
  const TRACK_ANIM = { marble: 1, conveyor: 1 };

  function drawFeatureAnims(d, t) {
    const g = PP.Game.grid;
    if (!g) return;
    if (!d.feature && !(d.water && d.water.length)) return;
    // row-spanning tracks first: each item crosses the full width and slips under
    // the road crossings, so there are no per-tile wrap seams.
    const f = d.feature;
    if (f && TRACK_ANIM[f.type] && f.rows) {
      for (const row of f.rows) drawTrackRow(d, g, f.type, row, t);
    }
    for (let y = 0; y < g.h; y++) {
      const py = Math.round(y * tsy), ph = Math.round((y + 1) * tsy) - py;
      for (let x = 0; x < g.w; x++) {
        const k = y * g.w + x;
        if (g.road[k]) continue;
        const type = featureAt(d, x, y);
        if (!type || !FEATURE_ANIM[type]) continue;
        const px = Math.round(x * tsx), pw = Math.round((x + 1) * tsx) - px;
        drawFeatureAnim(type, x, y, px, py, pw, ph, d, t);
      }
    }
  }

  // A marble run / ore conveyor as a continuous belt across the whole row. Items
  // are spaced evenly and travel the full screen width; the draw is clipped to the
  // row's non-road feature tiles, so each item slides out of sight under a road and
  // re-emerges past it. Wraps happen off-screen, so nothing is ever seen to jump.
  function drawTrackRow(d, g, type, row, t) {
    const c = ctx;
    const py = Math.round(row * tsy), ph = Math.round((row + 1) * tsy) - py;
    c.save();
    c.beginPath();
    let any = false;
    for (let x = 0; x < g.w; x++) {
      if (g.road[row * g.w + x]) continue;
      if (!featureAt(d, x, row)) continue;
      const px = Math.round(x * tsx), pw = Math.round((x + 1) * tsx) - px;
      c.rect(px, py, pw, ph); any = true;
    }
    if (!any) { c.restore(); return; }
    c.clip();
    const margin = tsx, span = W + margin * 2;
    const spacing = tsx, count = Math.ceil(span / spacing) + 1;
    if (type === 'conveyor') {
      const speed = tsx * 0.9;
      const gap = tsx / 3, goff = (t * speed) % gap;        // travel chevrons across the whole belt
      c.strokeStyle = 'rgba(232,162,58,0.85)'; c.lineWidth = 2;
      for (let cxp = -gap + goff; cxp < W + gap; cxp += gap) {
        c.beginPath();
        c.moveTo(cxp - tsx * 0.1, py + ph * 0.36); c.lineTo(cxp, py + ph * 0.5); c.lineTo(cxp - tsx * 0.1, py + ph * 0.64); c.stroke();
      }
      const base = (t * speed) % span;                      // ore chunks ride the belt, each individual
      for (let k = 0; k < count; k++) {
        const ox = (base + k * spacing) % span - margin;
        c.fillStyle = '#6e6a62'; c.beginPath(); c.arc(ox, py + ph * 0.5, es * 0.13, 0, 7); c.fill();
        c.fillStyle = '#88837a'; c.beginPath(); c.arc(ox - es * 0.04, py + ph * 0.46, es * 0.05, 0, 7); c.fill();
      }
    } else {                                                // marble run
      const cols = ['#ff5d5d', '#5d9fe8', '#ffd24d', '#7fd08a'];
      const speed = tsx * 1.2, base = (t * speed) % span;
      for (let k = 0; k < count; k++) {
        const mx = (base + k * spacing) % span - margin;
        c.fillStyle = cols[(sr(k * 1.7, d.seed) * cols.length) | 0];   // a fixed colour per marble
        c.beginPath(); c.arc(mx, py + ph * 0.5, ph * 0.15, 0, 7); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.55)'; c.beginPath(); c.arc(mx - ph * 0.045, py + ph * 0.44, ph * 0.05, 0, 7); c.fill();
      }
    }
    c.restore();
  }

  function drawFeatureAnim(type, x, y, px, py, pw, ph, d, t) {
    const seed = d.seed, mn = Math.min(pw, ph), c = ctx;
    switch (type) {
      case 'turntable': {                                 // meshing gears: neighbours spin opposite ways and interlock
        const cx = px + pw * 0.5, cy = py + ph * 0.5;
        const Rb = pw * 0.42, Rt = pw * 0.46, s = mn * 0.2;          // teeth reach the tile edge so they mesh
        const dir = (x % 2 === 0) ? 1 : -1;
        const ang = dir * t * 0.9 + (x % 2) * (Math.PI / 8);         // half-tooth offset keeps odd gears' teeth in the gaps
        c.save(); c.translate(cx, cy); c.rotate(ang);
        c.fillStyle = '#cfd6de';
        for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; c.fillRect(Math.cos(a) * Rt - s / 2, Math.sin(a) * Rt - s / 2, s, s); }   // square teeth
        c.beginPath(); c.arc(0, 0, Rb, 0, 7); c.fill();                                 // solid body ties the teeth together
        c.fillStyle = '#9aa2ac'; c.beginPath(); c.arc(0, 0, Rb * 0.5, 0, 7); c.fill();  // hub ring
        c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1.5;                     // spoke so the spin reads
        c.beginPath(); c.moveTo(0, 0); c.lineTo(Rb * 0.8, 0); c.stroke();
        c.restore();
        c.fillStyle = '#ffd24d'; c.beginPath(); c.arc(cx, cy, Rb * 0.32, 0, 7); c.fill();   // brass pin
        break;
      }
      case 'molten': {                                    // a bright slug drifts downstream
        c.save();
        c.beginPath(); c.rect(px, py + ph * 0.24, pw, ph * 0.52); c.clip();
        const flow = (t * pw * 0.4 + sr(x * 3.1, seed) * pw) % (pw * 1.4) - pw * 0.2;
        const glow = 0.22 + 0.16 * Math.sin(t * 3 + x * 0.7);
        c.fillStyle = `rgba(255,240,180,${glow})`;
        c.beginPath(); c.ellipse(px + flow, py + ph * 0.5, pw * 0.32, ph * 0.13, 0, 0, 7); c.fill();
        c.restore();
        break;
      }
      case 'choco': {                                     // glossy ripple slides along
        c.save();
        c.beginPath(); c.rect(px, py + ph * 0.25, pw, ph * 0.5); c.clip();
        const off = (t * pw * 0.3) % pw;
        c.strokeStyle = 'rgba(255,235,210,0.5)'; c.lineWidth = 2;
        for (let ox = px - pw + off; ox < px + pw; ox += pw) {
          c.beginPath(); c.moveTo(ox, py + ph * 0.5); c.quadraticCurveTo(ox + pw * 0.5, py + ph * 0.5 - 4, ox + pw, py + ph * 0.5); c.stroke();
        }
        c.restore();
        break;
      }
      case 'syrup': {                                     // a slow bubble swells and pops
        const ph2 = (t * 0.5 + sr(x * 2.7, seed)) % 1;
        if (ph2 < 0.8) {
          const r = mn * 0.1 * (0.4 + ph2);
          c.fillStyle = `rgba(255,240,200,${0.5 * (1 - ph2)})`;
          c.beginPath(); c.arc(px + pw * (0.3 + sr(x * 4.4, seed) * 0.4), py + ph * 0.45, r, 0, 7); c.fill();
        }
        break;
      }
      case 'bog':
      case 'peat': {                                      // methane bubble rises and pops
        const ph2 = (t * 0.4 + sr(x * 5.3, seed)) % 1;
        if (ph2 < 0.85) {
          const bx = px + pw * (0.3 + sr(x * 3.9, seed) * 0.4);
          const by = py + ph * (0.7 - ph2 * 0.4);
          const r = mn * 0.08 * (1 - ph2 * 0.5);
          c.fillStyle = `rgba(190,210,170,${0.45 * (1 - ph2)})`;
          c.beginPath(); c.arc(bx, by, r, 0, 7); c.fill();
        }
        break;
      }
      case 'void': {                                      // stars twinkle through the gap
        c.fillStyle = '#fff';
        for (let i = 0; i < 2; i++) {
          c.globalAlpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 2.5 + x * 1.3 + i * 2.1));
          c.beginPath(); c.arc(px + pw * sr(x * 2.1 + i * 4, seed), py + ph * sr(x * 5.7 + i * 3, seed), 1.2, 0, 7); c.fill();
        }
        c.globalAlpha = 1;
        break;
      }
      case 'paperwater': {                                // folded boat bobs on the creases
        if (sr(x * 5.5, seed) > 0.62) {
          const cy = py + ph * 0.5 + Math.sin(t * 1.6 + x) * ph * 0.05;
          c.fillStyle = '#fff4e6';
          c.beginPath(); c.moveTo(px + pw * 0.34, cy + ph * 0.04); c.lineTo(px + pw * 0.66, cy + ph * 0.04); c.lineTo(px + pw * 0.5, cy - ph * 0.16); c.closePath(); c.fill();
          c.strokeStyle = 'rgba(0,0,0,0.12)'; c.lineWidth = 1; c.beginPath(); c.moveTo(px + pw * 0.5, cy + ph * 0.04); c.lineTo(px + pw * 0.5, cy - ph * 0.16); c.stroke();
        }
        break;
      }
      case 'water': {                                     // a soft glint slides across
        const wy = py + ph * (0.3 + sr(x * 9.1, seed) * 0.4);
        const sweep = (t * pw * 0.5) % (pw * 2) - pw * 0.5;
        c.save();
        c.beginPath(); c.rect(px, py, pw, ph); c.clip();
        c.fillStyle = 'rgba(255,255,255,0.16)';
        c.beginPath(); c.ellipse(px + sweep, wy, pw * 0.22, 2, 0, 0, 7); c.fill();
        c.restore();
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Per-location decorations. `r` is a deterministic 0..1 roll for
  // variety; decorA/decorB are the theme's two decoration colours.
  // ------------------------------------------------------------------
  function drawDecor(m, th, cx, cy, s, r) {
    m.fillStyle = 'rgba(0,0,0,0.16)';   // soft ground shadow under everything
    m.beginPath(); m.ellipse(cx + 1.5, cy + s * 0.9, s * 1.1, s * 0.5, 0, 0, 7); m.fill();

    switch (th.decor) {
      case 'cactus': {
        const w = s * 0.55;
        m.fillStyle = th.decorA;
        rr(m, cx - w / 2, cy - s, w, s * 1.9, w / 2); m.fill();              // trunk
        rr(m, cx - w * 1.4, cy - s * 0.2, w * 0.9, w * 0.8, w / 3); m.fill(); // left arm (horizontal)
        rr(m, cx - w * 1.4, cy - s * 0.9, w * 0.7, s * 0.8, w / 3); m.fill(); // left arm (up)
        rr(m, cx + w * 0.5, cy - s * 0.5, w * 0.9, w * 0.8, w / 3); m.fill(); // right arm (horizontal)
        rr(m, cx + w * 1.2, cy - s * 1.0, w * 0.7, s * 0.6, w / 3); m.fill(); // right arm (up)
        if (r > 0.7) { m.fillStyle = '#ff5d8a'; m.beginPath(); m.arc(cx, cy - s, w * 0.5, 0, 7); m.fill(); }
        break;
      }
      case 'blossom': {
        m.fillStyle = th.decorA;                                       // trunk
        m.fillRect(cx - s * 0.12, cy - s * 0.2, s * 0.24, s * 1.1);
        m.fillStyle = th.decorB;                                       // pink canopy
        for (const [ox, oy, rr2] of [[0, -0.7, 1.0], [-0.55, -0.45, 0.7], [0.55, -0.45, 0.7], [0, -1.15, 0.65]]) {
          m.beginPath(); m.arc(cx + ox * s, cy + oy * s, s * rr2, 0, 7); m.fill();
        }
        m.fillStyle = 'rgba(255,255,255,0.45)';
        m.beginPath(); m.arc(cx - s * 0.3, cy - s * 0.85, s * 0.3, 0, 7); m.fill();
        break;
      }
      case 'pine': {
        const trunk = s * 0.22;
        m.fillStyle = '#5a4632';
        m.fillRect(cx - trunk / 2, cy + s * 0.2, trunk, s * 0.6);
        m.fillStyle = th.decorA;                                       // stacked triangles
        for (let i = 0; i < 3; i++) {
          const ty = cy - s + i * s * 0.55, tw = s * (0.7 + i * 0.35);
          m.beginPath();
          m.moveTo(cx, ty - s * 0.5);
          m.lineTo(cx - tw, ty + s * 0.45);
          m.lineTo(cx + tw, ty + s * 0.45);
          m.closePath(); m.fill();
        }
        m.fillStyle = 'rgba(255,255,255,0.8)';                         // snow caps
        m.beginPath(); m.moveTo(cx, cy - s * 1.5); m.lineTo(cx - s * 0.32, cy - s * 1.1);
        m.lineTo(cx + s * 0.32, cy - s * 1.1); m.closePath(); m.fill();
        break;
      }
      case 'hedge': {
        if (r > 0.78) {                                                // occasional lamp post
          m.fillStyle = '#2a2d33';
          m.fillRect(cx - s * 0.1, cy - s * 1.6, s * 0.2, s * 2.0);
          m.fillStyle = '#ffd86b';
          m.beginPath(); m.arc(cx, cy - s * 1.7, s * 0.4, 0, 7); m.fill();
        } else {                                                       // clipped hedge
          m.fillStyle = th.decorA;
          rr(m, cx - s, cy - s * 0.6, s * 2, s * 1.4, s * 0.4); m.fill();
          m.fillStyle = th.decorB;
          rr(m, cx - s, cy - s * 0.6, s * 2, s * 0.5, s * 0.3); m.fill();
        }
        break;
      }
      case 'coral': {                                                  // branching coral / anemone
        m.lineCap = 'round';
        m.strokeStyle = th.decorA; m.lineWidth = s * 0.4;
        for (let i = -1; i <= 1; i++) {
          m.beginPath();
          m.moveTo(cx + i * s * 0.35, cy + s * 0.6);
          m.quadraticCurveTo(cx + i * s * 0.7, cy - s * 0.3, cx + i * s * 0.5, cy - s * 0.9);
          m.stroke();
        }
        m.fillStyle = th.decorB;
        for (let i = -1; i <= 1; i++) { m.beginPath(); m.arc(cx + i * s * 0.5, cy - s * 0.9, s * 0.3, 0, 7); m.fill(); }
        m.lineCap = 'butt';
        break;
      }
      case 'rock': {                                                   // moon rocks / flag
        if (r > 0.82) {                                                // colony flag
          m.strokeStyle = '#d0d4da'; m.lineWidth = Math.max(1.5, s * 0.16);
          m.beginPath(); m.moveTo(cx, cy + s * 0.6); m.lineTo(cx, cy - s * 1.3); m.stroke();
          m.fillStyle = '#5fd0ff';
          m.beginPath(); m.moveTo(cx, cy - s * 1.3); m.lineTo(cx + s * 0.9, cy - s * 1.05);
          m.lineTo(cx, cy - s * 0.8); m.closePath(); m.fill();
        } else {
          m.fillStyle = th.decorA;
          m.beginPath(); m.ellipse(cx, cy, s, s * 0.8, 0, 0, 7); m.fill();
          m.fillStyle = th.decorB;
          m.beginPath(); m.ellipse(cx - s * 0.25, cy - s * 0.2, s * 0.45, s * 0.35, 0, 0, 7); m.fill();
          m.fillStyle = 'rgba(0,0,0,0.25)';                            // tiny craters
          m.beginPath(); m.arc(cx + s * 0.3, cy + s * 0.1, s * 0.16, 0, 7); m.fill();
        }
        break;
      }
      case 'pylon': {                                                  // glowing neon pylon
        m.fillStyle = 'rgba(0,0,0,0.3)';
        m.fillRect(cx - s * 0.2, cy - s * 1.4, s * 0.4, s * 2.0);
        m.save();
        m.shadowBlur = 8; m.shadowColor = th.decorA;
        m.fillStyle = th.decorA;
        m.fillRect(cx - s * 0.12, cy - s * 1.4, s * 0.24, s * 2.0);
        m.fillStyle = th.decorB;                                       // light segments
        for (let i = 0; i < 3; i++) { m.fillRect(cx - s * 0.22, cy - s * 1.2 + i * s * 0.6, s * 0.44, s * 0.16); }
        m.restore();
        break;
      }
      case 'cloud': {                                                  // puffy cloud, sometimes a bird
        m.fillStyle = th.decorB;                                       // soft underside
        m.beginPath(); m.ellipse(cx, cy + s * 0.45, s * 1.5, s * 0.5, 0, 0, 7); m.fill();
        m.fillStyle = th.decorA;                                       // white puffs
        for (const [ox, oy, rad] of [[0, 0, 1.0], [-0.75, 0.2, 0.65], [0.75, 0.2, 0.65], [0.3, -0.5, 0.6]]) {
          m.beginPath(); m.arc(cx + ox * s, cy + oy * s, s * rad, 0, 7); m.fill();
        }
        if (r > 0.7) {                                                 // a distant bird in flight
          m.strokeStyle = 'rgba(70,90,120,0.7)'; m.lineWidth = Math.max(1, s * 0.12); m.lineCap = 'round';
          m.beginPath();
          m.moveTo(cx - s * 0.55, cy - s * 1.0);
          m.quadraticCurveTo(cx - s * 0.2, cy - s * 1.35, cx, cy - s * 1.0);
          m.quadraticCurveTo(cx + s * 0.2, cy - s * 1.35, cx + s * 0.55, cy - s * 1.0);
          m.stroke(); m.lineCap = 'butt';
        }
        break;
      }
      case 'basaltspire': {                                            // jagged volcanic rock
        m.fillStyle = th.decorA;
        m.beginPath();
        m.moveTo(cx - s * 0.7, cy + s * 0.6); m.lineTo(cx - s * 0.2, cy - s * 1.1); m.lineTo(cx + s * 0.15, cy - s * 0.3); m.lineTo(cx + s * 0.5, cy - s * 1.3); m.lineTo(cx + s * 0.7, cy + s * 0.6);
        m.closePath(); m.fill();
        if (r > 0.5) {                                                 // ember glint in a crack
          m.save(); m.shadowBlur = 6; m.shadowColor = th.decorB; m.fillStyle = th.decorB;
          m.beginPath(); m.arc(cx + s * 0.45, cy - s * 1.05, s * 0.12, 0, 7); m.fill(); m.restore();
        }
        break;
      }
      case 'lollipop': {                                               // swirl lollipop / candy cane
        if (r > 0.6) {                                                 // candy cane
          m.strokeStyle = '#ffffff'; m.lineWidth = s * 0.42; m.lineCap = 'round';
          m.beginPath(); m.moveTo(cx, cy + s * 0.8); m.lineTo(cx, cy - s * 0.6); m.quadraticCurveTo(cx, cy - s * 1.2, cx + s * 0.5, cy - s * 1.0); m.stroke();
          m.strokeStyle = '#ff5d5d'; m.lineWidth = s * 0.16; m.setLineDash([s * 0.3, s * 0.3]);
          m.beginPath(); m.moveTo(cx, cy + s * 0.8); m.lineTo(cx, cy - s * 0.6); m.quadraticCurveTo(cx, cy - s * 1.2, cx + s * 0.5, cy - s * 1.0); m.stroke();
          m.setLineDash([]); m.lineCap = 'butt';
        } else {                                                       // round lollipop
          m.strokeStyle = '#e8e0d4'; m.lineWidth = s * 0.16;           // stick
          m.beginPath(); m.moveTo(cx, cy + s * 0.9); m.lineTo(cx, cy - s * 0.3); m.stroke();
          m.fillStyle = th.decorB; m.beginPath(); m.arc(cx, cy - s * 0.7, s * 0.6, 0, 7); m.fill();   // candy
          m.strokeStyle = th.decorA; m.lineWidth = s * 0.12; m.beginPath(); m.arc(cx, cy - s * 0.7, s * 0.32, 0, 5); m.stroke();   // swirl
        }
        break;
      }
      case 'toyblock': {                                               // stacked alphabet blocks
        const bs = s * 0.9;
        m.fillStyle = th.decorA; rr(m, cx - bs, cy - bs * 0.2, bs, bs, 2); m.fill();
        m.fillStyle = th.decorB; rr(m, cx, cy - bs * 0.2, bs, bs, 2); m.fill();
        m.fillStyle = '#ffd24d'; rr(m, cx - bs * 0.5, cy - bs * 1.2, bs, bs, 2); m.fill();
        m.fillStyle = 'rgba(255,255,255,0.92)';
        m.font = `800 ${bs * 0.66}px 'Barlow Semi Condensed', sans-serif`; m.textAlign = 'center'; m.textBaseline = 'middle';
        m.fillText('A', cx - bs * 0.5, cy + bs * 0.3); m.fillText('B', cx + bs * 0.5, cy + bs * 0.3); m.fillText('C', cx, cy - bs * 0.7);
        break;
      }
      case 'cypressknee': {                                            // mossy cypress-knee cluster
        m.fillStyle = th.decorA;                                        // knobby root stumps
        for (const [ox, hh] of [[-0.5, 1.0], [0.0, 1.5], [0.5, 1.1]]) {
          m.beginPath();
          m.moveTo(cx + ox * s - s * 0.22, cy + s * 0.6);
          m.lineTo(cx + ox * s, cy - s * hh);
          m.lineTo(cx + ox * s + s * 0.22, cy + s * 0.6);
          m.closePath(); m.fill();
        }
        m.fillStyle = th.decorB;                                        // spanish moss drape
        for (const ox of [-0.5, 0, 0.5]) { m.beginPath(); m.ellipse(cx + ox * s, cy - s * 0.4, s * 0.28, s * 0.5, 0, 0, 7); m.fill(); }
        break;
      }
      case 'oreknob': {                                                // grey ore boulder with amber crystal
        m.fillStyle = th.decorA;
        m.beginPath(); m.ellipse(cx, cy, s, s * 0.8, 0, 0, 7); m.fill();
        m.fillStyle = 'rgba(0,0,0,0.22)'; m.beginPath(); m.ellipse(cx + s * 0.3, cy + s * 0.1, s * 0.35, s * 0.28, 0, 0, 7); m.fill();
        m.save(); m.shadowBlur = 5; m.shadowColor = th.decorB; m.fillStyle = th.decorB;   // amber crystal facets
        for (const [ox, oy] of [[-0.3, -0.4], [0.15, -0.55], [-0.05, -0.2]]) {
          m.beginPath(); m.moveTo(cx + ox * s, cy + oy * s - s * 0.3); m.lineTo(cx + ox * s - s * 0.16, cy + oy * s); m.lineTo(cx + ox * s + s * 0.16, cy + oy * s); m.closePath(); m.fill();
        }
        m.restore();
        break;
      }
      case 'papertree': {                                              // folded paper fan on a rolled trunk
        m.fillStyle = '#b58a5a'; m.fillRect(cx - s * 0.12, cy - s * 0.2, s * 0.24, s * 1.0);   // rolled trunk
        const segs = 6, R = s * 1.25, ax = cx, ay = cy - s * 0.2;
        const ang = (i) => -Math.PI * 0.92 + i / segs * Math.PI * 0.84;
        // one solid fan first (no gaps between pleats), then alternate shading on top
        m.fillStyle = th.decorA;
        m.beginPath(); m.moveTo(ax, ay);
        for (let i = 0; i <= segs; i++) m.lineTo(ax + Math.cos(ang(i)) * R, ay + Math.sin(ang(i)) * R);
        m.closePath(); m.fill();
        m.fillStyle = th.decorB;                                       // every-other pleat (shares edges, no gaps)
        for (let i = 0; i < segs; i += 2) {
          m.beginPath(); m.moveTo(ax, ay);
          m.lineTo(ax + Math.cos(ang(i)) * R, ay + Math.sin(ang(i)) * R);
          m.lineTo(ax + Math.cos(ang(i + 1)) * R, ay + Math.sin(ang(i + 1)) * R);
          m.closePath(); m.fill();
        }
        m.strokeStyle = 'rgba(0,0,0,0.12)'; m.lineWidth = 1;           // fold lines
        for (let i = 0; i <= segs; i++) { m.beginPath(); m.moveTo(ax, ay); m.lineTo(ax + Math.cos(ang(i)) * R, ay + Math.sin(ang(i)) * R); m.stroke(); }
        break;
      }
      default: {                                                       // 'tree'
        m.fillStyle = th.decorA;
        m.beginPath(); m.arc(cx, cy, s, 0, 7); m.fill();
        m.fillStyle = th.decorB;
        m.beginPath(); m.arc(cx - s * 0.25, cy - s * 0.25, s * 0.55, 0, 7); m.fill();
      }
    }
  }

  function drawDepotTile(m, px, py, pw, ph) {
    m.fillStyle = 'rgba(0,0,0,0.28)';
    rr(m, px + 3, py + 4, pw - 4, ph - 4, 3); m.fill();
    m.fillStyle = '#2e3440';
    rr(m, px + 1, py + 1, pw - 2, ph - 2, 3); m.fill();
    // hazard lintel
    const stripeW = Math.max(4, pw / 6);
    for (let i = 0; i < 6; i++) {
      m.fillStyle = i % 2 === 0 ? '#ffc62e' : '#16181c';
      m.fillRect(px + 2 + i * stripeW, py + 2, stripeW, 5);
    }
    m.fillStyle = '#ffc62e';
    m.font = `800 ${Math.max(7, es * 0.2)}px 'Barlow Semi Condensed', sans-serif`;
    m.textAlign = 'center';
    m.textBaseline = 'middle';
    m.fillText('DEPOT', px + pw / 2, py + ph * 0.6);
  }

  function drawRoadTile(m, d, g, x, y, px, py, pw, ph) {
    const th = d.theme;
    m.fillStyle = th.road;
    m.fillRect(px, py, pw, ph);

    const onH = d.roadRows.includes(y);
    const onV = d.roadCols.includes(x);
    const roadAt = (xx, yy) => xx >= 0 && yy >= 0 && xx < g.w && yy < g.h && !!g.road[yy * g.w + xx];

    // curbs against non-road neighbours
    m.fillStyle = th.curb;
    if (!roadAt(x, y - 1)) m.fillRect(px, py, pw, 3);
    if (!roadAt(x, y + 1)) m.fillRect(px, py + ph - 3, pw, 3);
    if (!roadAt(x - 1, y)) m.fillRect(px, py, 3, ph);
    if (!roadAt(x + 1, y)) m.fillRect(px + pw - 3, py, 3, ph);

    if (onH && onV) {
      // intersection: crosswalk bars on each entry
      m.fillStyle = 'rgba(230,233,238,0.4)';
      const bw = Math.max(2, es * 0.07), bl = es * 0.16, gap = es * 0.22;
      for (let i = -1; i <= 1; i++) {
        if (roadAt(x - 1, y)) m.fillRect(px + 2, py + ph / 2 + i * gap - bw / 2, bl, bw);
        if (roadAt(x + 1, y)) m.fillRect(px + pw - 2 - bl, py + ph / 2 + i * gap - bw / 2, bl, bw);
        if (roadAt(x, y - 1)) m.fillRect(px + pw / 2 + i * gap - bw / 2, py + 2, bw, bl);
        if (roadAt(x, y + 1)) m.fillRect(px + pw / 2 + i * gap - bw / 2, py + ph - 2 - bl, bw, bl);
      }
    } else if (onH) {
      m.fillStyle = th.line;
      m.fillRect(px + pw * 0.3, py + ph / 2 - 1, pw * 0.4, 2);
    } else if (onV) {
      m.fillStyle = th.line;
      m.fillRect(px + pw / 2 - 1, py + ph * 0.3, 2, ph * 0.4);
    }
  }

  // ------------------------------------------------------------------
  // Dynamic entities
  // ------------------------------------------------------------------
  // '#rrggbb' -> "r,g,b" scaled by factor f (for building rgba() strings)
  function shadeHex(hex, f) {
    const n = parseInt((hex || '#2b2e34').slice(1), 16);
    const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
    const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
    const b = Math.min(255, (n & 255) * f) | 0;
    return r + ',' + g + ',' + b;
  }

  function drawDecals(run) {
    // a fresh patch is a slightly darker shade of THIS map's road, so the repair
    // mark always reads as new asphalt-on-road (not a fixed grey on every world)
    const patch = shadeHex(PP.Game.district && PP.Game.district.theme.road, 0.8);
    for (const dc of run.decals) {
      const age = run.t - dc.t;
      const alpha = Math.max(0.35, 0.85 - age / 40);
      ctx.fillStyle = `rgba(${patch},${alpha})`;
      ctx.beginPath();
      ctx.arc(tx2px(dc.x), ty2px(dc.y), dc.r * es * 1.25, 0, 7);
      ctx.fill();

      // fresh-patch flash: a bright ring expands outward and fades (~0.45s) so
      // the instant a hole is fixed reads as a satisfying "pop"
      if (age < 0.45) {
        const f = age / 0.45;                                  // 0 → 1
        ctx.globalAlpha = (1 - f) * 0.9;
        ctx.strokeStyle = '#ffe27a';
        ctx.lineWidth = Math.max(1.5, es * 0.12) * (1 - f * 0.6);
        ctx.beginPath();
        ctx.arc(tx2px(dc.x), ty2px(dc.y), dc.r * es * 1.25 + f * es * 1.3, 0, 7);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function blobPath(c, p, r) {
    c.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + p.seed;
      const rad = r * p.pts[i];
      const X = Math.cos(a) * rad, Y = Math.sin(a) * rad;
      if (i === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
    }
    c.closePath();
  }

  // ---- Potholes -----------------------------------------------------
  // Shared layout: a per-location hazard "base" shape, then the same
  // status overlays (hit flash, dispatched ring, repair cones+progress)
  // so gameplay reads identically across every world.
  function drawPothole(run, p, t) {
    const th = PP.Game.district.theme;
    const x = tx2px(p.x), y = ty2px(p.y);
    const popIn = Math.min(1, (run.t - p.born) * 3);   // small spawn pop
    const rFull = es * (0.10 + 0.17 * p.sev) * popIn;  // full size — fixes cone spacing
    // while a truck works it, the hole shrinks back down — its growth in reverse
    const shrink = (p.state === 'patching' && p.truck && p.truck.patchDur)
      ? Math.max(0, p.truck.patchT / p.truck.patchDur) : 1;
    const r = rFull * shrink;

    ctx.save();
    ctx.translate(x, y);

    drawHazardBase(th.holeStyle || 'pothole', p, r, t);

    if (p.hitFlash > 0) {   // a car just slammed into it
      ctx.strokeStyle = `rgba(255,77,94,${Math.min(1, p.hitFlash * 1.8)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, 7); ctx.stroke();
    }

    if (p.state === 'assigned') {   // truck en route
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -t * 22;
      ctx.strokeStyle = '#ffc62e';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ground-level repair cones either side — but NOT on a road an Advanced
    // Truck has shut down (its only cones are the fences at the intersections).
    if (p.state === 'patching' && p.truck && !(p.truck.flags && p.truck.flags.roadClose)) {
      // spaced off the FULL hole size, not the shrinking one, so they hold still
      drawCone(-(rFull + es * 0.22), 0);
      drawCone(rFull + es * 0.22, 0);
    }

    ctx.restore();
  }

  // Repair progress rings. Drawn in their own pass — after the traffic and
  // structures — so the "loading circle" stays visible on top of the truck
  // doing the patching instead of being hidden behind it.
  function drawRepairProgress(run) {
    for (const p of run.potholes) {
      // only the pothole actively being worked shows a ring — a closed road's
      // queued potholes are coned off but wait their turn (no ring)
      if (p.state !== 'patching' || !p.truck || p.truck.target !== p) continue;
      const x = tx2px(p.x), y = ty2px(p.y);
      const r = es * (0.10 + 0.17 * p.sev);
      const frac = 1 - p.truck.patchT / p.truck.patchDur;
      const ry = y - (r + es * 0.4);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(x, ry, es * 0.16, 0, 7); ctx.stroke();
      // progress arc — glows brighter and blooms the closer it gets to 100%
      ctx.save();
      const glow = frac * frac;                       // ramps up sharply near the end
      ctx.shadowColor = '#ffe27a';
      ctx.shadowBlur = glow * 18;
      ctx.lineWidth = 4 + glow * 2.5;
      ctx.strokeStyle = frac > 0.85 ? '#fff1a8' : '#ffd14a';
      ctx.beginPath(); ctx.arc(x, ry, es * 0.16, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
      if (frac > 0.55) { ctx.shadowBlur = glow * 28; ctx.stroke(); }   // extra bloom pass
      ctx.restore();
    }
  }

  // Per-location hazard shapes. Drawn centred at (0,0); radius r.
  function drawHazardBase(style, p, r, t) {
    switch (style) {
      case 'quicksand': {
        ctx.fillStyle = '#caa463';
        blobPath(ctx, p, r * 1.15); ctx.fill();
        // sinking ripple rings, slowly rotating
        ctx.save();
        ctx.rotate(t * 0.6 + p.seed);
        for (let i = 3; i >= 1; i--) {
          ctx.fillStyle = i % 2 ? '#a8814a' : '#bd9656';
          ctx.beginPath(); ctx.ellipse(0, 0, r * (i / 3), r * (i / 3) * 0.9, 0, 0, 7); ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = '#7c5a31';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, 7); ctx.fill();
        break;
      }
      case 'ice': {
        ctx.fillStyle = '#bcd9e8';                       // frosty rim
        blobPath(ctx, p, r * 1.15); ctx.fill();
        ctx.fillStyle = '#3a6b85';                       // dark water
        blobPath(ctx, p, r * 0.7); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';      // cracks
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 5; i++) {
          const a = p.seed + i * 1.4;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a) * (r + es * 0.14), Math.sin(a) * (r + es * 0.14));
          ctx.stroke();
        }
        break;
      }
      case 'geyser': {
        ctx.fillStyle = '#2c6d80';                       // dark vent pool
        blobPath(ctx, p, r); ctx.fill();
        ctx.fillStyle = '#13313c';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, 7); ctx.fill();
        // erupting water column
        const jh = r * (1.6 + Math.sin(t * 6 + p.seed) * 0.7);
        const grd = ctx.createLinearGradient(0, 0, 0, -jh - r);
        grd.addColorStop(0, 'rgba(150,225,255,0.85)');
        grd.addColorStop(1, 'rgba(150,225,255,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.moveTo(-r * 0.45, 0);
        ctx.lineTo(-r * 0.18, -jh - r);
        ctx.lineTo(r * 0.18, -jh - r);
        ctx.lineTo(r * 0.45, 0);
        ctx.closePath(); ctx.fill();
        // droplets
        ctx.fillStyle = 'rgba(200,240,255,0.8)';
        for (let i = 0; i < 3; i++) {
          const ph = (t * 1.5 + i * 0.4 + p.seed) % 1;
          ctx.beginPath();
          ctx.arc((i - 1) * r * 0.4, -ph * (jh + r), Math.max(1, r * 0.12), 0, 7);
          ctx.fill();
        }
        break;
      }
      case 'meteor': {
        ctx.fillStyle = '#3a3a42';                       // crater rim
        blobPath(ctx, p, r * 1.2); ctx.fill();
        ctx.fillStyle = '#17171c';                       // crater shadow
        blobPath(ctx, p, r * 0.85); ctx.fill();
        ctx.fillStyle = '#2a241f';                       // meteor rock
        ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, 7); ctx.fill();
        ctx.fillStyle = '#3a322a';
        ctx.beginPath(); ctx.arc(-r * 0.18, -r * 0.18, r * 0.22, 0, 7); ctx.fill();
        const glow = 0.4 + 0.3 * Math.sin(t * 4 + p.seed);   // ember pulse
        ctx.fillStyle = `rgba(255,120,40,${glow})`;
        ctx.beginPath(); ctx.arc(r * 0.2, r * 0.15, r * 0.18, 0, 7); ctx.fill();
        break;
      }
      case 'rift': {
        ctx.save();
        ctx.shadowBlur = 14; ctx.shadowColor = '#ff3df0';
        ctx.fillStyle = '#1a0a2a';                       // dark rift floor
        blobPath(ctx, p, r); ctx.fill();
        // bright energy crack
        ctx.shadowColor = '#3df0ff';
        ctx.strokeStyle = `rgba(120,240,255,${0.7 + 0.3 * Math.sin(t * 8 + p.seed)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-r, 0);
        ctx.lineTo(-r * 0.2, -r * 0.35);
        ctx.lineTo(r * 0.2, r * 0.35);
        ctx.lineTo(r, 0);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'tornado': {
        const spin = t * 5 + p.seed;
        // dark debris scar where the funnel touches down
        ctx.fillStyle = 'rgba(24,26,32,0.5)';
        blobPath(ctx, p, r * 0.95); ctx.fill();
        // swirling funnel widening as it rises
        const fh = r * 3.4, layers = 8;
        for (let i = 0; i < layers; i++) {
          const f = i / (layers - 1);                      // 0 base .. 1 top
          const yy = -f * fh;
          const wob = Math.sin(spin + f * 4.5) * r * 0.4 * f;   // sway grows with height
          const rx = r * (0.45 + f * 1.5);
          const ry = r * (0.16 + f * 0.22);
          ctx.fillStyle = `rgba(${120 + i * 5},${126 + i * 5},${140 + i * 4},${0.34 + 0.03 * i})`;
          ctx.beginPath(); ctx.ellipse(wob, yy, rx, ry, 0, 0, 7); ctx.fill();
        }
        // debris specks orbiting near the base
        ctx.fillStyle = 'rgba(92,82,70,0.85)';
        for (let i = 0; i < 4; i++) {
          const a = spin * 1.7 + i * 1.7;
          const orb = r * (0.85 + 0.3 * Math.sin(spin + i));
          ctx.beginPath();
          ctx.arc(Math.cos(a) * orb, -r * 0.4 + Math.sin(a) * r * 0.3, Math.max(1, r * 0.13), 0, 7);
          ctx.fill();
        }
        break;
      }
      case 'lavacrack': {   // crusted basalt that splits to glowing molten rock
        ctx.fillStyle = '#1f1714'; blobPath(ctx, p, r * 1.15); ctx.fill();           // dark crust
        const glow = 0.55 + 0.35 * Math.sin(t * 5 + p.seed);
        ctx.save(); ctx.shadowBlur = 12; ctx.shadowColor = '#ff7a1e';
        ctx.strokeStyle = `rgba(255,150,40,${glow})`; ctx.lineWidth = 2.6;            // glowing cracks
        for (let i = 0; i < 4; i++) {
          const a = p.seed + i * 1.7;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1); ctx.stroke();
        }
        ctx.fillStyle = `rgba(255,200,80,${glow})`;                                   // molten core
        ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, 7); ctx.fill();
        ctx.restore();
        break;
      }
      case 'crackle': {   // shattered hard candy
        ctx.fillStyle = 'rgba(255,120,170,0.9)'; blobPath(ctx, p, r * 1.1); ctx.fill();
        ctx.fillStyle = '#b83a6a'; ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, 7); ctx.fill();   // dark hollow
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.6;             // glassy cracks
        for (let i = 0; i < 5; i++) {
          const a = p.seed + i * 1.3;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2);
          ctx.lineTo(Math.cos(a) * (r + es * 0.14), Math.sin(a) * (r + es * 0.14)); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.6)';                                      // sugar shine fleck
        ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.3, r * 0.14, 0, 7); ctx.fill();
        break;
      }
      case 'gearpit': {   // a pit with a slowly turning gear
        ctx.fillStyle = '#2a2d33'; blobPath(ctx, p, r * 1.1); ctx.fill();            // pit
        ctx.save(); ctx.rotate(t * 1.2 + p.seed);
        ctx.fillStyle = '#9aa0aa';                                                   // cog teeth
        const teeth = 8;
        for (let i = 0; i < teeth; i++) { const a = i / teeth * 7; ctx.fillRect(Math.cos(a) * r * 0.7 - r * 0.12, Math.sin(a) * r * 0.7 - r * 0.12, r * 0.24, r * 0.24); }
        ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, 7); ctx.fill();                   // cog body
        ctx.fillStyle = '#5a606a'; ctx.beginPath(); ctx.arc(0, 0, r * 0.24, 0, 7); ctx.fill();   // hub
        ctx.restore();
        break;
      }
      case 'gasvent': {   // a swelling mud blob that bubbles and belches gas
        ctx.fillStyle = '#3f4a2e'; blobPath(ctx, p, r * 1.15); ctx.fill();             // glossy mud
        ctx.fillStyle = '#2a3320'; ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, 7); ctx.fill();
        const puff = (Math.sin(t * 2 + p.seed) + 1) * 0.5;                              // gas puff balloons and fades
        ctx.fillStyle = `rgba(150,210,90,${0.28 * (1 - puff)})`;
        ctx.beginPath(); ctx.arc(0, -r * 0.3 - puff * r, r * (0.4 + puff * 0.8), 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(120,160,80,0.8)';                                         // rising bubbles
        for (let i = 0; i < 3; i++) { const ph = (t * 1.3 + i * 0.4 + p.seed) % 1; ctx.beginPath(); ctx.arc((i - 1) * r * 0.3, -ph * r, Math.max(1, r * 0.12 * (1 - ph)), 0, 7); ctx.fill(); }
        break;
      }
      case 'breach': {   // a torn hull breach venting air to the void
        ctx.fillStyle = '#05060a'; blobPath(ctx, p, r); ctx.fill();                     // hole to space
        ctx.fillStyle = 'rgba(255,255,255,0.9)';                                        // a couple of stars in the gap
        ctx.beginPath(); ctx.arc(-r * 0.2, -r * 0.15, 1, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(r * 0.25, r * 0.1, 1, 0, 7); ctx.fill();
        ctx.fillStyle = '#9aa2ac';                                                      // torn silver plating peeled outward
        for (let i = 0; i < 6; i++) {
          const a = p.seed + i * 1.05;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
          ctx.lineTo(Math.cos(a + 0.2) * r * 1.25, Math.sin(a + 0.2) * r * 1.25);
          ctx.lineTo(Math.cos(a - 0.2) * r * 1.2, Math.sin(a - 0.2) * r * 1.2);
          ctx.closePath(); ctx.fill();
        }
        const jet = 0.4 + 0.3 * Math.sin(t * 9 + p.seed);                               // flickering vent jet
        ctx.fillStyle = `rgba(220,240,255,${jet})`;
        ctx.beginPath(); ctx.ellipse(0, 0, r * 0.5, r * 0.28, t, 0, 7); ctx.fill();
        break;
      }
      case 'tear': {   // a rip in the paper world, underlayer showing through
        ctx.fillStyle = '#f4efe4'; blobPath(ctx, p, r * 1.15); ctx.fill();              // white paper underlayer
        ctx.fillStyle = '#0c0d10';                                                      // jagged dark rip
        ctx.beginPath();
        for (let i = 0; i <= 10; i++) { const a = p.seed + i / 10 * 7; const rad = r * (i % 2 ? 0.55 : 0.95); const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(a) * rad, Math.sin(a) * rad); }
        ctx.closePath(); ctx.fill();
        const lift = 2 + Math.sin(t * 3 + p.seed) * 2;                                  // curling torn flaps lift
        ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(-r, r * 0.7, r * 2, lift);     // flap drop shadow
        ctx.fillStyle = '#e6dcc8';
        ctx.beginPath(); ctx.moveTo(-r * 0.8, r * 0.7); ctx.lineTo(-r * 0.2, r * 0.7); ctx.lineTo(-r * 0.5, r * 0.7 - lift * 2); ctx.closePath(); ctx.fill();
        break;
      }
      default: {   // 'pothole' — classic dark asphalt hole
        ctx.strokeStyle = 'rgba(12,13,16,0.5)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i++) {
          const a = p.seed + i * 2.1;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
          ctx.lineTo(Math.cos(a) * (r + es * 0.16), Math.sin(a) * (r + es * 0.16));
          ctx.stroke();
        }
        ctx.fillStyle = '#15161a';
        blobPath(ctx, p, r); ctx.fill();
        ctx.fillStyle = '#0b0c0f';
        ctx.save(); ctx.scale(0.55, 0.55); blobPath(ctx, p, r); ctx.fill(); ctx.restore();
      }
    }
  }

  // Traffic cones an Advanced Truck drops across the intersections of a road
  // it has shut down (positions live on the truck as tr.cones, in tile units).
  function drawRoadClosures(run) {
    for (const tr of run.trucks) {
      if (!tr.cones) continue;
      for (const cn of tr.cones) drawCone(tx2px(cn.x), ty2px(cn.y));
    }
  }

  function drawCone(cx, cy) {
    const h = es * 0.2;
    ctx.fillStyle = '#ff7a1a';
    ctx.beginPath();
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx - h * 0.55, cy + h * 0.4);
    ctx.lineTo(cx + h * 0.55, cy + h * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f4efe6';
    ctx.fillRect(cx - h * 0.3, cy - h * 0.25, h * 0.6, h * 0.18);
  }

  // ---- Traffic ------------------------------------------------------
  // Per-location "vehicle" shapes; the body always points along travel.
  function drawCar(c, t) {
    const th = PP.Game.district.theme;
    const style = th.carStyle || 'car';
    const x = tx2px(c.x), y = ty2px(c.y);
    ctx.save();
    ctx.translate(x, y);
    if (c.hurtT > 0) ctx.translate((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
    const ang = c.angle !== undefined ? c.angle
      : (c.axis === 'h' ? (c.dir > 0 ? 0 : Math.PI) : (c.dir > 0 ? Math.PI / 2 : -Math.PI / 2));
    ctx.rotate(ang);
    if (c.transit) drawTransit(th, style, c, t);
    else drawVehicle(style, c, t);
    if (c.hurtT > 0) {                          // damage flash (rough box)
      ctx.fillStyle = `rgba(255,80,90,${Math.min(0.6, c.hurtT)})`;
      const L = es * 0.5;
      ctx.beginPath(); ctx.arc(0, 0, L * 0.5, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  // All vehicles are drawn TOP-DOWN: forward = +x, you're looking straight
  // down at the roof/back. No side-profile silhouettes.
  function drawVehicle(style, c, t) {
    const L = es * 0.46, Wd = es * 0.27;
    switch (style) {
      case 'fish': {
        const fl = es * 0.52, fw = es * 0.32;
        ctx.fillStyle = 'rgba(10,40,60,0.22)';                 // shadow
        ctx.beginPath(); ctx.ellipse(1, 2, fl * 0.5, fw * 0.5, 0, 0, 7); ctx.fill();
        const wig = Math.sin(t * 10 + c.x) * fw * 0.22;
        ctx.fillStyle = c.color;
        ctx.beginPath();                                       // tail fin (flat, top-down)
        ctx.moveTo(-fl * 0.42, 0);
        ctx.lineTo(-fl * 0.72, -fw * 0.45 + wig);
        ctx.lineTo(-fl * 0.72, fw * 0.45 + wig);
        ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.ellipse(fl * 0.02, -fw * 0.5, fl * 0.18, fw * 0.12, -0.5, 0, 7); ctx.fill();  // side fins
        ctx.beginPath(); ctx.ellipse(fl * 0.02, fw * 0.5, fl * 0.18, fw * 0.12, 0.5, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, 0, fl * 0.5, fw * 0.5, 0, 0, 7); ctx.fill();   // body
        ctx.fillStyle = 'rgba(255,255,255,0.25)';              // spine stripe
        ctx.beginPath(); ctx.ellipse(fl * 0.05, 0, fl * 0.4, fw * 0.16, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#16181c';                             // two eyes (top-down)
        ctx.beginPath(); ctx.arc(fl * 0.34, -fw * 0.2, fw * 0.08, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(fl * 0.34, fw * 0.2, fw * 0.08, 0, 7); ctx.fill();
        break;
      }
      case 'rover': {
        if (c.variant) {                                       // mini flying saucer
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.beginPath(); ctx.ellipse(1, 2, L * 0.58, Wd * 0.62, 0, 0, 7); ctx.fill();
          ctx.fillStyle = c.color;
          ctx.beginPath(); ctx.ellipse(0, 0, L * 0.56, Wd * 0.6, 0, 0, 7); ctx.fill();
          ctx.fillStyle = '#bfe9ff';                           // central dome
          ctx.beginPath(); ctx.arc(0, 0, Wd * 0.34, 0, 7); ctx.fill();
          const blink = (t * 3 + c.x) % 1 < 0.5 ? '#ffd14a' : '#ff5f5f';
          ctx.fillStyle = blink;                               // ring of lights
          for (let i = 0; i < 4; i++) { const a = i / 4 * 7 + t; ctx.beginPath(); ctx.arc(Math.cos(a) * L * 0.42, Math.sin(a) * Wd * 0.44, Math.max(1.2, es * 0.035), 0, 7); ctx.fill(); }
        } else {                                               // wheeled rover (4 corner wheels)
          ctx.fillStyle = '#26282d';
          const wL = L * 0.16, wW = Wd * 0.2;
          for (const sx of [-0.34, 0.34]) for (const sy of [-0.5, 0.5]) { rr(ctx, sx * L - wL / 2, sy * Wd - wW / 2, wL, wW, 2); ctx.fill(); }
          ctx.fillStyle = c.color;                             // chassis
          rr(ctx, -L * 0.42, -Wd * 0.36, L * 0.84, Wd * 0.72, 3); ctx.fill();
          ctx.fillStyle = 'rgba(40,60,90,0.6)';                // instrument deck
          rr(ctx, -L * 0.3, -Wd * 0.26, L * 0.4, Wd * 0.52, 2); ctx.fill();
          ctx.fillStyle = '#d0d4da';                           // sensor turret (top-down)
          ctx.beginPath(); ctx.arc(L * 0.28, 0, Wd * 0.13, 0, 7); ctx.fill();
          ctx.fillStyle = '#ff5f5f';
          ctx.beginPath(); ctx.arc(L * 0.28, 0, Wd * 0.05, 0, 7); ctx.fill();
        }
        break;
      }
      case 'hover': {
        const glow = 0.4 + 0.25 * Math.sin(t * 6 + c.x);       // underglow halo
        ctx.fillStyle = `rgba(120,240,255,${glow})`;
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.6, Wd * 0.55, 0, 0, 7); ctx.fill();
        ctx.fillStyle = c.color;                               // sleek hull, pointed nose
        ctx.beginPath();
        ctx.moveTo(L * 0.5, 0);
        ctx.quadraticCurveTo(L * 0.1, -Wd * 0.55, -L * 0.45, -Wd * 0.32);
        ctx.lineTo(-L * 0.45, Wd * 0.32);
        ctx.quadraticCurveTo(L * 0.1, Wd * 0.55, L * 0.5, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(20,40,60,0.75)';                 // cockpit canopy (centre)
        ctx.beginPath(); ctx.ellipse(L * 0.08, 0, L * 0.16, Wd * 0.26, 0, 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(120,240,255,${0.6 + 0.3 * Math.sin(t * 9 + c.x)})`;  // rear thrusters
        ctx.beginPath(); ctx.arc(-L * 0.42, -Wd * 0.18, es * 0.04, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(-L * 0.42, Wd * 0.18, es * 0.04, 0, 7); ctx.fill();
        break;
      }
      case 'bird': {   // top-down bird, wings hinged at the body, beak forward (+x)
        const bl = es * 0.5, bw = es * 0.30;
        const beat = Math.sin(t * 13 + c.x * 1.3);         // -1 (up) .. +1 (down)
        const span = bw * (1.05 + 0.6 * beat);             // wingtip reach (sideways)
        const tipX = -bl * 0.06 - bl * 0.16 * Math.max(0, beat);  // tips rake back on the downbeat
        ctx.fillStyle = 'rgba(20,40,70,0.15)';             // shadow on the clouds below
        ctx.beginPath(); ctx.ellipse(1, 3, bl * 0.36, bw * 0.28, 0, 0, 7); ctx.fill();
        // wings: each is a blade rooted at the shoulder, only the tip moves
        for (const sgn of [-1, 1]) {
          ctx.fillStyle = c.color;
          ctx.beginPath();
          ctx.moveTo(bl * 0.2, sgn * bw * 0.14);                                  // leading root (front shoulder)
          ctx.quadraticCurveTo(bl * 0.16, sgn * span * 0.7, tipX, sgn * span);     // leading edge out to tip
          ctx.quadraticCurveTo(-bl * 0.3, sgn * span * 0.45, -bl * 0.22, sgn * bw * 0.12); // trailing edge back to rear shoulder
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.22)';                               // wingtip feathers
          ctx.beginPath(); ctx.ellipse(tipX, sgn * span * 0.86, bl * 0.09, bw * 0.11, sgn * 0.5, 0, 7); ctx.fill();
        }
        ctx.fillStyle = c.color;                           // forked tail (back)
        ctx.beginPath();
        ctx.moveTo(-bl * 0.32, 0);
        ctx.lineTo(-bl * 0.62, -bw * 0.26);
        ctx.lineTo(-bl * 0.48, 0);
        ctx.lineTo(-bl * 0.62, bw * 0.26);
        ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, 0, bl * 0.4, bw * 0.3, 0, 0, 7); ctx.fill();   // body (covers wing roots)
        ctx.fillStyle = 'rgba(255,255,255,0.3)';           // pale breast
        ctx.beginPath(); ctx.ellipse(bl * 0.06, 0, bl * 0.24, bw * 0.18, 0, 0, 7); ctx.fill();
        ctx.fillStyle = c.color;                           // head
        ctx.beginPath(); ctx.arc(bl * 0.36, 0, bw * 0.24, 0, 7); ctx.fill();
        ctx.fillStyle = '#ff9a3d';                         // beak (forward)
        ctx.beginPath();
        ctx.moveTo(bl * 0.56, 0); ctx.lineTo(bl * 0.4, -bw * 0.11); ctx.lineTo(bl * 0.4, bw * 0.11);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#16181c';                         // two eyes (top-down)
        ctx.beginPath(); ctx.arc(bl * 0.4, -bw * 0.12, bw * 0.055, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(bl * 0.4,  bw * 0.12, bw * 0.055, 0, 7); ctx.fill();
        break;
      }
      case 'cinderhauler': {   // top-down ore hauler: bright cab + open glowing-ore bed
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 3); ctx.fill();   // shadow
        ctx.fillStyle = '#6b6259'; rr(ctx, -L / 2, -Wd / 2, L, Wd, 3); ctx.fill();        // steel chassis (pops on dark road)
        ctx.fillStyle = c.color; rr(ctx, L * 0.04, -Wd / 2, L * 0.46, Wd, 3); ctx.fill(); // cab (front, bright)
        ctx.fillStyle = 'rgba(190,225,255,0.8)'; rr(ctx, L * 0.3, -Wd / 2 + 2, L * 0.13, Wd - 4, 2); ctx.fill();   // windshield (front)
        ctx.fillStyle = '#241c17'; rr(ctx, -L * 0.46, -Wd * 0.36, L * 0.46, Wd * 0.72, 2); ctx.fill();             // open ore bed
        ctx.save(); ctx.shadowBlur = 6; ctx.shadowColor = '#ff7a1e';                      // glowing ore load
        ctx.fillStyle = `rgba(255,150,50,${0.75 + 0.2 * Math.sin(t * 6 + c.x)})`;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(-L * 0.34 + i * L * 0.13, (i % 2 ? -1 : 1) * Wd * 0.13, Wd * 0.13, 0, 7); ctx.fill(); }
        ctx.restore();
        ctx.fillStyle = 'rgba(255,240,200,0.95)';                                          // headlights (front)
        ctx.fillRect(L * 0.47, -Wd / 2 + 2, 2, Wd * 0.22); ctx.fillRect(L * 0.47, Wd / 2 - 2 - Wd * 0.22, 2, Wd * 0.22);
        break;
      }
      case 'gumdrop': {   // top-down candy car: glossy pill body + windshield + sprinkles
        ctx.fillStyle = 'rgba(0,0,0,0.22)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, Wd * 0.5); ctx.fill();   // shadow
        ctx.fillStyle = c.color; rr(ctx, -L / 2, -Wd / 2, L, Wd, Wd * 0.5); ctx.fill();    // glossy pill body
        ctx.fillStyle = 'rgba(255,255,255,0.5)'; rr(ctx, -L * 0.3, -Wd * 0.42, L * 0.55, Wd * 0.28, Wd * 0.14); ctx.fill();   // candy gloss stripe
        ctx.fillStyle = 'rgba(120,200,255,0.7)'; rr(ctx, L * 0.16, -Wd * 0.34, L * 0.16, Wd * 0.68, 2); ctx.fill();           // windshield (front)
        ctx.fillStyle = 'rgba(255,255,255,0.9)';                                            // sugar sprinkles
        ctx.beginPath(); ctx.arc(-L * 0.16, Wd * 0.1, Wd * 0.07, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(-L * 0.02, -Wd * 0.04, Wd * 0.06, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,200,0.95)'; ctx.fillRect(L * 0.46, -Wd / 2 + 2, 2, Wd * 0.2); ctx.fillRect(L * 0.46, Wd / 2 - 2 - Wd * 0.2, 2, Wd * 0.2);   // headlights
        break;
      }
      case 'windup': {   // top-down tin car: 4 wheels, windshield, wind-up key on the roof
        ctx.fillStyle = '#26282d';                                                         // 4 corner wheels (seen from above)
        const wL = L * 0.18, wW = Wd * 0.22;
        for (const sx of [-0.34, 0.34]) for (const sy of [-0.52, 0.52]) { rr(ctx, sx * L - wL / 2, sy * Wd - wW / 2, wL, wW, 2); ctx.fill(); }
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(ctx, -L * 0.44 + 1, -Wd * 0.42 + 2, L * 0.88, Wd * 0.84, 3); ctx.fill();   // shadow
        ctx.fillStyle = c.color; rr(ctx, -L * 0.44, -Wd * 0.42, L * 0.88, Wd * 0.84, 3); ctx.fill();   // tin body
        ctx.fillStyle = 'rgba(255,255,255,0.4)'; rr(ctx, -L * 0.36, -Wd * 0.34, L * 0.72, Wd * 0.16, 2); ctx.fill();   // tin shine
        ctx.fillStyle = 'rgba(120,200,255,0.65)'; rr(ctx, L * 0.16, -Wd * 0.3, L * 0.16, Wd * 0.6, 2); ctx.fill();     // windshield (front)
        ctx.strokeStyle = '#e8c044'; ctx.lineWidth = Math.max(1.5, es * 0.045);            // wind-up key on the roof (top-down)
        ctx.beginPath(); ctx.arc(-L * 0.16, 0, Wd * 0.16, 0, 7); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-L * 0.16 - Wd * 0.16, 0); ctx.lineTo(-L * 0.16 + Wd * 0.16, 0);
        ctx.moveTo(-L * 0.16, -Wd * 0.16); ctx.lineTo(-L * 0.16, Wd * 0.16); ctx.stroke();
        break;
      }
      case 'airboat': {   // top-down fan-boat: flat hull + a big caged rear fan
        ctx.fillStyle = 'rgba(10,20,15,0.25)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.5, Wd * 0.55, 0, 0, 7); ctx.fill();   // wake shadow
        ctx.fillStyle = c.color;                                                          // flat trapezoid hull
        ctx.beginPath(); ctx.moveTo(L * 0.5, 0); ctx.lineTo(L * 0.1, -Wd * 0.5); ctx.lineTo(-L * 0.4, -Wd * 0.4); ctx.lineTo(-L * 0.4, Wd * 0.4); ctx.lineTo(L * 0.1, Wd * 0.5); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(ctx, -L * 0.18, -Wd * 0.22, L * 0.24, Wd * 0.44, 2); ctx.fill();   // bench
        ctx.fillStyle = '#2a2d33'; ctx.beginPath(); ctx.arc(-L * 0.42, 0, Wd * 0.46, 0, 7); ctx.fill();           // fan cage
        ctx.strokeStyle = 'rgba(220,230,225,0.85)'; ctx.lineWidth = Math.max(1.2, es * 0.03);                     // spinning blades
        const sp = t * 30 + c.x;
        for (let i = 0; i < 3; i++) { const a = sp + i * 2.1; ctx.beginPath(); ctx.moveTo(-L * 0.42, 0); ctx.lineTo(-L * 0.42 + Math.cos(a) * Wd * 0.4, Math.sin(a) * Wd * 0.4); ctx.stroke(); }
        break;
      }
      case 'maghauler': {   // top-down ore hauler on scrolling mag-treads
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 3); ctx.fill();
        ctx.fillStyle = '#2a2d33';                                                        // mag-tread bands
        rr(ctx, -L * 0.46, -Wd * 0.5, L * 0.92, Wd * 0.14, 2); ctx.fill(); rr(ctx, -L * 0.46, Wd * 0.36, L * 0.92, Wd * 0.14, 2); ctx.fill();
        ctx.fillStyle = 'rgba(232,162,58,0.8)';                                           // scrolling tread ticks
        for (let i = 0; i < 5; i++) { const ox = ((i * L * 0.2 + t * es * 0.6 + c.x) % (L * 0.9)) - L * 0.45; ctx.fillRect(ox, -Wd * 0.5, L * 0.04, Wd * 0.14); ctx.fillRect(ox, Wd * 0.36, L * 0.04, Wd * 0.14); }
        ctx.fillStyle = c.color; rr(ctx, -L * 0.42, -Wd * 0.34, L * 0.84, Wd * 0.68, 3); ctx.fill();   // body
        ctx.fillStyle = '#3a3d42'; rr(ctx, -L * 0.36, -Wd * 0.24, L * 0.4, Wd * 0.48, 2); ctx.fill();  // ore hopper
        ctx.fillStyle = '#8a929c'; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(-L * 0.3 + i * L * 0.12, 0, Wd * 0.1, 0, 7); ctx.fill(); }   // ore
        ctx.fillStyle = 'rgba(180,220,255,0.6)'; rr(ctx, L * 0.26, -Wd * 0.28, L * 0.1, Wd * 0.56, 2); ctx.fill();   // windshield
        ctx.fillStyle = `rgba(255,180,60,${0.5 + 0.3 * Math.sin(t * 5 + c.x)})`; ctx.beginPath(); ctx.arc(L * 0.36, -Wd * 0.34, es * 0.03, 0, 7); ctx.fill();   // beacon
        break;
      }
      case 'origami': {   // top-down folded paper crane-car
        ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.46, Wd * 0.5, 0, 0, 7); ctx.fill();
        ctx.fillStyle = c.color;                                                          // angular folded body, pointed prow
        ctx.beginPath(); ctx.moveTo(L * 0.52, 0); ctx.lineTo(-L * 0.1, -Wd * 0.5); ctx.lineTo(-L * 0.46, -Wd * 0.18); ctx.lineTo(-L * 0.46, Wd * 0.18); ctx.lineTo(-L * 0.1, Wd * 0.5); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.moveTo(L * 0.52, 0); ctx.lineTo(-L * 0.1, Wd * 0.5); ctx.lineTo(-L * 0.46, Wd * 0.18); ctx.closePath(); ctx.fill();   // crease shadow (one side)
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;                    // fold crease
        ctx.beginPath(); ctx.moveTo(L * 0.52, 0); ctx.lineTo(-L * 0.46, 0); ctx.stroke();
        ctx.fillStyle = '#2a2d33'; ctx.beginPath(); ctx.arc(L * 0.34, 0, Wd * 0.06, 0, 7); ctx.fill();   // folded beak tip
        break;
      }
      default: {   // 'car' — top-down roof, glass at front & rear
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 4); ctx.fill();
        ctx.fillStyle = c.color;
        rr(ctx, -L / 2, -Wd / 2, L, Wd, 4); ctx.fill();
        ctx.fillStyle = 'rgba(180,220,255,0.55)';              // windshield (front)
        rr(ctx, L * 0.12, -Wd / 2 + 2, L * 0.12, Wd - 4, 2); ctx.fill();
        ctx.fillStyle = 'rgba(20,30,45,0.5)';                  // rear window
        rr(ctx, -L * 0.28, -Wd / 2 + 2, L * 0.1, Wd - 4, 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';              // roof highlight
        rr(ctx, -L * 0.12, -Wd / 2 + 3, L * 0.22, Wd - 6, 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,200,0.9)';               // headlights
        ctx.fillRect(L * 0.44, -Wd / 2 + 2, 2, Wd * 0.2);
        ctx.fillRect(L * 0.44, Wd / 2 - 2 - Wd * 0.2, 2, Wd * 0.2);
      }
    }
  }

  // Occasional "transit" vehicle — a longer mass-transit unit in the
  // location's transitColour (Londinium's red double-decker, a Skyhaven
  // airship, a Coral whale, a Neon transit-pod, a Luna cargo-rover…).
  function drawTransit(th, style, c, t) {
    const col = th.transitColor || '#f2c14e';
    if (style === 'airboat') {                    // a ferry barge: long pontoon + twin fans
      const L = es * 0.98, Wd = es * 0.44;
      ctx.fillStyle = 'rgba(10,20,15,0.25)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.5, Wd * 0.5, 0, 0, 7); ctx.fill();
      ctx.fillStyle = col; rr(ctx, -L * 0.4, -Wd / 2, L * 0.8, Wd, 4); ctx.fill();           // pontoon deck
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; rr(ctx, -L * 0.18, -Wd * 0.3, L * 0.36, Wd * 0.6, 3); ctx.fill();   // canopy
      ctx.fillStyle = '#2a2d33';                                                              // twin rear fan cages
      ctx.beginPath(); ctx.arc(-L * 0.42, -Wd * 0.26, Wd * 0.2, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(-L * 0.42, Wd * 0.26, Wd * 0.2, 0, 7); ctx.fill();
      return;
    }
    if (style === 'maghauler') {                  // a coupled ore-tram (linked hoppers)
      const L = es * 1.0, Wd = es * 0.34;
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 3); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const sx = L * (0.3 - i * 0.32);
        ctx.fillStyle = col; rr(ctx, sx - L * 0.13, -Wd / 2, L * 0.26, Wd, 2); ctx.fill();    // hopper
        ctx.fillStyle = '#8a929c'; ctx.beginPath(); ctx.arc(sx, 0, Wd * 0.18, 0, 7); ctx.fill();   // ore heap
        if (i < 2) { ctx.strokeStyle = '#3a3d42'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx - L * 0.13, 0); ctx.lineTo(sx - L * 0.19, 0); ctx.stroke(); }   // coupler
      }
      return;
    }
    if (style === 'origami') {                    // an accordion paper-boat ferry
      const L = es * 0.98, Wd = es * 0.38;
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.5, Wd * 0.45, 0, 0, 7); ctx.fill();
      ctx.fillStyle = col;                                                                    // long pleated concertina hull
      ctx.beginPath(); ctx.moveTo(L * 0.5, 0); ctx.lineTo(-L * 0.5, -Wd * 0.5); ctx.lineTo(-L * 0.5, Wd * 0.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1.4;                              // accordion crease ridges
      for (let i = 1; i < 5; i++) { const cx2 = L * 0.5 - i * L * 0.2; ctx.beginPath(); ctx.moveTo(cx2, -Wd * 0.5 * (1 - i / 6)); ctx.lineTo(cx2, Wd * 0.5 * (1 - i / 6)); ctx.stroke(); }
      return;
    }
    if (style === 'cinderhauler') {               // a slag tanker
      const L = es * 0.95, Wd = es * 0.36;
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 4); ctx.fill();
      ctx.fillStyle = col; rr(ctx, -L / 2, -Wd / 2, L * 0.3, Wd, 4); ctx.fill();        // cab
      ctx.fillStyle = '#6b6259'; ctx.beginPath(); ctx.ellipse(L * 0.12, 0, L * 0.4, Wd * 0.46, 0, 0, 7); ctx.fill();   // steel tank (pops on dark road)
      ctx.save(); ctx.shadowBlur = 6; ctx.shadowColor = '#ff7a1e';
      ctx.fillStyle = `rgba(255,140,40,${0.55 + 0.2 * Math.sin(t * 5 + c.x)})`;         // molten seam glow
      ctx.beginPath(); ctx.ellipse(L * 0.12, 0, L * 0.3, Wd * 0.3, 0, 0, 7); ctx.fill();
      ctx.restore();
      return;
    }
    if (style === 'gumdrop') {                    // a candy train
      const L = es * 0.98, Wd = es * 0.34;
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.5, Wd * 0.6, 0, 0, 7); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const segx = L * (0.32 - i * 0.32);
        ctx.fillStyle = i % 2 ? '#ffd24d' : col;
        ctx.beginPath(); ctx.ellipse(segx, 0, L * 0.16, Wd * 0.55, 0, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.ellipse(segx + L * 0.04, -Wd * 0.18, L * 0.06, Wd * 0.14, 0, 0, 7); ctx.fill();
      }
      return;
    }
    if (style === 'windup') {                     // a pull-along toy train
      const L = es * 0.95, Wd = es * 0.38;
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 4); ctx.fill();
      ctx.fillStyle = col; rr(ctx, L * 0.05, -Wd / 2, L * 0.45, Wd, 4); ctx.fill();      // engine
      ctx.fillStyle = '#ff5d5d'; rr(ctx, -L * 0.48, -Wd * 0.4, L * 0.4, Wd * 0.8, 3); ctx.fill();   // carriage
      ctx.fillStyle = '#3a2616'; ctx.beginPath(); ctx.arc(L * 0.42, 0, Wd * 0.18, 0, 7); ctx.fill();    // funnel
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; rr(ctx, L * 0.1, -Wd * 0.28, L * 0.16, Wd * 0.56, 2); ctx.fill();   // windows
      return;
    }
    if (style === 'fish') {                       // a whale (top-down)
      const fl = es * 1.0, fw = es * 0.6;
      ctx.fillStyle = 'rgba(10,40,60,0.22)';
      ctx.beginPath(); ctx.ellipse(1, 2, fl * 0.5, fw * 0.5, 0, 0, 7); ctx.fill();
      const wig = Math.sin(t * 5 + c.x) * fw * 0.12;
      ctx.fillStyle = col;
      ctx.beginPath();                            // tail flukes (flat, top-down)
      ctx.moveTo(-fl * 0.4, wig);
      ctx.lineTo(-fl * 0.6, -fw * 0.5); ctx.lineTo(-fl * 0.5, 0); ctx.lineTo(-fl * 0.6, fw * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, fl * 0.5, fw * 0.5, 0, 0, 7); ctx.fill();   // body
      ctx.beginPath(); ctx.ellipse(0, -fw * 0.5, fl * 0.16, fw * 0.12, -0.4, 0, 7); ctx.fill();  // flippers
      ctx.beginPath(); ctx.ellipse(0, fw * 0.5, fl * 0.16, fw * 0.12, 0.4, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';   // lighter back
      ctx.beginPath(); ctx.ellipse(fl * 0.05, 0, fl * 0.42, fw * 0.22, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(200,240,255,0.7)';    // blowhole
      ctx.beginPath(); ctx.arc(fl * 0.28, 0, fw * 0.06, 0, 7); ctx.fill();
      return;
    }
    if (style === 'bird') {                       // a passenger airship / zeppelin
      const L = es * 1.05, Wd = es * 0.42;
      ctx.fillStyle = 'rgba(20,40,70,0.16)';
      ctx.beginPath(); ctx.ellipse(1, 3, L * 0.5, Wd * 0.45, 0, 0, 7); ctx.fill();
      ctx.fillStyle = col;                        // envelope
      ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, Wd * 0.5, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.12)';         // shaded nose cap
      ctx.beginPath(); ctx.ellipse(L * 0.38, 0, L * 0.1, Wd * 0.48, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(180,120,90,0.55)';    // accent stripe down the spine
      ctx.fillRect(-L * 0.42, -Wd * 0.06, L * 0.84, Wd * 0.12);
      ctx.fillStyle = col;                        // tail fins
      ctx.beginPath(); ctx.moveTo(-L * 0.42, 0); ctx.lineTo(-L * 0.6, -Wd * 0.55); ctx.lineTo(-L * 0.42, -Wd * 0.14); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-L * 0.42, 0); ctx.lineTo(-L * 0.6,  Wd * 0.55); ctx.lineTo(-L * 0.42,  Wd * 0.14); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#3a4250';                  // gondola (passenger cabin)
      rr(ctx, -L * 0.2, -Wd * 0.17, L * 0.4, Wd * 0.34, Wd * 0.1); ctx.fill();
      ctx.fillStyle = 'rgba(180,220,255,0.7)';    // windows
      for (let i = 0; i < 4; i++) ctx.fillRect(-L * 0.14 + i * L * 0.09, -Wd * 0.05, L * 0.05, Wd * 0.1);
      return;
    }
    if (style === 'hover') {                      // long glowing transit pod (top-down)
      const L = es * 0.98, Wd = es * 0.36;
      const glow = 0.4 + 0.25 * Math.sin(t * 6 + c.x);
      ctx.fillStyle = `rgba(120,240,255,${glow})`;
      ctx.beginPath(); ctx.ellipse(0, 0, L * 0.55, Wd * 0.55, 0, 0, 7); ctx.fill();
      ctx.fillStyle = col; rr(ctx, -L / 2, -Wd / 2, L, Wd, Wd * 0.5); ctx.fill();
      ctx.fillStyle = 'rgba(20,40,60,0.6)';       // canopy strip down the spine
      rr(ctx, -L * 0.34, -Wd * 0.22, L * 0.68, Wd * 0.44, Wd * 0.2); ctx.fill();
      ctx.fillStyle = `rgba(120,240,255,${0.6 + 0.3 * Math.sin(t * 9 + c.x)})`;
      ctx.beginPath(); ctx.arc(-L * 0.46, 0, es * 0.05, 0, 7); ctx.fill();
      return;
    }
    // default — a bus / tram / cargo rover (London's is red = double-decker)
    const L = es * 0.95, Wd = es * 0.36;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(ctx, -L / 2 + 1, -Wd / 2 + 2, L, Wd, 4); ctx.fill();
    ctx.fillStyle = col; rr(ctx, -L / 2, -Wd / 2, L, Wd, 5); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';        // roof panel
    rr(ctx, -L / 2 + L * 0.06, -Wd * 0.3, L * 0.78, Wd * 0.6, 3); ctx.fill();
    ctx.fillStyle = 'rgba(20,30,45,0.55)';           // side windows (both edges)
    for (let i = 0; i < 5; i++) {
      const wx = -L * 0.36 + i * L * 0.16;
      ctx.fillRect(wx, -Wd / 2 + 2, L * 0.1, Wd * 0.12);
      ctx.fillRect(wx, Wd / 2 - 2 - Wd * 0.12, L * 0.1, Wd * 0.12);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.22)';        // centre roof stripe
    ctx.fillRect(-L / 2 + 2, -1.5, L - 4, 3);
    ctx.fillStyle = 'rgba(180,220,255,0.7)';         // windshield (front)
    rr(ctx, L / 2 - L * 0.09, -Wd / 2 + 3, L * 0.06, Wd - 6, 2); ctx.fill();
  }

  // A blinking red siren (road vehicles) — only while heading to or
  // working a pothole; off when parked or returning.
  function drawSiren(tr, t, sx, sy) {
    const on = (tr.state === 'driving' || tr.state === 'patching') && (t % 0.5 < 0.25);
    ctx.fillStyle = on ? '#ff4d4d' : '#7a2a2a';
    if (on) { ctx.save(); ctx.shadowBlur = 8; ctx.shadowColor = '#ff5050'; }
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, es * 0.055), 0, 7); ctx.fill();
    if (on) ctx.restore();
  }
  // An amber beacon for non-siren rigs (balloon, drill, teleporter) — same on-job blink.
  function drawBeacon(tr, t, bx, by) {
    const on = (tr.state === 'driving' || tr.state === 'patching') && (t % 0.5 < 0.25);
    ctx.fillStyle = on ? '#ffd14a' : '#7a6a2a';
    if (on) { ctx.save(); ctx.shadowBlur = 8; ctx.shadowColor = '#ffd14a'; }
    ctx.beginPath(); ctx.arc(bx, by, Math.max(1.5, es * 0.045), 0, 7); ctx.fill();
    if (on) ctx.restore();
  }

  // ---- Per-vehicle top-down sprites (forward = +x, already rotated) ----
  // Basic truck (adv=false) and the longer Advanced truck (adv=true): an
  // orange flatbed at the rear, a protruding cab at the front.
  function drawTruckTD(tr, t, adv) {
    const L = es * (adv ? 0.82 : 0.56), Wd = es * (adv ? 0.32 : 0.30);
    const bedFront = L * 0.14;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    rr(ctx, -L / 2 + 2, -Wd / 2 + 3, L, Wd, 5); ctx.fill();
    ctx.fillStyle = adv ? '#ff8a1a' : '#ff7a1a';                  // flatbed
    rr(ctx, -L / 2, -Wd / 2, bedFront + L / 2, Wd, 5); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';                          // side rails
    ctx.fillRect(-L / 2, -Wd / 2, bedFront + L / 2, Wd * 0.12);
    ctx.fillRect(-L / 2, Wd / 2 - Wd * 0.12, bedFront + L / 2, Wd * 0.12);
    ctx.fillStyle = '#2b2b30';                                   // asphalt load
    rr(ctx, -L / 2 + L * 0.08, -Wd * 0.28, L * (adv ? 0.42 : 0.34), Wd * 0.56, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    rr(ctx, -L / 2 + L * 0.08, -Wd * 0.28, L * (adv ? 0.42 : 0.34), Wd * 0.24, 3); ctx.fill();
    for (let i = 0; i < (adv ? 4 : 3); i++) {                    // hazard chevrons
      ctx.fillStyle = i % 2 === 0 ? '#16181c' : '#ffc62e';
      ctx.fillRect(-L / 2 + i * 4, -Wd / 2 + 2, 4, Wd - 4);
    }
    if (adv) {                                                   // jointed crane arm (two parts)
      ctx.fillStyle = '#caa14a';
      thickSeg(ctx, -L * 0.08, 0, -L * 0.16, -Wd * 0.6, Wd * 0.16);
      thickSeg(ctx, -L * 0.16, -Wd * 0.6, -L * 0.02, -Wd * 0.95, Wd * 0.12);
      ctx.beginPath(); ctx.arc(-L * 0.16, -Wd * 0.6, Wd * 0.09, 0, 7); ctx.fill();
    }
    const cabW = Wd * 0.84, cabL = L * 0.36;
    ctx.fillStyle = adv ? '#3a4250' : '#2e3440';                 // cab
    rr(ctx, bedFront, -cabW / 2, cabL, cabW, 4); ctx.fill();
    ctx.fillStyle = '#23262b';                                   // mirrors
    ctx.fillRect(bedFront + cabL * 0.18, -cabW / 2 - 3, 4, 3);
    ctx.fillRect(bedFront + cabL * 0.18, cabW / 2, 4, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    rr(ctx, bedFront + L * 0.04, -cabW / 2 + 3, cabL - L * 0.12, cabW - 6, 3); ctx.fill();
    ctx.fillStyle = '#9fd8ff';                                   // windshield
    rr(ctx, bedFront + cabL - L * 0.1, -cabW / 2 + 3, L * 0.06, cabW - 6, 2); ctx.fill();
    drawSiren(tr, t, bedFront + cabL * 0.45, 0);
  }

  // Magma Crawler (Embervale) — top-down tracked crawler with a glowing core.
  function drawMagmaTD(tr, t) {
    const L = es * 0.66, Wd = es * 0.36;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(ctx, -L / 2 + 2, -Wd / 2 + 3, L, Wd, 5); ctx.fill();
    ctx.fillStyle = '#26282d';                                   // treads down both sides
    rr(ctx, -L * 0.46, -Wd * 0.5, L * 0.92, Wd * 0.16, 2); ctx.fill();
    rr(ctx, -L * 0.46, Wd * 0.34, L * 0.92, Wd * 0.16, 2); ctx.fill();
    ctx.fillStyle = '#3a3d42';
    for (let i = 0; i < 6; i++) { ctx.fillRect(-L * 0.44 + i * L * 0.16, -Wd * 0.5, L * 0.05, Wd * 0.16); ctx.fillRect(-L * 0.44 + i * L * 0.16, Wd * 0.34, L * 0.05, Wd * 0.16); }
    ctx.fillStyle = '#4a423c'; rr(ctx, -L * 0.42, -Wd * 0.34, L * 0.84, Wd * 0.68, 4); ctx.fill();   // dark body
    ctx.save(); ctx.shadowBlur = 8; ctx.shadowColor = '#ff7a1e';                                      // glowing magma core
    ctx.fillStyle = `rgba(255,140,40,${0.7 + 0.2 * Math.sin(t * 6)})`; rr(ctx, -L * 0.28, -Wd * 0.12, L * 0.4, Wd * 0.24, 3); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#ff8a3a'; rr(ctx, L * 0.12, -Wd * 0.32, L * 0.3, Wd * 0.64, 3); ctx.fill();      // bright cab (front)
    ctx.fillStyle = '#bfe9ff'; rr(ctx, L * 0.3, -Wd * 0.28, L * 0.08, Wd * 0.56, 2); ctx.fill();      // windshield
    drawSiren(tr, t, L * 0.24, 0);
  }

  // Candy Rig (Candytown) — top-down glossy candy truck carrying gumdrops.
  function drawCandyRigTD(tr, t) {
    const L = es * 0.6, Wd = es * 0.32;
    ctx.fillStyle = 'rgba(0,0,0,0.26)'; rr(ctx, -L / 2 + 2, -Wd / 2 + 3, L, Wd, Wd * 0.4); ctx.fill();
    ctx.fillStyle = '#ff7ab0'; rr(ctx, -L / 2, -Wd / 2, L, Wd, Wd * 0.4); ctx.fill();                 // glossy candy body
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; rr(ctx, -L * 0.4, -Wd * 0.4, L * 0.7, Wd * 0.2, Wd * 0.1); ctx.fill();   // gloss stripe
    for (const g of [[-L * 0.3, '#9b6bff'], [-L * 0.12, '#ffd24d'], [L * 0.02, '#7ad0ff']]) {        // gumdrop load
      ctx.fillStyle = g[1]; ctx.beginPath(); ctx.arc(g[0], 0, Wd * 0.16, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#bfe9ff'; rr(ctx, L * 0.28, -Wd * 0.3, L * 0.1, Wd * 0.6, 2); ctx.fill();        // windshield (front)
    drawSiren(tr, t, L * 0.22, 0);
  }

  // Clockwork Rig (Toy Town) — top-down tin truck with a wind-up key on the roof.
  function drawClockworkTD(tr, t) {
    const L = es * 0.6, Wd = es * 0.32;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(ctx, -L / 2 + 2, -Wd / 2 + 3, L, Wd, 4); ctx.fill();
    ctx.fillStyle = '#5d9fe8'; rr(ctx, -L / 2, -Wd / 2, L, Wd, 4); ctx.fill();                        // tin body
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; rr(ctx, -L * 0.42, -Wd * 0.36, L * 0.84, Wd * 0.16, 2); ctx.fill();   // tin shine
    ctx.fillStyle = '#ff5d5d'; rr(ctx, -L * 0.44, -Wd * 0.3, L * 0.34, Wd * 0.6, 3); ctx.fill();      // red bed
    ctx.fillStyle = '#bfe9ff'; rr(ctx, L * 0.28, -Wd * 0.3, L * 0.1, Wd * 0.6, 2); ctx.fill();        // windshield (front)
    ctx.strokeStyle = '#e8c044'; ctx.lineWidth = Math.max(1.5, es * 0.04);                            // wind-up key on roof
    ctx.beginPath(); ctx.arc(-L * 0.05, 0, Wd * 0.18, 0, 7); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-L * 0.05 - Wd * 0.18, 0); ctx.lineTo(-L * 0.05 + Wd * 0.18, 0);
    ctx.moveTo(-L * 0.05, -Wd * 0.18); ctx.lineTo(-L * 0.05, Wd * 0.18); ctx.stroke();
    drawSiren(tr, t, L * 0.22, 0);
  }

  // Bog Skiff (Mirewood) — top-down fan-boat: flat hull + a big caged rear fan.
  function drawSkiffTD(tr, t) {
    const L = es * 0.62, Wd = es * 0.34;
    ctx.fillStyle = 'rgba(10,20,15,0.28)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.52, Wd * 0.55, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#caa46a';                                                            // flat skiff hull
    ctx.beginPath(); ctx.moveTo(L * 0.52, 0); ctx.lineTo(L * 0.05, -Wd * 0.5); ctx.lineTo(-L * 0.4, -Wd * 0.42); ctx.lineTo(-L * 0.4, Wd * 0.42); ctx.lineTo(L * 0.05, Wd * 0.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#3a2e20'; rr(ctx, -L * 0.2, -Wd * 0.24, L * 0.26, Wd * 0.48, 2); ctx.fill();   // bench / patch kit
    ctx.fillStyle = '#2a2d33'; ctx.beginPath(); ctx.arc(-L * 0.42, 0, Wd * 0.48, 0, 7); ctx.fill();  // fan cage
    ctx.strokeStyle = 'rgba(220,230,225,0.9)'; ctx.lineWidth = Math.max(1.3, es * 0.03);             // spinning blades
    const sp = (tr.state === 'driving' ? t * 36 : t * 12) + tr.x;
    for (let i = 0; i < 3; i++) { const a = sp + i * 2.1; ctx.beginPath(); ctx.moveTo(-L * 0.42, 0); ctx.lineTo(-L * 0.42 + Math.cos(a) * Wd * 0.42, Math.sin(a) * Wd * 0.42); ctx.stroke(); }
    drawSiren(tr, t, L * 0.2, 0);
  }

  // Paper Crane (Foldhaven) — a flying folded origami crane (top-down, casts a shadow).
  function drawPaperCraneTD(tr, t) {
    const L = es * 0.62, Wd = es * 0.4;
    ctx.fillStyle = 'rgba(40,30,20,0.16)'; ctx.beginPath(); ctx.ellipse(2, 4, L * 0.42, Wd * 0.3, 0, 0, 7); ctx.fill();   // shadow below
    const flap = Math.sin(t * 6 + tr.x) * 0.18;
    ctx.fillStyle = '#fff8ee';                                                            // folded wings
    for (const sgn of [-1, 1]) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-L * 0.3, sgn * Wd * (0.5 + flap)); ctx.lineTo(L * 0.1, sgn * Wd * 0.18); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = '#f0e8d8'; ctx.beginPath(); ctx.moveTo(L * 0.5, 0); ctx.lineTo(-L * 0.42, -Wd * 0.14); ctx.lineTo(-L * 0.42, Wd * 0.14); ctx.closePath(); ctx.fill();   // body
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L * 0.5, 0); ctx.lineTo(-L * 0.42, 0); ctx.stroke();   // crease
    ctx.fillStyle = '#e8806b'; ctx.beginPath(); ctx.moveTo(L * 0.5, 0); ctx.lineTo(L * 0.32, -Wd * 0.08); ctx.lineTo(L * 0.32, Wd * 0.08); ctx.closePath(); ctx.fill();   // beak
    drawBeacon(tr, t, -L * 0.1, 0);
  }

  // The Drill (forward = +x). While tunnelling (driving/returning) it's under
  // the map: only a churning dirt mound + a poking, spinning bit show, with the
  // particle trail (emitted in game.js) drifting above ground. Surfaced
  // (parked / patching) the whole rig is drawn: big body + a bigger drill bit.
  function drawDrillTD(tr, t) {
    const digging = (tr.state === 'driving' || tr.state === 'returning');
    if (digging) {
      const r = es * 0.28;
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath(); ctx.ellipse(0, 0, r * 1.2, r * 0.85, 0, 0, 7); ctx.fill();
      const tones = ['#8a6a3a', '#a8814a', '#6f5630'];
      for (let i = 0; i < 6; i++) {                              // churning dirt mound
        const a = i / 6 * Math.PI * 2 + t * 2.2;
        ctx.fillStyle = tones[i % 3];
        ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.4, r * 0.52, 0, 7); ctx.fill();
      }
      return;
    }
    // surfaced: big body
    const L = es * 0.74, Wd = es * 0.42;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(ctx, -L / 2 + 2, -Wd / 2 + 3, L * 0.82, Wd, 5); ctx.fill();
    ctx.fillStyle = '#c98a3a'; rr(ctx, -L * 0.5, -Wd * 0.46, L * 0.78, Wd * 0.92, 5); ctx.fill();   // body
    ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(-L * 0.5, Wd * 0.28, L * 0.78, Wd * 0.18);      // belly shade
    for (let i = 0; i < 3; i++) {                                // hazard stripes at the back
      ctx.fillStyle = i % 2 === 0 ? '#16181c' : '#ffc62e';
      ctx.fillRect(-L * 0.5 + i * 4, -Wd * 0.46, 4, Wd * 0.92);
    }
    ctx.fillStyle = '#9fd8ff'; rr(ctx, -L * 0.34, -Wd * 0.22, L * 0.2, Wd * 0.44, 2); ctx.fill();    // cockpit
    // big drill bit at the front (a cone with animated helical flutes)
    const bx = L * 0.28, tip = L * 0.66, br = Wd * 0.5;
    ctx.fillStyle = '#7d8590'; rr(ctx, bx - Wd * 0.08, -br, Wd * 0.16, br * 2, 2); ctx.fill();        // collar
    ctx.fillStyle = '#b8bfc7';
    ctx.beginPath(); ctx.moveTo(tip, 0); ctx.lineTo(bx, -br); ctx.lineTo(bx, br); ctx.closePath(); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.moveTo(tip, 0); ctx.lineTo(bx, -br); ctx.lineTo(bx, br); ctx.closePath(); ctx.clip();
    ctx.strokeStyle = 'rgba(60,66,74,0.7)'; ctx.lineWidth = Math.max(1.5, es * 0.03);
    const ph = (tr.state === 'patching' ? t * 7 : t * 1.2) % 1;
    for (let i = -3; i <= 3; i++) { const o = (i + ph) * br * 0.5; ctx.beginPath(); ctx.moveTo(bx, o); ctx.lineTo(tip, o + br * 0.5); ctx.stroke(); }
    ctx.restore();
    drawBeacon(tr, t, -L * 0.1, -Wd * 0.5);
  }

  // ---- Teleporter warp FX (top-down): a circular pool of blue light cast
  // straight down on the spot, with concentric rings rippling outward. Called
  // from drawTruck while a warp is in progress, in the truck's local frame.
  function drawTeleportBeam(tr, t) {
    const R = es * 0.55;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, 'rgba(150,235,255,0.55)');
    g.addColorStop(0.5, 'rgba(95,210,255,0.28)');
    g.addColorStop(1, 'rgba(80,200,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
    ctx.shadowBlur = 14; ctx.shadowColor = '#5fd0ff';
    ctx.strokeStyle = 'rgba(150,235,255,0.85)';
    ctx.lineWidth = Math.max(1.5, es * 0.04);
    for (let i = 0; i < 3; i++) {                 // pulsing concentric rings
      const ph = (t * 1.6 + i / 3) % 1;
      ctx.globalAlpha = (1 - ph) * 0.9;
      ctx.beginPath(); ctx.arc(0, 0, R * (0.25 + ph * 0.75), 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // pod scale through the warp: shrinks to nothing as it beams out (first half),
  // grows back from nothing as it beams in at the destination (second half)
  function teleScale(tr) {
    const dur = tr.teleMax || 1, half = dur / 2;
    if (tr.teleT > half) return Math.max(0, (tr.teleT - half) / half);
    return Math.max(0, 1 - tr.teleT / half);
  }

  function drawBalloonTD(tr, t) {
    const r = es * 0.34;
    ctx.fillStyle = 'rgba(20,40,70,0.16)';
    ctx.beginPath(); ctx.ellipse(3, 4, r * 0.85, r * 0.85, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff6f7d'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(200,40,60,0.5)'; ctx.lineWidth = Math.max(1, es * 0.03);
    for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(-Math.cos(a) * r, -Math.sin(a) * r); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.arc(-r * 0.32, -r * 0.32, r * 0.3, 0, 7); ctx.fill();
    ctx.fillStyle = '#7a5230'; ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, 7); ctx.fill();   // basket (top-down)
    drawBeacon(tr, t, 0, -r * 0.85);
  }

  function drawSubTD(tr, t) {
    const L = es * 0.6, Wd = es * 0.3;
    ctx.fillStyle = 'rgba(10,40,60,0.22)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.5, Wd * 0.5, 0, 0, 7); ctx.fill();
    // animated propeller at the stern (a single spinning 3-blade screw, not
    // separate sticking-out fins) — drawn before the hull so it sits behind it
    ctx.save();
    ctx.translate(-L * 0.5, 0);
    ctx.rotate(t * 16);
    ctx.fillStyle = '#c9a23a';
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.beginPath(); ctx.ellipse(0, Wd * 0.2, Wd * 0.07, Wd * 0.22, 0, 0, 7); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#3a3d42'; ctx.beginPath(); ctx.arc(-L * 0.5, 0, Wd * 0.1, 0, 7); ctx.fill();   // prop hub
    ctx.fillStyle = '#ffcf3d'; ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, Wd * 0.5, 0, 0, 7); ctx.fill();   // hull
    ctx.fillStyle = '#caa12a'; ctx.beginPath(); ctx.ellipse(-L * 0.05, 0, L * 0.16, Wd * 0.42, 0, 0, 7); ctx.fill();   // conning tower
    ctx.fillStyle = '#bfe9ff'; ctx.beginPath(); ctx.arc(L * 0.3, 0, Wd * 0.12, 0, 7); ctx.fill();   // front porthole
    drawSiren(tr, t, L * 0.06, 0);
  }

  function drawBuggyTD(tr, t) {
    const L = es * 0.56, Wd = es * 0.34;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(1, 2, L * 0.55, Wd * 0.55, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#26282d';                                   // corner wheels
    const wL = L * 0.18, wW = Wd * 0.22;
    for (const sx of [-0.32, 0.32]) for (const sy of [-0.5, 0.5]) { rr(ctx, sx * L - wL / 2, sy * Wd - wW / 2, wL, wW, 2); ctx.fill(); }
    ctx.fillStyle = '#d8dde4'; rr(ctx, -L * 0.42, -Wd * 0.34, L * 0.84, Wd * 0.68, 3); ctx.fill();   // chassis
    ctx.fillStyle = 'rgba(40,60,90,0.6)'; rr(ctx, -L * 0.26, -Wd * 0.24, L * 0.36, Wd * 0.48, 2); ctx.fill();
    ctx.fillStyle = '#2d5a8a'; rr(ctx, -L * 0.4, -Wd * 0.3, L * 0.16, Wd * 0.6, 2); ctx.fill();       // solar panel
    const ext = tr.state === 'patching' ? L * 0.3 : L * 0.12;    // arm extends to patch
    ctx.strokeStyle = '#caa14a'; ctx.lineWidth = Math.max(2, es * 0.05);
    ctx.beginPath(); ctx.moveTo(L * 0.3, 0); ctx.lineTo(L * 0.3 + ext, 0); ctx.stroke();
    ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.arc(L * 0.3 + ext, 0, es * 0.045, 0, 7); ctx.fill();
    drawSiren(tr, t, 0, 0);
  }

  // The Teleporter (forward = +x): a round pod with a glowing glass dome and a
  // forward antenna. Round, so its facing barely reads — the warp beam (drawn
  // in drawTruck) carries the drama.
  function drawTeleporterTD(tr, t) {
    const r = es * 0.24;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(1, 2, r * 1.05, r * 1.05, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#c4c4cc'; ctx.fillRect(r * 0.7, -es * 0.02, r * 0.4, es * 0.04);   // antenna mast
    ctx.fillStyle = '#ff5f5f'; ctx.beginPath(); ctx.arc(r * 1.12, 0, es * 0.045, 0, 7); ctx.fill();
    ctx.fillStyle = '#3a4250'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();      // pod ring
    ctx.fillStyle = '#2a313c'; ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(120,225,255,0.6)'; ctx.beginPath(); ctx.arc(0, 0, r * 0.56, 0, 7); ctx.fill();   // glass dome
    ctx.fillStyle = 'rgba(205,245,255,0.75)'; ctx.beginPath(); ctx.arc(-r * 0.18, -r * 0.18, r * 0.18, 0, 7); ctx.fill();
    ctx.strokeStyle = '#5fd0ff'; ctx.lineWidth = Math.max(1.5, es * 0.04);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, 7); ctx.stroke();                          // neon ring
    drawBeacon(tr, t, 0, -r * 0.16);
  }

  function drawTruck(tr, t) {
    const x = tx2px(tr.x), y = ty2px(tr.y);
    const selected = PP.Game.selectedTruck === tr ||
      (PP.Game.drag && PP.Game.drag.truck === tr);

    ctx.save();
    ctx.translate(x, y);

    if (selected) {     // pulsing selection ring
      ctx.strokeStyle = `rgba(255,198,46,${0.6 + 0.4 * Math.sin(t * 8)})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -t * 25;
      ctx.beginPath(); ctx.arc(0, 0, es * 0.42, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    } else if (tr.state === 'parked') {   // soft "available" halo at the depot
      ctx.strokeStyle = 'rgba(62,207,142,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, es * 0.38, 0, 7); ctx.stroke();
    }

    // teleporter mid-warp: the beam from the sky, with the pod scaling out / in
    if (tr.vehType === 'teleporter' && tr.teleT > 0) {
      drawTeleportBeam(tr, t);
      const s = teleScale(tr);
      if (s < 0.03) { ctx.restore(); return; }   // fully beamed out: only the beam shows
      ctx.scale(s, s);
    }

    ctx.rotate(tr.angle);
    switch (tr.vehType) {
      case 'advanced': drawTruckTD(tr, t, true); break;
      case 'drill': drawDrillTD(tr, t); break;
      case 'balloon': drawBalloonTD(tr, t); break;
      case 'sub': drawSubTD(tr, t); break;
      case 'buggy': drawBuggyTD(tr, t); break;
      case 'teleporter': drawTeleporterTD(tr, t); break;
      case 'magma': drawMagmaTD(tr, t); break;
      case 'candyrig': drawCandyRigTD(tr, t); break;
      case 'clockwork': drawClockworkTD(tr, t); break;
      case 'skiff': drawSkiffTD(tr, t); break;
      case 'papercrane': drawPaperCraneTD(tr, t); break;
      default: drawTruckTD(tr, t, false);   // 'basic'
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Side-view illustrations — used by the Your Fleet cards and the Hire
  // carousel (drawn into arbitrary 2D contexts, not the game canvas).
  // `opts.silhouette` recolours the whole drawing solid black (locked
  // vehicles in the carousel). Forward = +x (vehicles face right).
  // ------------------------------------------------------------------
  function drawVehicleSide(c, type, w, h, opts) {
    opts = opts || {};
    c.clearRect(0, 0, w, h);
    c.save();
    c.translate(w / 2, h * 0.56);
    const u = Math.min(w, h) * 0.42;
    if (!opts.silhouette) {                 // soft ground shadow
      c.fillStyle = 'rgba(0,0,0,0.16)';
      c.beginPath(); c.ellipse(0, u * 0.82, u * 1.15, u * 0.18, 0, 0, 7); c.fill();
    }
    const wheel = (wx, r) => {
      c.fillStyle = '#1c1e22'; c.beginPath(); c.arc(wx, u * 0.55, r, 0, 7); c.fill();
      c.fillStyle = '#4a5058'; c.beginPath(); c.arc(wx, u * 0.55, r * 0.45, 0, 7); c.fill();
    };
    switch (type) {
      case 'advanced': {
        // long truck: a long body + a tall front cab compartment
        wheel(-u * 0.9, u * 0.2); wheel(-u * 0.3, u * 0.2); wheel(u * 0.62, u * 0.2);
        c.fillStyle = '#ff8a1a'; rr(c, -u * 1.25, -u * 0.4, u * 1.5, u * 0.8, u * 0.07); c.fill();        // body (tallest)
        c.fillStyle = '#16181c'; for (let i = 0; i < 5; i++) c.fillRect(-u * 1.16 + i * u * 0.22, u * 0.18, u * 0.1, u * 0.22);   // chevrons
        // jointed crane arm — two parts
        c.fillStyle = '#caa14a';
        thickSeg(c, -u * 0.35, -u * 0.18, -u * 0.5, -u * 0.66, u * 0.13);
        thickSeg(c, -u * 0.5, -u * 0.66, -u * 0.12, -u * 0.9, u * 0.11);
        c.beginPath(); c.arc(-u * 0.5, -u * 0.66, u * 0.08, 0, 7); c.fill();      // elbow joint
        c.beginPath(); c.arc(-u * 0.12, -u * 0.9, u * 0.06, 0, 7); c.fill();      // arm tip
        // front cab compartment (shorter than the body), overlapping the body
        // so it joins cleanly; siren on top
        c.fillStyle = '#3a4250'; rr(c, u * 0.14, -u * 0.2, u * 0.7, u * 0.6, u * 0.08); c.fill();
        c.fillStyle = '#9fd8ff'; rr(c, u * 0.28, -u * 0.12, u * 0.42, u * 0.28, u * 0.05); c.fill();      // window
        c.fillStyle = '#ff4d4d'; rr(c, u * 0.36, -u * 0.34, u * 0.2, u * 0.15, u * 0.03); c.fill();       // siren on cab
        break;
      }
      case 'drill': {
        // tracked treads, a big body, and a large drill cone out the front
        c.fillStyle = '#1c1e22'; rr(c, -u * 0.92, u * 0.34, u * 1.16, u * 0.3, u * 0.1); c.fill();   // tread
        c.fillStyle = '#4a5058'; for (let i = 0; i < 6; i++) { c.fillRect(-u * 0.86 + i * u * 0.2, u * 0.38, u * 0.06, u * 0.22); }
        c.fillStyle = '#c98a3a'; rr(c, -u * 0.95, -u * 0.5, u * 1.26, u * 0.92, u * 0.08); c.fill();  // body (tallest)
        c.fillStyle = '#16181c'; for (let i = 0; i < 4; i++) c.fillRect(-u * 0.88 + i * u * 0.2, u * 0.16, u * 0.09, u * 0.24);   // chevrons
        c.fillStyle = '#9fd8ff'; rr(c, -u * 0.56, -u * 0.4, u * 0.42, u * 0.34, u * 0.05); c.fill();  // cab window
        // big drill bit out the front (cone + helical flutes)
        const bx = u * 0.3, tip = u * 1.2, br = u * 0.5;
        c.fillStyle = '#7d8590'; rr(c, bx - u * 0.07, -br, u * 0.14, br * 2, u * 0.03); c.fill();      // collar
        c.fillStyle = '#b8bfc7'; c.beginPath(); c.moveTo(tip, 0); c.lineTo(bx, -br); c.lineTo(bx, br); c.closePath(); c.fill();
        c.save(); c.beginPath(); c.moveTo(tip, 0); c.lineTo(bx, -br); c.lineTo(bx, br); c.closePath(); c.clip();
        c.strokeStyle = '#6b7178'; c.lineWidth = Math.max(1.5, u * 0.045);
        for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(bx, i * u * 0.24); c.lineTo(tip, i * u * 0.24 + u * 0.22); c.stroke(); }
        c.restore();
        break;
      }
      case 'balloon': {
        const cyb = -u * 0.35;
        c.fillStyle = '#ff6f7d'; c.beginPath(); c.arc(0, cyb, u * 0.62, 0, 7); c.fill();
        c.beginPath(); c.moveTo(-u * 0.45, cyb + u * 0.42); c.quadraticCurveTo(0, cyb + u * 1.0, u * 0.45, cyb + u * 0.42); c.closePath(); c.fill();
        c.fillStyle = '#ffd24d'; c.beginPath(); c.ellipse(0, cyb, u * 0.16, u * 0.62, 0, 0, 7); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.3)'; c.beginPath(); c.ellipse(-u * 0.32, cyb, u * 0.1, u * 0.55, 0, 0, 7); c.fill();
        c.strokeStyle = 'rgba(40,30,20,0.6)'; c.lineWidth = Math.max(1, u * 0.03);
        c.beginPath(); c.moveTo(-u * 0.2, cyb + u * 0.72); c.lineTo(-u * 0.13, u * 0.34); c.moveTo(u * 0.2, cyb + u * 0.72); c.lineTo(u * 0.13, u * 0.34); c.stroke();
        c.fillStyle = '#7a5230'; rr(c, -u * 0.16, u * 0.3, u * 0.32, u * 0.3, u * 0.04); c.fill();
        c.fillStyle = '#5e3f24'; c.fillRect(-u * 0.16, u * 0.3, u * 0.32, u * 0.06);
        break;
      }
      case 'sub': {
        // shaft + a tall thin propeller disc at the rear (facing LEFT, the
        // thrust axis), with a hub — not blades pointing up
        c.strokeStyle = '#3a3d42'; c.lineWidth = Math.max(2, u * 0.05); c.beginPath(); c.moveTo(-u * 0.9, 0); c.lineTo(-u * 1.06, 0); c.stroke();
        c.fillStyle = '#6b7178'; c.beginPath(); c.ellipse(-u * 1.08, 0, u * 0.07, u * 0.34, 0, 0, 7); c.fill();
        c.fillStyle = '#4a5058'; c.beginPath(); c.arc(-u * 1.08, 0, u * 0.08, 0, 7); c.fill();
        // teardrop hull: full-size rounded nose at the front, tapering to a
        // slim tail at the rear (no front spike)
        c.fillStyle = '#ffcf3d';
        c.beginPath();
        c.moveTo(-u * 0.95, u * 0.03);
        c.quadraticCurveTo(-u * 0.5, -u * 0.34, u * 0.2, -u * 0.4);
        c.quadraticCurveTo(u * 0.8, -u * 0.4, u * 0.95, u * 0.05);
        c.quadraticCurveTo(u * 0.8, u * 0.5, u * 0.2, u * 0.46);
        c.quadraticCurveTo(-u * 0.5, u * 0.4, -u * 0.95, u * 0.03);
        c.closePath(); c.fill();
        c.fillStyle = '#ffcf3d'; rr(c, -u * 0.12, -u * 0.52, u * 0.42, u * 0.42, u * 0.06); c.fill();   // conning tower
        c.strokeStyle = '#caa12a'; c.lineWidth = Math.max(1, u * 0.04); c.beginPath(); c.moveTo(u * 0.12, -u * 0.52); c.lineTo(u * 0.12, -u * 0.78); c.stroke();   // periscope
        c.fillStyle = '#bfe9ff'; for (const px of [-u * 0.32, u * 0.08, u * 0.46]) { c.beginPath(); c.arc(px, u * 0.06, u * 0.12, 0, 7); c.fill(); }
        c.fillStyle = '#3a6b85'; for (const px of [-u * 0.32, u * 0.08, u * 0.46]) { c.beginPath(); c.arc(px, u * 0.06, u * 0.06, 0, 7); c.fill(); }
        break;
      }
      case 'buggy': {
        c.fillStyle = '#2a2d33'; for (const wx of [-u * 0.62, u * 0.62]) { c.beginPath(); c.arc(wx, u * 0.45, u * 0.32, 0, 7); c.fill(); }
        c.fillStyle = '#5a626c'; for (const wx of [-u * 0.62, u * 0.62]) { c.beginPath(); c.arc(wx, u * 0.45, u * 0.14, 0, 7); c.fill(); }
        c.fillStyle = '#d8dde4'; rr(c, -u * 0.72, -u * 0.06, u * 1.44, u * 0.34, u * 0.06); c.fill();   // chassis
        c.strokeStyle = '#9aa0aa'; c.lineWidth = Math.max(2, u * 0.05);                                  // roll cage / seat
        c.beginPath(); c.moveTo(-u * 0.05, -u * 0.06); c.lineTo(u * 0.1, -u * 0.5); c.lineTo(u * 0.4, -u * 0.5); c.lineTo(u * 0.42, -u * 0.06); c.stroke();
        c.beginPath(); c.moveTo(-u * 0.45, -u * 0.06); c.lineTo(-u * 0.45, -u * 0.46); c.stroke();       // solar mast (real strut)
        c.fillStyle = '#2d5a8a'; rr(c, -u * 0.72, -u * 0.56, u * 0.55, u * 0.14, u * 0.02); c.fill();    // panel on the mast
        c.fillStyle = 'rgba(255,255,255,0.18)'; rr(c, -u * 0.72, -u * 0.56, u * 0.55, u * 0.06, u * 0.02); c.fill();
        c.strokeStyle = '#caa14a'; c.lineWidth = Math.max(2, u * 0.07); c.beginPath(); c.moveTo(u * 0.45, -u * 0.1); c.lineTo(u * 0.86, -u * 0.4); c.stroke();   // patch arm
        c.fillStyle = '#ff4d4d'; c.beginPath(); c.arc(u * 0.86, -u * 0.4, u * 0.07, 0, 7); c.fill();
        break;
      }
      case 'teleporter': {
        if (!opts.silhouette) { c.save(); c.shadowBlur = 14; c.shadowColor = '#5fd0ff'; c.fillStyle = 'rgba(95,210,255,0.3)'; c.beginPath(); c.ellipse(0, u * 0.62, u * 0.9, u * 0.16, 0, 0, 7); c.fill(); c.restore(); }
        // landing feet
        c.fillStyle = '#23272e'; c.fillRect(-u * 0.52, u * 0.42, u * 0.14, u * 0.22); c.fillRect(u * 0.38, u * 0.42, u * 0.14, u * 0.22);
        // pod body
        c.fillStyle = '#3a4250'; rr(c, -u * 0.72, -u * 0.06, u * 1.44, u * 0.52, u * 0.18); c.fill();
        c.fillStyle = '#2a313c'; rr(c, -u * 0.72, u * 0.2, u * 1.44, u * 0.22, u * 0.1); c.fill();
        c.fillStyle = '#5fd0ff'; c.fillRect(-u * 0.72, u * 0.04, u * 1.44, Math.max(2, u * 0.05));   // glow band
        // tall glass dome
        if (!opts.silhouette) c.fillStyle = 'rgba(120,225,255,0.5)'; else c.fillStyle = '#000';
        c.beginPath(); c.ellipse(0, -u * 0.04, u * 0.5, u * 0.72, 0, Math.PI, 0); c.fill();
        c.fillStyle = 'rgba(205,245,255,0.7)'; c.beginPath(); c.ellipse(-u * 0.16, -u * 0.34, u * 0.12, u * 0.24, 0, 0, 7); c.fill();
        c.strokeStyle = '#5fd0ff'; c.lineWidth = Math.max(1.5, u * 0.04);
        c.beginPath(); c.ellipse(0, -u * 0.04, u * 0.5, u * 0.72, 0, Math.PI, 0); c.stroke();
        // antenna
        c.strokeStyle = '#c4c4cc'; c.lineWidth = Math.max(1.5, u * 0.04);
        c.beginPath(); c.moveTo(0, -u * 0.76); c.lineTo(0, -u * 1.12); c.stroke();
        c.fillStyle = '#ff5f5f'; c.beginPath(); c.arc(0, -u * 1.14, u * 0.08, 0, 7); c.fill();
        break;
      }
      case 'magma': {
        c.fillStyle = '#1c1e22'; rr(c, -u * 0.82, u * 0.32, u * 1.5, u * 0.3, u * 0.1); c.fill();   // tread
        c.fillStyle = '#4a5058'; for (let i = 0; i < 6; i++) { c.fillRect(-u * 0.76 + i * u * 0.24, u * 0.37, u * 0.08, u * 0.2); }
        c.fillStyle = '#4a423c'; rr(c, -u * 0.78, -u * 0.32, u * 1.4, u * 0.66, u * 0.08); c.fill();   // body
        c.save(); c.shadowBlur = 9; c.shadowColor = '#ff7a1e';                                         // glowing vent
        c.fillStyle = '#ff8a2a'; rr(c, -u * 0.5, -u * 0.12, u * 0.46, u * 0.3, u * 0.05); c.fill(); c.restore();
        c.fillStyle = '#ff8a3a'; rr(c, u * 0.16, -u * 0.46, u * 0.46, u * 0.5, u * 0.06); c.fill();    // cab
        c.fillStyle = '#9fd8ff'; rr(c, u * 0.26, -u * 0.38, u * 0.28, u * 0.22, u * 0.04); c.fill();    // window
        c.fillStyle = '#ff4d4d'; rr(c, u * 0.32, -u * 0.6, u * 0.16, u * 0.12, u * 0.03); c.fill();     // siren
        break;
      }
      case 'candyrig': {
        wheel(-u * 0.5, u * 0.2); wheel(u * 0.52, u * 0.2);
        c.fillStyle = '#ff7ab0'; rr(c, -u * 0.82, -u * 0.4, u * 1.4, u * 0.8, u * 0.16); c.fill();      // glossy body
        c.fillStyle = 'rgba(255,255,255,0.4)'; rr(c, -u * 0.74, -u * 0.34, u * 1.0, u * 0.16, u * 0.08); c.fill();   // gloss
        for (const g of [[-u * 0.5, '#ffd24d'], [-u * 0.28, '#7ad0ff'], [-u * 0.06, '#9b6bff']]) {      // gumdrop load on the bed
          c.fillStyle = g[1]; c.beginPath(); c.arc(g[0], -u * 0.5, u * 0.14, 0, 7); c.fill();
        }
        c.fillStyle = '#9fd8ff'; rr(c, u * 0.26, -u * 0.24, u * 0.3, u * 0.32, u * 0.05); c.fill();      // window
        c.fillStyle = '#ff4d4d'; rr(c, u * 0.34, -u * 0.4, u * 0.16, u * 0.12, u * 0.03); c.fill();      // siren
        break;
      }
      case 'clockwork': {
        wheel(-u * 0.55, u * 0.24); wheel(u * 0.55, u * 0.24);
        c.fillStyle = '#5d9fe8'; rr(c, -u * 0.95, -u * 0.4, u * 1.7, u * 0.8, u * 0.07); c.fill();        // tin body
        c.fillStyle = 'rgba(255,255,255,0.4)'; rr(c, -u * 0.85, -u * 0.34, u * 1.2, u * 0.14, u * 0.04); c.fill();   // shine
        c.fillStyle = '#ff5d5d'; rr(c, -u * 0.85, -u * 0.28, u * 0.55, u * 0.55, u * 0.05); c.fill();      // red bed
        c.fillStyle = '#9fd8ff'; rr(c, u * 0.32, -u * 0.2, u * 0.32, u * 0.3, u * 0.05); c.fill();         // window
        c.strokeStyle = '#e8c044'; c.lineWidth = Math.max(2, u * 0.06);                                    // wind-up key
        c.beginPath(); c.moveTo(-u * 0.2, -u * 0.4); c.lineTo(-u * 0.2, -u * 0.72); c.stroke();
        c.beginPath(); c.arc(-u * 0.2, -u * 0.84, u * 0.12, 0, 7); c.stroke();
        c.fillStyle = '#ff4d4d'; rr(c, u * 0.4, -u * 0.4, u * 0.18, u * 0.14, u * 0.03); c.fill();         // siren
        break;
      }
      case 'skiff': {   // fan-boat: flat hull + a big caged rear propeller (side view)
        c.fillStyle = '#caa46a';                                                          // hull
        c.beginPath(); c.moveTo(u * 0.95, u * 0.1); c.lineTo(u * 0.2, -u * 0.34); c.lineTo(-u * 0.7, -u * 0.3); c.lineTo(-u * 0.85, u * 0.3); c.lineTo(u * 0.85, u * 0.32); c.closePath(); c.fill();
        c.fillStyle = '#3a2e20'; rr(c, -u * 0.2, -u * 0.5, u * 0.5, u * 0.3, u * 0.04); c.fill();   // seat/kit
        c.strokeStyle = '#2a2d33'; c.lineWidth = Math.max(2, u * 0.06);                    // fan cage
        c.beginPath(); c.arc(-u * 0.78, -u * 0.1, u * 0.5, 0, 7); c.stroke();
        c.strokeStyle = '#9aa0aa'; c.lineWidth = Math.max(1.5, u * 0.04);                  // blades
        for (let i = 0; i < 3; i++) { const a = i * 2.1; c.beginPath(); c.moveTo(-u * 0.78, -u * 0.1); c.lineTo(-u * 0.78 + Math.cos(a) * u * 0.46, -u * 0.1 + Math.sin(a) * u * 0.46); c.stroke(); }
        break;
      }
      case 'papercrane': {   // folded origami crane (side view, in flight)
        if (!opts.silhouette) { c.fillStyle = 'rgba(0,0,0,0.14)'; c.beginPath(); c.ellipse(0, u * 0.74, u * 0.7, u * 0.12, 0, 0, 7); c.fill(); }   // shadow
        c.fillStyle = '#fff8ee';                                                          // body wedge
        c.beginPath(); c.moveTo(u * 0.95, -u * 0.1); c.lineTo(-u * 0.85, -u * 0.45); c.lineTo(-u * 0.6, u * 0.2); c.closePath(); c.fill();
        c.fillStyle = '#f0e8d8';                                                          // raised wing
        c.beginPath(); c.moveTo(-u * 0.1, -u * 0.2); c.lineTo(u * 0.2, -u * 0.95); c.lineTo(u * 0.55, -u * 0.1); c.closePath(); c.fill();
        c.fillStyle = '#e8806b';                                                          // head + beak (up front)
        c.beginPath(); c.moveTo(u * 0.95, -u * 0.1); c.lineTo(u * 0.72, -u * 0.05); c.lineTo(u * 0.78, -u * 0.34); c.closePath(); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = Math.max(1, u * 0.03); c.beginPath(); c.moveTo(u * 0.95, -u * 0.1); c.lineTo(-u * 0.7, -u * 0.12); c.stroke();   // crease
        break;
      }
      default: {   // 'basic' — a tall body + a front cab compartment (shorter than the body)
        wheel(-u * 0.5, u * 0.22); wheel(u * 0.52, u * 0.22);
        c.fillStyle = '#ff7a1a'; rr(c, -u * 0.98, -u * 0.4, u * 1.16, u * 0.8, u * 0.07); c.fill();      // body (tallest)
        c.fillStyle = '#2b2b30'; rr(c, -u * 0.88, -u * 0.34, u * 0.6, u * 0.18, u * 0.04); c.fill();     // asphalt load
        c.fillStyle = '#2e3440'; rr(c, u * 0.16, -u * 0.2, u * 0.66, u * 0.6, u * 0.08); c.fill();        // cab (shorter than body)
        c.fillStyle = '#9fd8ff'; rr(c, u * 0.28, -u * 0.12, u * 0.42, u * 0.28, u * 0.05); c.fill();      // window
        c.fillStyle = '#ff4d4d'; rr(c, u * 0.36, -u * 0.34, u * 0.2, u * 0.15, u * 0.03); c.fill();       // siren on the cab
      }
    }
    c.restore();
    if (opts.silhouette) {   // recolour everything drawn so far solid black
      c.save();
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = '#0b0d10';
      c.fillRect(0, 0, w, h);
      c.restore();
    }
  }

  function drawDragLine(t) {
    const dg = PP.Game.drag;
    if (!dg || dg.x == null) return;
    const x1 = tx2px(dg.truck.x), y1 = ty2px(dg.truck.y);
    const x2 = tx2px(dg.x), y2 = ty2px(dg.y);
    ctx.strokeStyle = 'rgba(255,198,46,0.85)';
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -t * 30;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
    // highlight a droppable pothole under the finger
    const ph = PP.Game.potholeAt(dg.x, dg.y, Math.max(0.9, 30 / es));
    ctx.beginPath();
    if (ph) {
      ctx.strokeStyle = '#3ecf8e';
      ctx.arc(tx2px(ph.x), ty2px(ph.y), es * 0.42, 0, 7);
    } else {
      ctx.strokeStyle = 'rgba(244,239,230,0.6)';
      ctx.arc(x2, y2, es * 0.25, 0, 7);
    }
    ctx.stroke();
  }

  function drawParts(run) {
    for (const pt of run.parts) {
      const a = 1 - pt.t / pt.life;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(tx2px(pt.x), ty2px(pt.y), pt.r, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters(run) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of run.floaters) {
      const a = 1 - f.t / f.life;
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = `800 ${f.size}px 'Barlow Semi Condensed', sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#15171b';
      const X = tx2px(f.x), Y = ty2px(f.y);
      ctx.strokeText(f.text, X, Y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, X, Y);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Ambient atmosphere: a colour wash + drifting particles per location
  // (snow, petals, bubbles, stars, sparks, fog). Stateless — positions
  // are a pure function of index + time, so there's nothing to allocate.
  // ------------------------------------------------------------------
  function hash(i) { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); }

  function drawAtmosphere(th, t) {
    if (th.tint) { ctx.fillStyle = th.tint; ctx.fillRect(0, 0, W, H); }
    const fx = th.fx;
    if (!fx) return;
    const n = fx.n || 40;
    ctx.fillStyle = fx.color;
    if (fx.type === 'stars') {
      for (let i = 0; i < n; i++) {
        const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 2 + i * 1.7));
        ctx.globalAlpha = tw;
        ctx.beginPath();
        ctx.arc(hash(i) * W, hash(i + 99) * H, hash(i + 7) * 1.4 + 0.6, 0, 7);
        ctx.fill();
      }
    } else if (fx.type === 'fog') {
      for (let i = 0; i < n; i++) {
        const fx2 = ((hash(i) * W + t * (12 + hash(i + 3) * 20)) % (W + 300)) - 150;
        const fy = hash(i + 50) * H;
        ctx.beginPath(); ctx.ellipse(fx2, fy, 160, 70, 0, 0, 7); ctx.fill();
      }
    } else if (fx.type === 'clouds') {
      // big soft cloud banks drifting slowly across the whole sky
      for (let i = 0; i < n; i++) {
        const cw = 90 + hash(i + 2) * 130;
        const cx2 = ((hash(i) * (W + 400) + t * (8 + hash(i + 3) * 16)) % (W + 400)) - 200;
        const cy = hash(i + 50) * H * 0.85;
        ctx.globalAlpha = 0.08 + hash(i + 9) * 0.12;
        ctx.beginPath();
        ctx.ellipse(cx2, cy, cw, cw * 0.42, 0, 0, 7);
        ctx.ellipse(cx2 + cw * 0.55, cy + cw * 0.12, cw * 0.6, cw * 0.3, 0, 0, 7);
        ctx.ellipse(cx2 - cw * 0.55, cy + cw * 0.12, cw * 0.6, cw * 0.3, 0, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (fx.type === 'fireflies') {
      // warm motes that wander and softly blink on/off
      for (let i = 0; i < n; i++) {
        const fx2 = (hash(i) * W + Math.sin(t * 0.7 + i * 2.1) * 40 + W) % W;
        const fy = (hash(i + 40) * H + Math.cos(t * 0.6 + i * 1.7) * 30 + H) % H;
        ctx.globalAlpha = Math.max(0, Math.sin(t * 2 + i * 3.3)) * 0.9;
        ctx.beginPath(); ctx.arc(fx2, fy, 1.6, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      // drifting particles: bubbles/sparks rise, snow/petals fall
      const rise = fx.type === 'bubbles' || fx.type === 'sparks';
      const speed = fx.type === 'snow' ? 0.05 : fx.type === 'petals' ? 0.045 : 0.07;
      const sway = fx.type === 'petals' ? 36 : 14;
      for (let i = 0; i < n; i++) {
        let fr = (hash(i) + t * speed * (0.6 + hash(i + 5))) % 1;
        const fy = rise ? (1 - fr) * H : fr * H;
        const fxp = (hash(i + 20) * W + Math.sin(t * 1.3 + i) * sway + W) % W;
        const sz = hash(i + 11) * 2 + (fx.type === 'snow' ? 1.5 : 1);
        ctx.globalAlpha = 0.55 + 0.4 * hash(i + 30);
        ctx.beginPath(); ctx.arc(fxp, fy, sz, 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------
  function draw() {
    ctx.fillStyle = '#1d2024';
    ctx.fillRect(0, 0, W, H);

    const t = performance.now() / 1000;
    const run = PP.Game.run;
    const d = PP.Game.district;
    const th = d && d.theme;

    if (run && mapLayer) {
      // screen shake: jitter the whole scene by run.shake px (the dark bg fill
      // above shows through the exposed edge — the classic arcade-impact look).
      // Only while actively playing, so a paused / game-over scene never shakes.
      const playing = PP.Game.effectivePlaying && PP.Game.effectivePlaying();
      const sh = playing ? (run.shake || 0) : 0;
      ctx.save();
      if (sh > 0.05) ctx.translate((Math.random() * 2 - 1) * sh, (Math.random() * 2 - 1) * sh);
      ctx.drawImage(mapLayer, 0, 0, W, H);
      if (d) drawFeatureAnims(d, t);   // moving terrain (conveyors, lava, turntables…)
      if (th) drawAtmosphere(th, t);
      drawDecals(run);
      for (const p of run.potholes) drawPothole(run, p, t);
      for (const c of run.cars) drawCar(c, t);
      for (const tr of run.trucks) drawTruck(tr, t);
      drawRoadClosures(run);           // advanced-truck road-shutdown cones
      if (th) drawLandmarks(th, t);    // structures occlude traffic passing behind
      drawRepairProgress(run);         // repair rings sit on top of the trucks
      drawDragLine(t);
      drawParts(run);
      drawFloaters(run);
      ctx.restore();
      return;
    }

    // ambient backdrop behind the main menu: city + traffic + parked fleet
    const amb = PP.Game.ambient;
    if (amb && mapLayer) {
      ctx.drawImage(mapLayer, 0, 0, W, H);
      if (d) drawFeatureAnims(d, t);
      if (th) drawAtmosphere(th, t);
      for (const c of amb.cars) drawCar(c, t);
      for (const tr of amb.trucks) drawTruck(tr, t);
      if (th) drawLandmarks(th, t);
    }
  }

  return {
    init, resize, draw, onDistrictChanged, pxToTile, tileToPx,
    drawVehicleSide,          // side-view art for the Your Fleet UI
    // entity scale — also used by input code for tap radii
    get ts() { return es; },
  };
})();
