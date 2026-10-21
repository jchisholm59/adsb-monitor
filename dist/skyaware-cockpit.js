// Cockpit view for skyaware-card: the selected aircraft's view out of the windscreen over Google's photorealistic
// 3D world (CesiumJS + Cesium ion), with a HUD. Loaded by skyaware-card.js only when the Cockpit tab opens, so the
// map never pays for Cesium (several MB, from cesium/ next to this file).
//
// Needs `cesium_token` in the card config: a Cesium ion token (scope assets:read; restrict its Allowed URLs to
// your Home Assistant addresses, since anyone who can open the dashboard can read it).
//
// Camera, after God's Eye View's cockpit (github.com/bilawalsidhu/gods-eye-view): the camera sits a few metres
// ahead of and above the reported position, looking along the track. Between reports it advances inertially at
// the reported ground speed and vertical rate, then converges on the extrapolated position at a bounded rate, so
// a late fix never lurches the whole world. Heading is slewed at most 28°/s. It never goes below the 3D surface.
// Unlike OpenSky, dump1090 sometimes reports `roll` (from Mode S BDS 5,0), so the view banks with the aircraft;
// otherwise the bank is estimated from the turn rate (`track_rate`) for a coordinated turn.
//
// Follow view, after FlightRadar24's 3D view: the aircraft in 3D, with an orbit camera round it. The models are
// Flightradar24's own (github.com/Flightradar24/fr24-3d-models, from FlightGear, GPL-2.0), fetched by the browser
// from jsDelivr at a pinned commit and chosen by ICAO type (else ADS-B category); none are copied into this repo.
// Until one has loaded (or if it can't be), a low-poly airliner built here stands in. Drag to circle it, wheel or pinch to zoom, and the View button steps through Behind, Side, Front, Above
// and Auto (a new angle every few seconds). The camera's bearing trails the aircraft's heading on a damped spring, so
// in a turn the aircraft swings across the view before the camera catches up.
// Smooth (both views): the aircraft is shown SMOOTH_DELAY_S behind live, on a curve between two real fixes that
// matches each fix's reported velocity, instead of being extrapolated ahead and corrected when the next fix lands.

const CESIUM_VERSION = "1.146";
// CesiumJS ships with the card (cesium/ next to this file, its LICENSE.md there): nothing is fetched from a CDN.
const CESIUM_BASE = new URL("./cesium/", import.meta.url).href;
const GOOGLE_3D_ASSET = 2275207; // Google Photorealistic 3D Tiles on Cesium ion
// The card's resource version (?v=N), shown in the corner so a stale cached copy is easy to spot.
const BUILD = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "";
  } catch (e) {
    return "";
  }
})();

const FT = 0.3048;
const KT = 0.514444;
const G = 9.80665;
const HEADING_MAX_DPS = 10; // the heading eases onto the predicted track, never faster than this
const HEADING_TAU_S = 0.6; // ... with this time constant
const BANK_TAU_S = 1.5; // roll-in / roll-out time constant
const BANK_MAX_DPS = 12;
const BANK_LIMIT = 35; // airliners rarely bank past 30°
const TURN_WINDOW_S = 6; // turn rate from the track change over about this long
const TURN_TAU_S = 2; // then smoothed with this time constant
const TURN_DEADBAND = 0.12; // °/s: below this it's straight flight plus noise
const TURN_MAX = 6; // °/s
const PITCH_SLEW_DPS = 6;
const FORWARD_OFFSET_M = 7;
const UP_OFFSET_M = 2.6;
const MIN_CLEARANCE_M = 12;
const VIEW_PITCH_DEG = -4;
const STALE_S = 60; // extrapolate up to this; older positions are held, not extrapolated
const NOTE_S = 30; // say how old the position is after this
const LOST_S = 120;
const SMOOTH_DELAY_S = 3; // the card polls every 2 s, so there's nearly always a fix either side
const ALT_FIT_S = 10; // altitude is fitted with a straight line over this many seconds of fixes (see altFit)
const ALT_TAU_S = 2; // the shown height follows that on a critically damped spring this slow (see _frame)
const FOLLOW_SPRING = 0.8; // rad/s: the follow camera's heading spring (critically damped: settles in ~5 s, trails a turn by 2·rate/ω)
const ORBIT_TAU_S = 0.9; // a new camera angle eases in with this time constant
const AUTO_TAU_S = 2.4; // ... slower in Auto
const AUTO_SHOT_S = 11;
const AUTO_DRIFT_DPS = 1.5; // Auto circles slowly during a shot
// Camera angles round the aircraft: yaw from behind (+ = round to its right), pitch down onto it, range in aircraft
// lengths.
const VIEWS = {
  behind: { name: "Behind", yaw: 0, pitch: 8, range: 3.2 },
  side: { name: "Side", yaw: 90, pitch: 4, range: 3.2 },
  front: { name: "Front", yaw: 160, pitch: 6, range: 3.6 },
  above: { name: "Above", yaw: 15, pitch: 58, range: 7 },
  auto: { name: "Auto", yaw: 0, pitch: 8, range: 3.2 },
};
const VIEW_ORDER = ["behind", "side", "front", "above", "auto"];
const AUTO_SHOTS = [
  { yaw: 0, pitch: 8, range: 3.2 }, { yaw: -110, pitch: 5, range: 3 }, { yaw: 30, pitch: -7, range: 3.4 },
  { yaw: 150, pitch: 12, range: 4.5 }, { yaw: 70, pitch: 42, range: 6 }, { yaw: -20, pitch: 18, range: 10 },
];
const FR24_MODELS = "https://cdn.jsdelivr.net/gh/Flightradar24/fr24-3d-models@dd53267690c6a4ecbb290a3acf0284333a5d68a9/models/";
const FR24_REPO = "https://github.com/Flightradar24/fr24-3d-models";
const MODELS_KEPT = 4; // loaded models kept for switching back and forth
// ICAO type designator -> FR24 model (nearest family member where there's no exact one). Their a318 and b736 don't
// load in Cesium 1.146, so those types use the a319 and b737.
const TYPE_MODEL = Object.fromEntries(Object.entries({
  b737: "B736 B737 B37M", b738: "B738 B38M", b739: "B739 B39M B3XM",
  b744: "B741 B742 B743 B744 B74S B74R", b748: "B748", b752: "B752", b753: "B753", b762: "B762", b763: "B763",
  b764: "B764", b772: "B772 B77L B778", b773: "B773 B77W B779", b788: "B788", b789: "B789 B78X",
  a319: "A318 A319 A19N", a320: "A320 A20N", a321: "A321 A21N", a332: "A332 A338", a333: "A333 A339",
  a343: "A342 A343", a346: "A345 A346", a359: "A359 A35K", a380: "A388", beluga: "A3ST A337",
  atr42: "AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 B190 BE20 B350 BE9L BE99 SW4 JS31 JS32 JS41 D328 SF34 SB20 E120 F50 " +
    "DHC6 DHC7 L410 C212 CN35", q400: "DH8A DH8B DH8C DH8D", bae146: "B461 B462 B463 RJ70 RJ85 RJ1H",
  crj700: "CRJ1 CRJ2 CRJ7", crj900: "CRJ9 CRJX", cs100: "BCS1", cs300: "BCS3", e170: "E170 E75L E75S",
  e190: "E190 E195 E290 E295",
  citation: "C500 C501 C510 C525 C25A C25B C25C C25M C550 C551 C560 C56X C650 C680 C68A C700 C750 LJ35 LJ40 LJ45 LJ60 " +
    "LJ75 CL30 CL35 CL60 GLF4 GLF5 GLF6 GL5T GL7T GLEX G280 E35L E50P E55P E545 E550 F2TH FA7X FA8X F900 PC24 HDJT BE40 PRM1",
  pa28: "P28A P28B P28R P28T PA32 C150 C152 C170 C172 C177 C182 C206 C210 SR20 SR22 DA20 DA40 BE33 BE35 BE36 M20P C208 PC12 TBM7 TBM8 TBM9",
  heli: "EC20 EC30 EC35 EC45 EC55 EC75 H160 AS50 AS55 AS65 AS32 B06 B407 B412 B429 B505 R22 R44 R66 S76 S92 A109 A119 " +
    "A139 A169 A189 MD52 MD60 EH10 H47 H60 UH1",
  ask21: "AS21 GLID",
}).flatMap(([m, types]) => types.split(" ").map((t) => [t, m])));
// Models whose textures come out as black, camouflage or neon patches after Cesium upgrades them from glTF 1.0: drawn
// in plain paint instead (same shape and lighting).
const PLAIN_MODELS = new Set(["a332", "a333", "a346", "atr42", "b744", "b762", "b764", "b773", "citation"]);
// Every model also gets some fill light: Cesium lights models from the sun alone, so the side away from it went near
// black (a dark livery looked like a broken texture).
const MODEL_SHADER = (plain) => `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  ${plain ? "material.diffuse = vec3(0.86, 0.88, 0.91); material.specular = vec3(0.04); material.roughness = 0.45; material.alpha = 1.0;" : ""}
  material.emissive += material.diffuse * 0.3;
}`;
const CATEGORY_MODEL = { A1: "pa28", A2: "citation", A3: "b738", A4: "b752", A5: "b773", A6: "citation", A7: "heli", B1: "ask21" };
const modelFor = (type, category) => TYPE_MODEL[String(type || "").toUpperCase()] || CATEGORY_MODEL[category] || "a320";

// Rough length (m) by ADS-B emitter category: light, small, large, B757, heavy, high performance, rotorcraft.
const LENGTH_M = { A1: 9, A2: 17, A3: 38, A4: 47, A5: 64, A6: 20, A7: 15, B1: 10, B4: 9, B6: 6 };

// The follow view's aircraft: a low-poly airliner (nose +X, up +Y, length 1) as a binary glTF, fin in the aircraft's
// map colour. Flat-shaded quads and fans; each face is turned to face away from its part's centre line.
function aircraftGlb(finColor) {
  const pos = [], nrm = [], col = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // A convex polygon (3+ points), flipped if needed so its normal points away from `centre(faceCentre)`.
  const face = (pts, rgb, centre) => {
    const fc = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
    let n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    if (dot(n, sub(fc, centre(fc))) < 0) (pts = [...pts].reverse()), (n = n.map((v) => -v));
    const l = Math.hypot(...n) || 1;
    n = n.map((v) => v / l);
    for (let i = 1; i + 1 < pts.length; i++) for (const p of [pts[0], pts[i], pts[i + 1]]) pos.push(...p), nrm.push(...n), col.push(...rgb);
  };
  // Lofted body along X through rings [x, yCentre, radius] (radius 0 = a point), `sides`-gon cross-section.
  const loft = (rings, sides, rgb, z = 0, y0 = 0) => {
    const ring = ([x, yc, r]) => Array.from({ length: sides }, (_, i) => {
      const t = (2 * Math.PI * (i + 0.5)) / sides;
      return [x, y0 + yc + r * Math.cos(t), z + r * Math.sin(t)];
    });
    const rs = rings.map(ring);
    const axis = (fc) => {
      // Centre line at this face's x (rings are ordered nose to tail).
      for (let k = 1; k < rings.length; k++) {
        const [xa, ya] = rings[k - 1], [xb, yb] = rings[k];
        if ((fc[0] - xa) * (fc[0] - xb) <= 0) return [fc[0], y0 + ya + ((yb - ya) * (fc[0] - xa)) / (xb - xa || 1), z];
      }
      return [fc[0], y0 + rings[0][1], z];
    };
    for (let k = 1; k < rs.length; k++)
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides, q = [rs[k - 1][i], rs[k - 1][j], rs[k][j], rs[k][i]];
        if (rings[k - 1][2] === 0) face([q[1], q[2], q[3]], rgb, axis);
        else if (rings[k][2] === 0) face([q[0], q[1], q[2]], rgb, axis);
        else face(q, rgb, axis);
      }
  };
  // A thin slab from a planform (4 points), thickened by `t` along `dir`.
  const slab = (pl, t, dir, rgb) => {
    const lo = pl.map((p) => p.map((v, i) => v - (dir[i] * t) / 2)), hi = pl.map((p) => p.map((v, i) => v + (dir[i] * t) / 2));
    const c = pl.reduce((s, p) => s.map((v, i) => v + p[i] / pl.length), [0, 0, 0]);
    const cf = () => c;
    face(lo, rgb, cf);
    face(hi, rgb, cf);
    for (let i = 0; i < 4; i++) face([lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i]], rgb, cf);
  };
  const WHITE = [0.93, 0.94, 0.96], GREY = [0.62, 0.65, 0.7], DARK = [0.35, 0.37, 0.42];
  const FIN = finColor || [0.1, 0.45, 0.85];
  // Fuselage: nose to an upswept tail cone.
  loft([[0.5, -0.01, 0], [0.485, -0.008, 0.022], [0.455, -0.004, 0.04], [0.41, 0, 0.053], [0.36, 0, 0.056], [-0.24, 0, 0.056],
    [-0.36, 0.012, 0.045], [-0.46, 0.028, 0.022], [-0.5, 0.034, 0]], 10, WHITE);
  for (const s of [1, -1]) {
    // Swept wing with a little dihedral, engine under it, tailplane.
    slab([[0.09, -0.03, 0.04 * s], [-0.13, -0.03, 0.04 * s], [-0.27, -0.002, 0.475 * s], [-0.2, -0.002, 0.475 * s]], 0.012, [0, 1, 0], GREY);
    loft([[0.13, 0, 0.022], [0.12, 0, 0.028], [-0.02, 0, 0.025], [-0.04, 0, 0.016]], 8, DARK, 0.17 * s, -0.068);
    slab([[-0.37, 0.025, 0.03 * s], [-0.46, 0.025, 0.03 * s], [-0.5, 0.035, 0.175 * s], [-0.455, 0.035, 0.175 * s]], 0.008, [0, 1, 0], GREY);
  }
  slab([[-0.33, 0.05, 0], [-0.47, 0.04, 0], [-0.505, 0.215, 0], [-0.45, 0.215, 0]], 0.009, [0, 0, 1], FIN);

  // Binary glTF: one primitive (POSITION, NORMAL, COLOR_0), white material so the vertex colours show.
  const f32 = (a) => new Float32Array(a);
  const parts = [f32(pos), f32(nrm), f32(col)], n = pos.length / 3;
  const mn = [0, 1, 2].map((i) => Math.min(...pos.filter((_, k) => k % 3 === i))), mx = [0, 1, 2].map((i) => Math.max(...pos.filter((_, k) => k % 3 === i)));
  let off = 0;
  const views = parts.map((p) => ({ buffer: 0, byteOffset: (off += p.byteLength) - p.byteLength, byteLength: p.byteLength }));
  const json = {
    asset: { version: "2.0", generator: "skyaware-cockpit" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.15, roughnessFactor: 0.5 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: n, type: "VEC3" },
    ],
    bufferViews: views, buffers: [{ byteLength: off }],
  };
  const js = new TextEncoder().encode(JSON.stringify(json));
  const jl = Math.ceil(js.length / 4) * 4, bl = Math.ceil(off / 4) * 4;
  const glb = new Uint8Array(12 + 8 + jl + 8 + bl), dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true), dv.setUint32(4, 2, true), dv.setUint32(8, glb.length, true);
  dv.setUint32(12, jl, true), dv.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jl), glb.set(js, 20);
  dv.setUint32(20 + jl, bl, true), dv.setUint32(24 + jl, 0x004e4942, true);
  let o = 28 + jl;
  for (const p of parts) glb.set(new Uint8Array(p.buffer), o), (o += p.byteLength);
  return glb;
}

// Shown in place of the model if it can't be built: the aircraft from behind (fuselage, wings, tailplane and fin).
const REAR_SVG = "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -30 120 60">
  <g fill="#e8edf5" stroke="#1b2430" stroke-width="2" stroke-linejoin="round">
    <path d="M-58,4 L-8,-1 L8,-1 L58,4 L58,7 L8,5 L-8,5 L-58,7 Z"/>
    <path d="M-22,-12 L-3,-14 L3,-14 L22,-12 L22,-10 L3,-11 L-3,-11 L-22,-10 Z"/>
    <path d="M-2.5,-28 L2.5,-28 L3,-12 L-3,-12 Z"/>
    <circle cx="0" cy="2" r="8"/>
    <circle cx="-22" cy="9" r="3.6"/><circle cx="22" cy="9" r="3.6"/>
  </g></svg>`);

let cesiumLoading = null;

function loadCesium() {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (cesiumLoading) return cesiumLoading;
  window.CESIUM_BASE_URL = CESIUM_BASE;
  cesiumLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CESIUM_BASE + "Cesium.js?v=" + CESIUM_VERSION;
    s.async = true;
    s.onload = () => (window.Cesium ? resolve(window.Cesium) : reject(new Error("Cesium did not load")));
    s.onerror = () => {
      cesiumLoading = null;
      s.remove();
      reject(new Error("Couldn't load CesiumJS (" + CESIUM_BASE + "Cesium.js)"));
    };
    document.head.appendChild(s);
  });
  return cesiumLoading;
}

const norm360 = (v) => ((v % 360) + 360) % 360;
const slewAngle = (cur, target, max) => {
  const d = ((norm360(target) - norm360(cur) + 540) % 360) - 180;
  return norm360(cur + Math.max(-max, Math.min(max, d)));
};
const slew = (cur, target, max) => cur + Math.max(-max, Math.min(max, target - cur));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 0) => (fin(v) ? v.toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");

// GEV's bounded correction: ease towards the target, never faster than 22% of forward speed (min 0.75 m/s).
function correctionStep(distM, speedMps, dt) {
  if (!(distM > 0) || !(dt > 0)) return 0;
  dt = Math.min(0.1, dt);
  const eased = distM * (1 - Math.exp(-1.25 * dt));
  const rate = Math.max(0.75, Math.max(0, speedMps) * 0.22);
  return Math.min(distM, eased, rate * dt);
}

// Height in metres above the WGS84 ellipsoid. alt_geom is GNSS height on WGS84; alt_baro is pressure altitude,
// close to MSL (the geoid is about 20 m below the ellipsoid around Nova Scotia, small at these scales).
// ---- runways (approach mode) -------------------------------------------------------------------------------
// OurAirports' open runway data (updated daily, CORS open, ~4 MB). Fetched at most monthly; only the runway ends
// within RUNWAY_RANGE_NM of the receiver are kept, in localStorage.
const RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const RUNWAY_RANGE_NM = 250;
const NM = 1852;
const GS_DEG = 3; // glidepath angle
const GPI_FT = 1000; // glidepath aims this far past the threshold (as an ILS does)
const GS_DOT_DEG = 0.35; // ILS glideslope: 0.7° full scale = 2 dots
const LOC_DOT_DEG = 1.25; // ILS localizer: ~2.5° full scale = 2 dots
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const diffDeg = (a, b) => ((a - b + 540) % 360) - 180; // signed a - b in (-180, 180]

function distNm(la1, lo1, la2, lo2) {
  const dla = toRad(la2 - la1), dlo = toRad(lo2 - lo1);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dlo / 2) ** 2;
  return (2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)))) / NM;
}
function brgDeg(la1, lo1, la2, lo2) {
  const y = Math.sin(toRad(lo2 - lo1)) * Math.cos(toRad(la2));
  const x = Math.cos(toRad(la1)) * Math.sin(toRad(la2)) - Math.sin(toRad(la1)) * Math.cos(toRad(la2)) * Math.cos(toRad(lo2 - lo1));
  return norm360(toDeg(Math.atan2(y, x)));
}
function destPt(lat, lon, brg, m) {
  const d = m / 6371008.8, b = toRad(brg), p1 = toRad(lat), l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

function csvRow(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Runway ends near the receiver: { icao, id, lat, lon (threshold, after any displacement), elev (ft), hdg (true),
// flat, flon (the far end) }.
async function loadRunways(rx) {
  if (!rx || !fin(rx.lat) || !fin(rx.lon)) return [];
  const KEY = "skyaware-card:runways3"; // 3: snapped onto OpenStreetMap's runway centrelines
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    if (c && Date.now() - c.at < 30 * 86400000 && distNm(c.lat, c.lon, rx.lat, rx.lon) < 20) return c.ends;
  } catch (e) {}
  const r = await fetch(RUNWAYS_URL);
  if (!r.ok) throw new Error("runway data: HTTP " + r.status);
  const lines = (await r.text()).split(/\r?\n/);
  const h = csvRow(lines[0]);
  const ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const num = (v) => (v === "" || v == null ? NaN : Number(v));
  const ends = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = csvRow(lines[i]);
    if (f[ix.closed] === "1" || num(f[ix.length_ft]) < 2500) continue;
    const E = (k) => ({ id: f[ix[k + "_ident"]], lat: num(f[ix[k + "_latitude_deg"]]), lon: num(f[ix[k + "_longitude_deg"]]),
      elev: num(f[ix[k + "_elevation_ft"]]), hdg: num(f[ix[k + "_heading_degT"]]), disp: num(f[ix[k + "_displaced_threshold_ft"]]) });
    const le = E("le"), he = E("he");
    if (![le.lat, le.lon, he.lat, he.lon].every(fin)) continue;
    if (distNm(rx.lat, rx.lon, le.lat, le.lon) > RUNWAY_RANGE_NM) continue;
    for (const [a, b] of [[le, he], [he, le]]) {
      // The true bearing between the ends: OurAirports' listed heading is rounded to whole degrees.
      const hdg = brgDeg(a.lat, a.lon, b.lat, b.lon);
      const t = a.disp > 0 ? destPt(a.lat, a.lon, hdg, a.disp * FT) : a;
      const elev = fin(a.elev) ? a.elev : b.elev;
      if (!fin(elev)) continue;
      ends.push({ icao: f[ix.airport_ident], id: a.id, lat: +t.lat.toFixed(6), lon: +t.lon.toFixed(6), elev, hdg: +hdg.toFixed(1), flat: b.lat, flon: b.lon });
    }
  }
  try {
    await snapToOsm(ends, rx);
  } catch (e) {
    console.warn("skyaware-cockpit: OpenStreetMap runways unavailable, using OurAirports' positions", e);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), lat: rx.lat, lon: rx.lon, ends }));
  } catch (e) {}
  return ends;
}

// OurAirports' runway ends can be tens of metres off, and their bearing about a degree off (CYHZ 14/32: 1° and
// up to 92 m, which puts the extended centreline a few hundred metres out on the approach). OpenStreetMap's runways
// are traced from imagery, so each runway is moved onto its OSM centreline when one matches: same along-track
// threshold position (OurAirports' threshold and displacement), OSM's line and bearing.
const OVERPASS = "https://overpass-api.de/api/interpreter";
async function snapToOsm(ends, rx) {
  const q = `[out:json][timeout:90];way["aeroway"="runway"](around:${Math.round(RUNWAY_RANGE_NM * NM)},${rx.lat},${rx.lon});out geom;`;
  const r = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!r.ok) throw new Error("Overpass HTTP " + r.status);
  const ways = ((await r.json()).elements || []).filter((w) => Array.isArray(w.geometry) && w.geometry.length >= 2);
  let snapped = 0;
  for (const e of ends) {
    // Local flat frame (metres) around this threshold, x east, y north.
    const k = Math.cos(toRad(e.lat)), X = (la, lo) => [(lo - e.lon) * 111320 * k, (la - e.lat) * 110540];
    const back = ([x, y]) => ({ lat: e.lat + y / 110540, lon: e.lon + x / (111320 * k) });
    const [fx, fy] = X(e.flat, e.flon), len = Math.hypot(fx, fy);
    if (len < 300) continue;
    const ux = fx / len, uy = fy / len; // along the runway, threshold -> far end
    // OSM points of ways lying along this runway: within 200 m of OurAirports' line, within 6° of its direction.
    const pts = [];
    for (const w of ways) {
      const g = w.geometry.map((n) => X(n.lat, n.lon));
      const [a, b] = [g[0], g[g.length - 1]], wl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (wl < 100) continue;
      const cosang = Math.abs(((b[0] - a[0]) * ux + (b[1] - a[1]) * uy) / wl);
      if (cosang < Math.cos(toRad(6))) continue;
      if (g.some(([x, y]) => Math.abs(x * uy - y * ux) > 200 || x * ux + y * uy < -1500 || x * ux + y * uy > len + 1500)) continue;
      pts.push(...g);
    }
    if (pts.length < 2) continue;
    // OSM centreline: the two points farthest apart along the runway.
    let lo = pts[0], hi = pts[0];
    for (const p of pts) {
      const s1 = p[0] * ux + p[1] * uy;
      if (s1 < lo[0] * ux + lo[1] * uy) lo = p;
      if (s1 > hi[0] * ux + hi[1] * uy) hi = p;
    }
    const dx = hi[0] - lo[0], dy = hi[1] - lo[1], dl = Math.hypot(dx, dy);
    if (dl < 300) continue;
    const vx = dx / dl, vy = dy / dl;
    // Project the threshold and the far end onto the OSM line.
    const proj = ([x, y]) => { const t = (x - lo[0]) * vx + (y - lo[1]) * vy; return [lo[0] + t * vx, lo[1] + t * vy]; };
    const t2 = back(proj([0, 0])), f2 = back(proj([fx, fy]));
    e.osmShift = Math.round(Math.hypot(...proj([0, 0]))); // metres moved, for the record
    e.lat = +t2.lat.toFixed(6);
    e.lon = +t2.lon.toFixed(6);
    e.flat = +f2.lat.toFixed(6);
    e.flon = +f2.lon.toFixed(6);
    e.hdg = +brgDeg(e.lat, e.lon, e.flat, e.flon).toFixed(2);
    e.src = "osm";
    snapped++;
  }
  console.info(`skyaware-cockpit: ${snapped} of ${ends.length} runway ends snapped to OpenStreetMap`);
}

// Turn rate (°/s, + = right) from an aircraft's recent track reports [[tSec, track], ...]: hardly any aircraft send
// `roll` or `track_rate` (they need a radar's Comm-B interrogation; none around CYHZ do), so the bank comes from this.
// Uses the newest report against one ~TURN_WINDOW_S older, so the track's noise doesn't read as turning.
export function turnRate(hist) {
  if (!hist || hist.length < 2) return 0;
  const [tn, kn] = hist[hist.length - 1];
  let ref = hist[0];
  for (const h of hist) if (tn - h[0] >= TURN_WINDOW_S) ref = h;
  const dt = tn - ref[0];
  if (dt < 1.5) return 0;
  const w = (((kn - ref[1] + 540) % 360) - 180) / dt;
  return Math.abs(w) < TURN_DEADBAND ? 0 : Math.max(-TURN_MAX, Math.min(TURN_MAX, w));
}

// The turn rate to use: the aircraft's own track_rate when it sends one, else our estimate.
const p_turn = (a, entry) => (fin(a.track_rate) ? a.track_rate : entry?.turn || 0);

function heightM(a) {
  if (a.alt_baro === "ground") return null;
  const ft = fin(a.alt_geom) ? a.alt_geom : fin(a.alt_baro) ? a.alt_baro : null;
  return ft == null ? null : ft * FT;
}

// ADS-B altitude comes in 25 ft (7.6 m) steps, and in level flight it often flickers between two of them
// (38175, 38150, 38175...), and a steady descent arrives as uneven stairs; followed exactly, the aircraft bobs like
// it's in turbulence. So each new fix's height and vertical rate are replaced by a least-squares line through the raw
// heights of the last ALT_FIT_S seconds, evaluated at that fix: steady in level flight, an even slope in a climb.
function altFit(fixes, fx) {
  if (fx.hRaw == null) return;
  const pts = fixes.filter((f) => f.hRaw != null && fx.t - f.t <= ALT_FIT_S * 1000);
  if (pts.length < 3 || (fx.t - pts[0].t) / 1000 < 3) return;
  const n = pts.length, mt = pts.reduce((s, f) => s + f.t / 1000, 0) / n, mh = pts.reduce((s, f) => s + f.hRaw, 0) / n;
  let sxy = 0, sxx = 0;
  for (const f of pts) (sxy += (f.t / 1000 - mt) * (f.hRaw - mh)), (sxx += (f.t / 1000 - mt) ** 2);
  let slope = sxx > 0 ? sxy / sxx : 0;
  // Less than one 25 ft step over the window (~150 fpm) is the flicker, not a climb: level, at the average.
  if (Math.abs(slope) * ALT_FIT_S < 25 * FT) slope = 0;
  fx.h = mh + slope * (fx.t / 1000 - mt);
  fx.vs = slope;
}

function vrateMps(a) {
  const fpm = fin(a.geom_rate) ? a.geom_rate : fin(a.baro_rate) ? a.baro_rate : 0;
  return a.alt_baro === "ground" ? 0 : fpm * FT / 60;
}

// Why Cesium ion didn't hand over the Google 3D tiles, in words. Its errors are RequestErrorEvents: an HTTP status
// (none when ion couldn't be reached at all) and a response that's often JSON with a message.
function tilesReason(e) {
  const code = e?.statusCode;
  let msg = "";
  try {
    msg = String(typeof e?.response === "string" ? JSON.parse(e.response).message || "" : e?.response?.message || "");
  } catch (x) {
    msg = String(e?.response || "");
  }
  const text = msg + " " + String(e?.message || "");
  if (/quota|usage|exceeded/i.test(text)) return "this Cesium ion account's usage allowance is used up";
  if (code === 429 || /too many/i.test(text)) return "Cesium ion is limiting requests for now";
  if (code === 404) return "the Google Photorealistic 3D Tiles asset isn't in this Cesium ion account (add it from the Asset Depot)";
  if (code === 401 || code === 403) return `Cesium ion refused it from ${location.origin} (check the token's Allowed URLs and its assets:read scope)`;
  // No status at all: the network, or a refusal without CORS headers (ion's rate limiting has been seen to answer so).
  if (!code) return "couldn't reach Cesium ion, or it's limiting requests";
  return `Cesium ion answered HTTP ${code}${msg ? " (" + msg + ")" : ""}`;
}

const STYLE = `
  .ck { position: relative; width: 100%; height: min(70vh, 640px); min-height: 320px; border-radius: 12px; overflow: hidden; background: #0b1020; color: #e8f0ff; font-variant-numeric: tabular-nums; }
  .ck .scene { position: absolute; inset: 0; }
  .ck .scene canvas { display: block; touch-action: none; }
  .ck .credits { position: absolute; left: 8px; bottom: 6px; font-size: 10px; opacity: .8; max-width: 55%; pointer-events: auto; }
  .ck .credits img { max-height: 16px; vertical-align: middle; }
  .ck .credits a { color: inherit; }
  .ck .credits .cesium-credit-lightbox-overlay { position: fixed; }
  .ck .mcredit { position: absolute; right: 12px; bottom: 60px; font-size: 10px; opacity: .7; }
  .ck .mcredit a { color: inherit; }
  .ck .hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-monospace, "JetBrainsMono Nerd Font", monospace; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,.6); }
  .ck .hud * { pointer-events: none; }
  .ck .hud .btns, .ck .hud .btns * , .ck .credits * { pointer-events: auto; }
  .ck .ident { position: absolute; left: 12px; top: 10px; line-height: 1.35; }
  .ck .ident .cs { font-size: 1.25em; font-weight: 700; letter-spacing: .04em; }
  .ck .ident .sub { opacity: .85; font-size: .85em; }
  .ck .tape { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); width: min(60%, 420px); height: 34px; }
  .ck .box { position: absolute; top: 50%; transform: translateY(-50%); padding: 4px 8px; border: 1.5px solid rgba(255,255,255,.85); border-radius: 6px; background: rgba(0,0,0,.25); text-align: center; min-width: 64px; }
  .ck .box b { display: block; font-size: 1.35em; }
  .ck .box span { font-size: .75em; opacity: .85; }
  .ck .spd { left: 12px; } .ck .alt { right: 12px; }
  .ck .alt .vs { display: block; font-size: .8em; margin-top: 2px; }
  .ck .bore { position: absolute; left: 50%; top: 50%; width: 46px; height: 14px; transform: translate(-50%, -50%); }
  .ck .status { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); padding: 6px 12px; border-radius: 8px; background: rgba(0,0,0,.55); font-size: .9em; text-align: center; }
  .ck .status { white-space: pre-line; }
  .ck .status:empty { display: none; }
  .ck .apr { position: absolute; left: 50%; top: 50%; width: 380px; height: 290px; transform: translate(-50%, -50%); overflow: visible; }
  .ck .aprinfo { position: absolute; left: 50%; top: 50px; transform: translateX(-50%); padding: 3px 10px; border: 1.5px solid #ff6ef0; border-radius: 6px; background: rgba(0,0,0,.35); color: #ffb8f6; font-size: .85em; white-space: nowrap; }
  .ck .aprinfo:empty { display: none; }
  .ck .aprinfo b { color: #fff; }
  .ck .hudsvg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; display: none; }
  .ck.hud-on .hudsvg { display: block; }
  .ck.hud-on .tape, .ck.hud-on .box, .ck.hud-on .bore, .ck.hud-on .bankind { display: none; }
  .ck.hud-on .aprinfo { border-color: #7CFC9A; color: #b9ffc9; top: auto; bottom: 54px; }
  .ck .hudsvg text { font-family: ui-monospace, "JetBrainsMono Nerd Font", monospace; paint-order: stroke; stroke: rgba(0,0,0,.55); stroke-width: 2.5px; }
  .ck .bankind { position: absolute; left: 50%; top: 50%; width: 300px; height: 120px; transform: translate(-50%, -100%) translateY(-28px); overflow: visible; }
  .ck .build { position: absolute; right: 12px; bottom: 46px; font-size: 10px; opacity: .45; }
  .ck .btns { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .ck .btns button { font: inherit; font-size: .85em; color: #fff; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.35); border-radius: 999px; padding: 5px 11px; cursor: pointer; }
  .ck .btns button:hover { background: rgba(255,255,255,.18); }
  .ck .btns button.on { border-color: #7CFC9A; color: #7CFC9A; }
  .ck .btns button.on { background: var(--primary-color, #03a9f4); border-color: transparent; }
  .ck .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; line-height: 1.5; background: #0b1020; }
  .ck .msg > div { max-width: 560px; text-align: left; }
  .ck .msg ol { margin: 8px 0 0; padding-left: 22px; } .ck .msg li { margin: 4px 0; }
  .ck .msg form { display: flex; gap: 6px; margin-top: 12px; }
  .ck .msg input { flex: 1; min-width: 0; font: inherit; color: inherit; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.3); border-radius: 8px; padding: 7px 10px; }
  .ck .msg button { font: inherit; color: #fff; background: var(--primary-color, #03a9f4); border: 0; border-radius: 8px; padding: 7px 14px; cursor: pointer; }
  .ck .msg button:disabled { opacity: .6; }
  .ck .msg .note { font-size: .85em; opacity: .8; margin-top: 8px; }
  .ck .msg code { background: rgba(255,255,255,.12); padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
  .ck .msg:empty { display: none; }
`;

export class Cockpit {
  // opts: { token, saveToken(token) -> Promise, color(a) -> css colour, onPick(hex), onExit(), label(a) -> {cs, sub},
  //         receiver {lat, lon} (for the runway list), dest(a) -> destination ICAO (preferred runway for approach mode),
  //         type(a) -> ICAO type designator (picks the follow view's model; else a.t, sent by adsb.lol / adsb.fi),
  //         sdr: the card's SdrListener and its panel {listener, panel} (sdr-listen.js; shown here while open) }
  constructor(container, opts) {
    this.el = container;
    this.opts = opts;
    this.acs = new Map(); // hex -> { a, recvMs }
    this.sel = null;
    this.mode = "cockpit"; // or "chase" (the follow view)
    this.look = { yaw: 0, pitch: 0 };
    this.fov = 60;
    this.destroyed = false;
    this._listeners = [];
    this._render();
    const saved = (k, d) => {
      try {
        return localStorage.getItem("skyaware-card:" + k) ?? d;
      } catch (e) {
        return d;
      }
    };
    this._setHudStyle(saved("hud", "1") !== "0");
    this._setView(VIEWS[saved("view", "")] ? saved("view", "") : "behind");
    this._setSmooth(saved("smooth", "1") !== "0");
    this._setMode("cockpit");
    this.sdr = opts.sdr?.listener || null;
    if (opts.sdr?.panel) opts.sdr.panel.mount(this.$.ck, "view");
  }

  // Listening (not scanning: Scan follows the talk by itself) while the followed aircraft lands: Tower (or
  // Approach, if still on it) -> Ground, by channel name.
  _sdrLanding(a) {
    const s = this.sdr;
    const ground = a?.alt_baro === "ground";
    if (s?.on && !s.scanning && a && this._sdrHex === a.hex && this._sdrAir && ground && /tower|twr|approach|app\b/i.test(s.channel?.name || "")) {
      const g = s.channels.findIndex((c) => /ground|gnd/i.test(c.name));
      if (g >= 0) s.tune(g);
    }
    this._sdrHex = a?.hex;
    this._sdrAir = a ? !ground : false;
  }

  _save(k, v) {
    try {
      localStorage.setItem("skyaware-card:" + k, v);
    } catch (e) {}
  }

  _setMode(m) {
    this.mode = m;
    const follow = m === "chase";
    this.$.mode.textContent = follow ? "Cockpit view" : "Follow view";
    this.$.viewBtn.style.display = follow ? "" : "none";
    this.$.styleBtn.style.display = follow ? "none" : "";
    this.$.reset.textContent = follow ? "Reset view" : "Look ahead";
    this.look = { yaw: 0, pitch: 0 };
    this.camHdg = null;
    this._setHudStyle(this.hudStyle); // the HUD belongs to the cockpit view
  }

  // Follow view camera angle: a preset (eased into), or Auto.
  _setView(v) {
    this.view = v;
    const t = VIEWS[v] || VIEWS.behind;
    this.orbitT = { yaw: t.yaw, pitch: t.pitch, range: t.range };
    if (!this.orbit) this.orbit = { ...this.orbitT };
    this._shot = 0;
    this._shotMs = performance.now();
    this.$.viewBtn.textContent = "View: " + t.name;
    this.$.viewBtn.classList.toggle("on", v === "auto");
    this._save("view", v);
  }

  _setSmooth(on) {
    this.smooth = !!on;
    this.$.smoothBtn.classList.toggle("on", this.smooth);
    this._save("smooth", this.smooth ? "1" : "0");
  }

  _setHudStyle(on) {
    this.hudStyle = !!on;
    this.$.ck.classList.toggle("hud-on", this.hudStyle && this.mode === "cockpit");
    this.$.styleBtn.classList.toggle("on", this.hudStyle);
    this._save("hud", this.hudStyle ? "1" : "0");
  }

  _render() {
    this.el.innerHTML = `<style>${STYLE}</style>
      <div class="ck">
        <div class="scene"></div>
        <div class="hud">
          <div class="ident"><div class="cs"></div><div class="sub"></div></div>
          <svg class="tape" viewBox="-210 0 420 34"></svg>
          <div class="box spd"><b>–</b><span>GS kt</span></div>
          <div class="box alt"><b>–</b><span>ALT ft</span><span class="vs"></span></div>
          <svg class="bore" viewBox="-23 -7 46 14"><path d="M-23,0H-9L-5,5L0,0L5,5L9,0H23" fill="none" stroke="#7CFC9A" stroke-width="2"/></svg>
          <svg class="hudsvg"></svg>
          <svg class="apr" viewBox="-190 -145 380 290"></svg>
          <svg class="bankind" viewBox="-150 -120 300 120"></svg>
          <div class="aprinfo"></div>
          <div class="status"></div>
          <div class="build">${BUILD ? "v" + esc(BUILD) : ""}</div>
          <div class="btns">
            <button data-ck="prev" title="Previous aircraft (by distance)">◀</button>
            <button data-ck="next" title="Next aircraft (by distance)">▶</button>
            <button data-ck="style" title="HUD symbology, as on an airliner's head-up display">HUD</button>
            <button data-ck="mode">Follow view</button>
            <button data-ck="view" title="Camera angle: Behind, Side, Front, Above, or Auto (a new angle every few seconds). Drag to circle the aircraft, wheel or pinch to zoom">View: Behind</button>
            <button data-ck="smooth" title="Smooth: show the aircraft ${SMOOTH_DELAY_S} s behind live, on its real path between position reports, instead of estimating ahead">Smooth</button>
            <button data-ck="reset" title="Look ahead again">Look ahead</button>
            <button data-ck="exit">Map</button>
          </div>
        </div>
        <div class="credits"></div>
        <div class="mcredit" hidden>3D aircraft: <a href="${FR24_REPO}" target="_blank" rel="noreferrer">Flightradar24</a> / FlightGear (GPL-2.0)</div>
        <div class="msg">Loading the 3D world…</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { hudsvg: q(".hudsvg"), ck: q(".ck"), styleBtn: q('[data-ck="style"]'), bankind: q(".bankind"), apr: q(".apr"), aprinfo: q(".aprinfo"), scene: q(".scene"), cs: q(".ident .cs"), sub: q(".ident .sub"), tape: q(".tape"), spd: q(".spd b"),
      alt: q(".alt b"), vs: q(".alt .vs"), status: q(".status"), msg: q(".msg"), credits: q(".credits"), mode: q('[data-ck="mode"]'),
      mcredit: q(".mcredit"), viewBtn: q('[data-ck="view"]'), smoothBtn: q('[data-ck="smooth"]'), reset: q('[data-ck="reset"]') };
    this._on(this.el, "click", (e) => {
      const b = e.target.closest("[data-ck]");
      if (!b) return;
      const act = b.dataset.ck;
      if (act === "exit") this.opts.onExit?.();
      else if (act === "next" || act === "prev") this._step(act === "next" ? 1 : -1);
      else if (act === "mode") this._setMode(this.mode === "cockpit" ? "chase" : "cockpit");
      else if (act === "view") this._setView(VIEW_ORDER[(VIEW_ORDER.indexOf(this.view) + 1) % VIEW_ORDER.length]);
      else if (act === "smooth") this._setSmooth(!this.smooth);
      else if (act === "style") this._setHudStyle(!this.hudStyle);
      else if (act === "reset") this._resetView();
    });
  }

  _on(t, type, fn, opt) {
    t.addEventListener(type, fn, opt);
    this._listeners.push(() => t.removeEventListener(type, fn, opt));
  }

  async start() {
    // Runways for approach mode, while the 3D world loads.
    this.runways = [];
    if (!this.opts.receiver) this._rwyErr = "receiver position unknown";
    else loadRunways(this.opts.receiver).then((r) => {
      this.runways = r || [];
      if (!this.runways.length) this._rwyErr = "no runways found near the receiver";
    }, (e) => {
      this._rwyErr = e?.message || String(e);
      console.warn("skyaware-cockpit: runway data", e);
    });
    const token = String(this.opts.token || "").trim();
    if (!token) {
      this._askToken("<b>The cockpit view needs a Cesium ion token.</b>");
      return;
    }
    let C;
    try {
      C = this.C = await loadCesium();
    } catch (e) {
      this.$.msg.textContent = e.message;
      return;
    }
    if (this.destroyed) return;
    // Cesium's widget stylesheet, inside the card's shadow root.
    const root = this.el.getRootNode();
    if (!root.querySelector?.("link[data-cesium]")) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = CESIUM_BASE + "Widgets/widgets.css?v=" + CESIUM_VERSION;
      l.dataset.cesium = "1";
      (root.host ? root : document.head).appendChild(l);
    }
    C.Ion.defaultAccessToken = token;
    const w = (this.w = new C.CesiumWidget(this.$.scene, {
      baseLayer: false,
      skyAtmosphere: new C.SkyAtmosphere(),
      shadows: false,
      msaaSamples: 4,
      creditContainer: this.$.credits,
    }));
    const scene = w.scene;
    scene.globe.baseColor = C.Color.fromCssColorString("#1d2a3a");
    scene.globe.depthTestAgainstTerrain = true;
    scene.screenSpaceCameraController.enableInputs = false; // the camera is ours; drag looks around instead
    w.camera.frustum.fov = C.Math.toRadians(this.fov);
    this._token = token;
    try {
      const tiles = await this._loadTiles();
      if (this.destroyed) return void tiles.destroy();
      this.tiles = scene.primitives.add(tiles);
      scene.globe.show = false;
    } catch (e) {
      // No Google tiles: Cesium World Terrain + imagery meanwhile, and try the tiles again later (_tilesFailed).
      console.warn("skyaware-cockpit: Google 3D tiles unavailable, falling back to terrain", e);
      try {
        w.scene.imageryLayers.add(C.ImageryLayer.fromProviderAsync(C.IonImageryProvider.fromAssetId(2)));
        w.scene.terrainProvider = await C.createWorldTerrainAsync();
        this._tilesFailed(e, "terrain");
      } catch (e2) {
        // The terrain comes from Cesium ion too, so a refused token or a rate limit stops it as well. A refused token
        // needs a new one; anything else carries on over a plain globe until the tiles come back.
        if ([401, 403].includes(e2?.statusCode) || /Invalid access token|Unauthorized/i.test(String(e2?.message || e2))) {
          this._askToken(`<b>Cesium ion refused the token.</b> Check it was copied whole, and that its Allowed URLs include <code>${esc(location.origin)}</code>, or paste another.`);
          return;
        }
        this._tilesFailed(e, "a plain globe");
      }
    }
    if (this.destroyed) return;
    this.points = scene.primitives.add(new C.PointPrimitiveCollection());
    this.bbs = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.chaseBb = this.bbs.add({ image: REAR_SVG, width: 132, height: 66, show: false });
    this.labels = scene.primitives.add(new C.LabelCollection());
    this.marks = new Map(); // hex -> { pt, lb }
    this._models = new Map(); // FR24 model file -> { model, used }
    this.aprLines = scene.primitives.add(new C.PolylineCollection());
    this.$.msg.textContent = "";
    this._initInput();
    this._last = performance.now();
    this._removePre = scene.preUpdate.addEventListener(() => this._frame());
  }

  // Google's photorealistic 3D tiles, through Cesium ion. Throws Cesium's RequestErrorEvent (statusCode, response).
  async _loadTiles() {
    const C = this.C;
    const res = await C.IonResource.fromAssetId(GOOGLE_3D_ASSET, { accessToken: this._token });
    // foveatedTimeDelay 0: Cesium otherwise holds back tiles away from the screen centre until the camera has been still
    // for 0.2 s, and this camera moves with the aircraft every frame, so the ground to either side was slow to load.
    // skipLevelOfDetail: show a coarse level first, then jump to near the final detail instead of fetching every level
    // in between (Google's hierarchy is deep, and each level is a round trip).
    return C.Cesium3DTileset.fromUrl(res, {
      cacheBytes: 768 * 1024 * 1024, enableCollision: true, asynchronouslyLoadImagery: true, foveatedTimeDelay: 0,
      skipLevelOfDetail: true, baseScreenSpaceError: 1024, skipScreenSpaceErrorFactor: 16, skipLevels: 1,
    });
  }

  // The tiles didn't load: say why in the status line, and try again in 1, 2, 5, then every 10 minutes. When they do
  // load they replace the fallback (`showing`: what's shown meanwhile).
  _tilesFailed(e, showing) {
    this._tilesTry = (this._tilesTry || 0) + 1;
    const min = [1, 2, 5][this._tilesTry - 1] || 10;
    this._note = `Google 3D tiles unavailable: ${tilesReason(e)}. Showing ${showing}; trying again in ${min} min`;
    clearTimeout(this._tilesTimer);
    this._tilesTimer = setTimeout(async () => {
      if (this.destroyed || !this.w || this.tiles) return;
      try {
        const tiles = await this._loadTiles();
        if (this.destroyed || !this.w) return void tiles.destroy();
        this.tiles = this.w.scene.primitives.add(tiles);
        this.w.scene.globe.show = false;
        this._note = "";
        this._tilesTry = 0;
      } catch (err) {
        console.warn("skyaware-cockpit: Google 3D tiles still unavailable", err);
        this._tilesFailed(err, showing);
      }
    }, min * 60000);
  }

  // The paste-a-token form. The card saves it to the HA user's profile (or the browser) and reopens the view.
  _askToken(intro) {
    const canSave = typeof this.opts.saveToken === "function";
    this.$.msg.innerHTML = `<div>${intro}<ol>
        <li>Create one at <a href="https://ion.cesium.com/tokens" target="_blank" rel="noreferrer" style="color:inherit">ion.cesium.com/tokens</a>
          with only the <code>assets:read</code> scope, its Allowed URLs limited to your Home Assistant addresses.</li>
        <li>${canSave ? "Paste it here:" : "Add <code>cesium_token: &lt;token&gt;</code> to this card's YAML."}</li></ol>
      ${canSave ? `<form><input type="password" placeholder="Cesium ion token" autocomplete="off" spellcheck="false"><button type="submit">Save</button></form>
        <div class="note">Saved to your Home Assistant profile, so it works on every device you're signed in on.</div>` : ""}</div>`;
    const form = this.$.msg.querySelector("form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = form.querySelector("input").value.trim();
      if (!t) return;
      const btn = form.querySelector("button");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await this.opts.saveToken(t);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Save";
        this.$.msg.querySelector(".note").textContent = "Couldn't save it: " + (err?.message || err);
      }
    });
    // Keep HA's keyboard shortcuts out of the box.
    form.addEventListener("keydown", (e) => e.stopPropagation());
  }

  _resetView() {
    if (this.mode === "cockpit") (this.look = { yaw: 0, pitch: 0 }), (this.fov = 60);
    else this._setView(this.view === "custom" ? "behind" : this.view);
  }

  // Cockpit: drag looks around, the wheel zooms the lens. Follow: drag circles the aircraft, the wheel or a pinch
  // moves the camera in and out. Moving the camera by hand leaves Auto.
  _initInput() {
    const cv = this.w.canvas;
    const ptrs = new Map();
    let drag = null, pinch = null;
    const manual = () => {
      if (this.view !== "auto") return;
      this.view = "custom";
      this.$.viewBtn.textContent = "View: Auto (off)";
      this.$.viewBtn.classList.remove("on");
    };
    const zoom = (f) => {
      manual();
      this.orbitT.range = clamp(this.orbitT.range * f, 1.2, 300);
    };
    this._on(cv, "pointerdown", (e) => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cv.setPointerCapture?.(e.pointerId);
      if (ptrs.size === 2) {
        const [p, q] = [...ptrs.values()];
        pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, range: this.orbitT.range };
        drag = null;
      } else if (ptrs.size === 1)
        drag = { x: e.clientX, y: e.clientY, yaw: this.look.yaw, pitch: this.look.pitch, oyaw: this.orbit.yaw, opitch: this.orbit.pitch };
    });
    this._on(cv, "pointermove", (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size === 2 && this.mode !== "cockpit") {
        const [p, q] = [...ptrs.values()];
        manual();
        this.orbitT.range = clamp((pinch.range * pinch.d) / (Math.hypot(p.x - q.x, p.y - q.y) || 1), 1.2, 300);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (this.mode === "cockpit") {
        const k = this.fov / Math.max(200, cv.clientWidth);
        this.look.yaw = norm360(drag.yaw - dx * k + 180) - 180;
        this.look.pitch = clamp(drag.pitch + dy * k, -80, 60);
      } else {
        if (Math.abs(dx) + Math.abs(dy) > 3) manual();
        // Straight onto the camera (no easing) while dragging.
        this.orbitT.yaw = this.orbit.yaw = norm360(drag.oyaw - dx * 0.35 + 180) - 180;
        this.orbitT.pitch = this.orbit.pitch = clamp(drag.opitch + dy * 0.25, -25, 85);
      }
    });
    const end = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) drag = null;
    };
    this._on(cv, "pointerup", end);
    this._on(cv, "pointercancel", end);
    this._on(cv, "dblclick", () => this._resetView());
    this._on(cv, "wheel", (e) => {
      e.preventDefault();
      if (this.mode === "cockpit") this.fov = clamp(this.fov * Math.exp(e.deltaY * 0.001), 15, 100);
      else zoom(Math.exp(e.deltaY * 0.0015));
    }, { passive: false });
  }

  // Called by the card after every aircraft.json poll.
  setData(aircraft, selHex) {
    const now = performance.now();
    const seen = new Set();
    for (const a of aircraft) {
      if (!fin(a.lat) || !fin(a.lon)) continue;
      seen.add(a.hex);
      const old = this.acs.get(a.hex);
      // Keep the receive time if the position hasn't changed, so extrapolation continues from the original fix.
      if (old && old.a.lat === a.lat && old.a.lon === a.lon && old.a.seen_pos <= a.seen_pos) old.a = a;
      else {
        const e = { a, recvMs: now - (a.seen_pos || 0) * 1000, hist: old?.hist || [], turn: old?.turn || 0, fixes: old?.fixes || [] };
        const t = e.recvMs / 1000, trk = fin(a.track) ? a.track : fin(a.true_heading) ? a.true_heading : null;
        // Fixes for Smooth: the last 30 s, in time order.
        const fx = { t: e.recvMs, lat: a.lat, lon: a.lon, h: heightM(a), gs: fin(a.gs) ? a.gs * KT : 0, trk, vs: vrateMps(a) };
        fx.hRaw = fx.h;
        while (e.fixes.length && e.fixes[e.fixes.length - 1].t >= fx.t) e.fixes.pop();
        e.fixes.push(fx);
        while (e.fixes.length > 2 && fx.t - e.fixes[0].t > 30000) e.fixes.shift();
        altFit(e.fixes, fx);
        if (trk != null) {
          if (e.hist.length && t - e.hist[e.hist.length - 1][0] > 20) e.hist = []; // a gap: start over
          e.hist.push([t, trk]);
          while (e.hist.length > 2 && t - e.hist[0][0] > TURN_WINDOW_S * 2) e.hist.shift();
          const dt = old ? Math.max(0.1, t - old.recvMs / 1000) : 1;
          e.turn += (turnRate(e.hist) - e.turn) * (1 - Math.exp(-dt / TURN_TAU_S));
        }
        this.acs.set(a.hex, e);
      }
    }
    for (const hex of this.acs.keys()) if (!seen.has(hex)) this.acs.delete(hex);
    if (selHex !== this.sel) {
      this.sel = selHex;
      this.anchor = null; // re-acquire
      this.heading = this.bank = this.fpa = this.camHdg = null;
      this.look = { yaw: 0, pitch: 0 };
    }
    if (this.sdr) this._sdrLanding(this.acs.get(this.sel)?.a);
  }

  _step(dir) {
    const list = [...this.acs.values()].map((x) => x.a).filter((a) => a.alt_baro !== "ground").sort((p, q) => (p._dist ?? 1e9) - (q._dist ?? 1e9));
    if (!list.length) return;
    const i = list.findIndex((a) => a.hex === this.sel);
    const next = list[(i + dir + list.length) % list.length];
    this.opts.onPick?.(next.hex);
  }

  // Where to show an aircraft at `nowMs`: live, or with Smooth on, SMOOTH_DELAY_S earlier on a cubic Hermite curve
  // between the fixes either side, matching each fix's position and reported velocity, so turns and climbs follow the
  // flown path and nothing is ever corrected. Outside the fixes (one fix so far, a gap, on the ground): extrapolated.
  _pos(entry, nowMs, out) {
    if (!this.smooth) return this._project(entry, nowMs, out);
    const tr = nowMs - SMOOTH_DELAY_S * 1000, f = entry.fixes || [];
    let j = -1;
    for (let k = f.length - 1; k > 0; k--)
      if (f[k - 1].t <= tr && tr <= f[k].t) {
        j = k;
        break;
      }
    const A = f[j - 1], B = f[j];
    if (j < 0 || A.h == null || B.h == null || A.trk == null || B.trk == null || B.t - A.t > 15000) return this._project(entry, tr, out);
    const T = (B.t - A.t) / 1000, s = (tr - A.t) / (B.t - A.t), s2 = s * s, s3 = s2 * s;
    const kx = 111320 * Math.cos(toRad(A.lat)), ky = 110540; // metres per degree
    const PB = [(B.lon - A.lon) * kx, (B.lat - A.lat) * ky, B.h - A.h];
    const vel = (F) => [F.gs * Math.sin(toRad(F.trk)), F.gs * Math.cos(toRad(F.trk)), F.vs];
    const vA = vel(A), vB = vel(B);
    const h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
    const P = [0, 1, 2].map((i) => h10 * T * vA[i] + h01 * PB[i] + h11 * T * vB[i]);
    const V = [0, 1, 2].map((i) => d10 * vA[i] + (d01 * PB[i]) / T + d11 * vB[i]);
    const lat = A.lat + P[1] / ky, lon = A.lon + P[0] / kx, h = A.h + P[2];
    const gs = Math.hypot(V[0], V[1]);
    const trk = gs > 5 ? norm360(toDeg(Math.atan2(V[0], V[1]))) : B.trk;
    return { pos: this.C.Cartesian3.fromDegrees(lon, lat, h, this.C.Ellipsoid.WGS84, out), lat, lon, h, gs, trk, vs: V[2], vsFit: vA[2] + (vB[2] - vA[2]) * s,
      turn: p_turn(entry.a, entry), stale: false, age: (nowMs - entry.recvMs) / 1000, onGround: false, smooth: true };
  }

  // Extrapolated position of an aircraft at time `nowMs` (back in time, too, for Smooth before a second fix):
  // Cartesian3 + speed/heading/vs used.
  _project(entry, nowMs, out) {
    const C = this.C, a = entry.a;
    const age = Math.max(-SMOOTH_DELAY_S, (nowMs - entry.recvMs) / 1000);
    const stale = age > STALE_S;
    const gs = fin(a.gs) ? a.gs * KT : 0;
    const trk0 = fin(a.track) ? a.track : fin(a.true_heading) ? a.true_heading : 0;
    const t = stale ? 0 : Math.min(age, STALE_S);
    // In a turn the track keeps coming round: predicted track now, and the chord of the arc flown since the fix
    // (along the mean of the two tracks). The turn is capped at 45° of prediction.
    const turn = p_turn(a, entry);
    const dTrk = clamp(turn * t, -45, 45);
    const trk = norm360(trk0 + dTrk), chord = norm360(trk0 + dTrk / 2);
    const d = gs * t; // metres along track (flat-earth step, fine over a few hundred m)
    const r = 6371008.8;
    const lat = a.lat + ((d * Math.cos((chord * Math.PI) / 180)) / r) * (180 / Math.PI);
    const lon = a.lon + ((d * Math.sin((chord * Math.PI) / 180)) / (r * Math.cos((a.lat * Math.PI) / 180))) * (180 / Math.PI);
    // The latest fix's fitted altitude and rate (altFit), when it's this position's; else the raw report.
    const fx = entry.fixes?.[entry.fixes.length - 1];
    const fitted = fx && fx.t === entry.recvMs && fx.h != null;
    const vs = fitted ? fx.vs : vrateMps(a);
    let h = fitted ? fx.h : heightM(a);
    if (h != null) h += vs * t;
    return { pos: C.Cartesian3.fromDegrees(lon, lat, h ?? 0, C.Ellipsoid.WGS84, out), lat, lon, h, gs, trk, vs, turn, stale, age, onGround: h == null };
  }

  // Surface height (ellipsoid metres) at a point, from the 3D tiles at full detail. scene.sampleHeight() reads
  // whatever coarse tiles happen to be loaded and can be off by kilometres away from the camera (it put CYHZ's
  // runway 32 threshold at 4,339 m), so this waits for the detailed tiles instead. Async; null when unknown.
  async _groundAt(lat, lon) {
    const C = this.C, scene = this.w?.scene;
    if (!scene) return null;
    const exclude = [this.points, this.labels, this.aprLines, this.bbs].filter(Boolean);
    try {
      const pos = [C.Cartographic.fromDegrees(lon, lat)];
      const out = this.tiles ? await scene.sampleHeightMostDetailed(pos, exclude) : await C.sampleTerrainMostDetailed(scene.terrainProvider, pos);
      const h = out?.[0]?.height;
      return fin(h) ? h : null;
    } catch (e) {
      return null;
    }
  }

  _frame() {
    if (this.destroyed || !this.w) return;
    const C = this.C, now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this._drawTraffic(now);
    const entry = this.sel && this.acs.get(this.sel);
    if (!entry) {
      if (this.chaseBb) this.chaseBb.show = false;
      if (this.model) this.model.show = false;
      this.$.status.textContent = this.sel ? "Aircraft out of range" : "Pick an aircraft on the map, or use ◀ ▶";
      this._hud(null);
      return;
    }
    const a = entry.a;
    const p = this._pos(entry, now, this._tmp || (this._tmp = new C.Cartesian3()));
    // Ground: aircraft on the ground (or with no altitude) sit 3 m above the sampled surface. Sampled once a second
    // (async); a sample above a flying aircraft is junk (the ground can't be over it) and is ignored.
    if (!this._groundBusy && now - (this._groundMs || 0) > 1000) {
      this._groundMs = now;
      this._groundBusy = true;
      const h = p.h, air = !p.onGround;
      this._groundAt(p.lat, p.lon).then((g) => {
        this._groundBusy = false;
        if (g != null && g < 9000 && !(air && h != null && g > h + 30)) this._ground = g;
      });
    }
    if (p.onGround) {
      const h = (this._ground ?? 0) + 3;
      C.Cartesian3.fromDegrees(p.lon, p.lat, h, C.Ellipsoid.WGS84, p.pos);
      p.h = h;
      this._vf = null;
    } else if (p.h != null) {
      // Height on a critically damped spring towards the curve, driven by the fitted climb rate: the curve passes
      // through every fix, and the fixes' timing jitter (a few tenths of a second at ~9 m/s in a descent) still made
      // it, and the pitch, wobble every 2 s. A steady climb or descent is followed with no lag.
      const ff = p.vsFit ?? p.vs, vf = this._vf;
      if (!vf || vf.sel !== this.sel || Math.abs(p.h - vf.h) > 150) this._vf = { sel: this.sel, h: p.h, v: ff };
      else {
        const w = 1 / ALT_TAU_S;
        vf.v += (w * w * (p.h - vf.h) + 2 * w * (ff - vf.v)) * dt;
        vf.h += vf.v * dt;
      }
      p.h = this._vf.h;
      p.vs = this._vf.v;
      C.Cartesian3.fromDegrees(p.lon, p.lat, p.h, C.Ellipsoid.WGS84, p.pos);
    }

    // Heading eases onto the predicted track (which itself comes round continuously in a turn).
    if (this.heading == null) this.heading = p.trk;
    else {
      const dh = diffDeg(p.trk, this.heading) * (1 - Math.exp(-dt / HEADING_TAU_S));
      this.heading = norm360(this.heading + clamp(dh, -HEADING_MAX_DPS * dt, HEADING_MAX_DPS * dt));
    }
    const vs = p.vs;
    const fpa = p.gs > 20 ? clamp((Math.atan2(vs, p.gs) * 180) / Math.PI, -12, 15) : 0;
    this.fpa = this.fpa == null ? fpa : slew(this.fpa, fpa, PITCH_SLEW_DPS * dt);
    // Bank: the reported roll when sent (rare), else the coordinated-turn bank for this speed and turn rate:
    // tan(bank) = v·ω / g. Eased in and out like a real roll-in.
    let bank = 0;
    if (fin(a.roll)) bank = a.roll;
    else if (p.gs > 30) bank = toDeg(Math.atan((p.gs * toRad(p.turn)) / G));
    bank = p.onGround ? 0 : clamp(bank, -BANK_LIMIT, BANK_LIMIT);
    if (this.bank == null) this.bank = bank;
    else {
      const db = (bank - this.bank) * (1 - Math.exp(-dt / BANK_TAU_S));
      this.bank += clamp(db, -BANK_MAX_DPS * dt, BANK_MAX_DPS * dt);
    }

    // Inertial anchor converging on the extrapolated position (GEV). On a Smooth curve it just follows the curve
    // (eased over a quarter second, to hide the step when it switches between the curve and extrapolation).
    if (!this.anchor) this.anchor = C.Cartesian3.clone(p.pos);
    else if (p.stale) C.Cartesian3.clone(p.pos, this.anchor);
    else if (p.smooth) {
      const corr = C.Cartesian3.subtract(p.pos, this.anchor, new C.Cartesian3());
      if (C.Cartesian3.magnitude(corr) > 2000) C.Cartesian3.clone(p.pos, this.anchor);
      else C.Cartesian3.add(this.anchor, C.Cartesian3.multiplyByScalar(corr, 1 - Math.exp(-dt / 0.25), corr), this.anchor);
    } else {
      const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
      const hr = C.Math.toRadians(this.heading);
      const step = new C.Cartesian3(Math.sin(hr) * p.gs * dt, Math.cos(hr) * p.gs * dt, vs * dt);
      C.Cartesian3.add(this.anchor, C.Matrix4.multiplyByPointAsVector(enu, step, step), this.anchor);
      const corr = C.Cartesian3.subtract(p.pos, this.anchor, new C.Cartesian3());
      const dist = C.Cartesian3.magnitude(corr);
      if (dist > 2000) C.Cartesian3.clone(p.pos, this.anchor); // a jump (new aircraft, bad fix): snap
      else {
        const s = correctionStep(dist, p.gs, dt);
        if (s > 0) C.Cartesian3.add(this.anchor, C.Cartesian3.multiplyByScalar(corr, s / dist, corr), this.anchor);
      }
    }

    // Camera: cockpit = a few metres ahead and above; follow = orbiting the aircraft (_followCam).
    const follow = this.mode === "chase";
    this.el.querySelector(".bore").style.display = follow ? "none" : "";
    this._placeAircraft(a, follow);
    this.w.camera.frustum.fov = C.Math.toRadians(follow ? 60 : this.fov);
    let pitch = 0;
    if (follow) this._followCam(dt, now, p);
    else {
      const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
      const hr = C.Math.toRadians(this.heading);
      const off = new C.Cartesian3(Math.sin(hr) * FORWARD_OFFSET_M, Math.cos(hr) * FORWARD_OFFSET_M, UP_OFFSET_M);
      const cam = this._aboveGround(C.Matrix4.multiplyByPoint(enu, off, new C.Cartesian3()), p.onGround ? 2 : MIN_CLEARANCE_M);
      pitch = VIEW_PITCH_DEG + this.fpa + this.look.pitch;
      this.w.camera.setView({
        destination: cam,
        orientation: {
          heading: C.Math.toRadians(norm360(this.heading + this.look.yaw)),
          pitch: C.Math.toRadians(pitch),
          roll: C.Math.toRadians(this.bank),
        },
      });
    }
    if (this.hudStyle && this.mode === "cockpit") this._drawHud(a, p, pitch, norm360(this.heading + this.look.yaw), this.bank || 0);
    const age = (now - entry.recvMs) / 1000;
    // The position's age, and any note about the 3D world (tiles unavailable) on a second line.
    const ageNote = age > LOST_S ? "Signal lost: holding last position" : age > NOTE_S ? `Last position ${Math.round(age)} s ago${p.stale ? ": holding" : ": estimating"}` : "";
    this.$.status.textContent = [ageNote, this._note || (!ageNote && this._rwyErr ? `Approach mode off: ${this._rwyErr}` : "")].filter(Boolean).join("\n");
    if (now - (this._aprMs || 0) > 500) {
      this._aprMs = now;
      this._approach = this._findApproach(a, p, now);
      this._drawApproachLines();
    }
    if (now - (this._hudMs || 0) > 100) {
      this._hudMs = now;
      this._hud(a, p);
      this._hudApproach();
    }
  }

  // Lifts a camera position to at least `clear` metres over the last surface sample (in place).
  _aboveGround(cam, clear) {
    const C = this.C, cc = C.Cartographic.fromCartesian(cam);
    if (cc && this._ground != null && cc.height < this._ground + clear) {
      cc.height = this._ground + clear;
      C.Cartographic.toCartesian(cc, C.Ellipsoid.WGS84, cam);
    }
    return cam;
  }

  // The follow view's aircraft at the anchor: heading, flight path angle and bank. Flightradar24's model for its type
  // (real size) once loaded, until then the built-in one (fin in the map colour, scaled by category), and if that
  // isn't ready either, the flat silhouette. `this.size` (a rough length) sets the follow camera's distance.
  _placeAircraft(a, show) {
    const C = this.C;
    for (const m of this._models.values()) if (m.model) m.model.show = false;
    if (this.model) this.model.show = false;
    this.chaseBb.show = false;
    this.$.mcredit.hidden = true;
    if (!show) return;
    const file = modelFor(this.opts.type?.(a) || a.t, a.category);
    const real = this._model(file); // { model } (model null while it downloads)
    // Model frame: heading/pitch/roll at the anchor (Cesium's heading 0 = east, hence - 90).
    const hpr = new C.HeadingPitchRoll(C.Math.toRadians(this.heading - 90), C.Math.toRadians(this.fpa || 0), C.Math.toRadians(this.bank || 0));
    const m = C.Transforms.headingPitchRollToFixedFrame(this.anchor, hpr, C.Ellipsoid.WGS84, undefined, this._mm || (this._mm = new C.Matrix4()));
    if (real.model) {
      // FR24's models face the other way (nose -X): turned round about their own vertical axis. Placed while it
      // loads too: a hidden model isn't loaded, and an unready one isn't drawn.
      const t = C.Matrix4.multiply(m, this._turn || (this._turn = C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationZ(Math.PI))), new C.Matrix4());
      real.model.modelMatrix = t; // copied by the setter
      real.model.show = true;
      if (real.model.ready) {
        this.size = real.model.boundingSphere.radius * 1.45; // the sphere spans wingtips and fin too: ~1.45 r is the length
        this.$.mcredit.hidden = false;
        return;
      }
    }
    this.size = LENGTH_M[a.category] || 38;
    const color = this.opts.color?.(a) || "#1f73d9";
    if (color !== this._modelColor && !this._modelBusy && !this._modelFailed) this._loadModel(color);
    if (this.model) {
      this.model.modelMatrix = C.Matrix4.multiplyByUniformScale(m, this.size, m);
      this.model.show = true; // also while it loads (a hidden model isn't loaded)
    }
    if (!this.model?.ready) {
      this.chaseBb.show = true;
      this.chaseBb.position = this.anchor;
      this.chaseBb.rotation = C.Math.toRadians(-(this.bank || 0));
    }
  }

  // Flightradar24's model `file` as { model } (null until downloaded); starts loading it the first time (a failure
  // isn't retried). The least recently used are dropped beyond MODELS_KEPT.
  _model(file) {
    let e = this._models.get(file);
    if (!e) {
      e = { model: null };
      this._models.set(file, e);
      this.C.Model.fromGltfAsync({ url: FR24_MODELS + file + ".glb", minimumPixelSize: 40, maximumScale: 20000 }).then((m) => {
        if (this.destroyed || !this.w || this._models.get(file) !== e) return void m.destroy(); // gone meanwhile
        m.customShader = new this.C.CustomShader({ lightingModel: this.C.LightingModel.PBR, fragmentShaderText: MODEL_SHADER(PLAIN_MODELS.has(file)) });
        e.model = this.w.scene.primitives.add(m);
      }, (err) => console.warn(`skyaware-cockpit: model ${file}`, err));
    }
    e.used = performance.now();
    if (this._models.size > MODELS_KEPT) {
      const [old] = [...this._models.entries()].filter(([f]) => f !== file).sort((p, q) => p[1].used - q[1].used)[0];
      const o = this._models.get(old);
      if (o.model) this.w.scene.primitives.remove(o.model); // destroys it
      this._models.delete(old);
    }
    return e;
  }

  async _loadModel(color) {
    const C = this.C;
    this._modelBusy = true;
    const c = C.Color.fromCssColorString(color) || C.Color.fromCssColorString("#1f73d9");
    const url = URL.createObjectURL(new Blob([aircraftGlb([c.red, c.green, c.blue])], { type: "model/gltf-binary" }));
    try {
      const m = await C.Model.fromGltfAsync({ url, forwardAxis: C.Axis.X, minimumPixelSize: 40, maximumScale: 20000, show: false });
      if (this.destroyed || !this.w) return;
      this.w.scene.primitives.add(m);
      if (this.model) this.w.scene.primitives.remove(this.model);
      this.model = m;
      this._modelColor = color;
    } catch (e) {
      console.warn("skyaware-cockpit: aircraft model", e);
      this._modelFailed = true;
    } finally {
      URL.revokeObjectURL(url);
      this._modelBusy = false;
    }
  }

  // Follow camera: orbits the anchor at the current angle (eased onto the target angle), its bearing trailing the
  // aircraft's heading on a critically damped spring; aimed at the aircraft, kept clear of the ground.
  _followCam(dt, now, p) {
    const C = this.C;
    if (this.camHdg == null) (this.camHdg = this.heading), (this.camHdgV = 0);
    const w = FOLLOW_SPRING;
    this.camHdgV += (w * w * diffDeg(this.heading, this.camHdg) - 2 * w * this.camHdgV) * dt;
    this.camHdg = norm360(this.camHdg + this.camHdgV * dt);
    const t = this.orbitT, o = this.orbit;
    if (this.view === "auto") {
      if (now - this._shotMs > AUTO_SHOT_S * 1000) {
        this._shotMs = now;
        this._shot = (this._shot + 1) % AUTO_SHOTS.length;
        Object.assign(t, AUTO_SHOTS[this._shot]);
      }
      t.yaw = norm360(t.yaw + AUTO_DRIFT_DPS * dt + 180) - 180;
    }
    const k = 1 - Math.exp(-dt / (this.view === "auto" ? AUTO_TAU_S : ORBIT_TAU_S));
    o.yaw = norm360(o.yaw + diffDeg(t.yaw, o.yaw) * k + 180) - 180;
    o.pitch += (t.pitch - o.pitch) * k;
    o.range *= Math.exp(Math.log(t.range / o.range) * k);
    // On the ground, never look up from below the surface.
    const pitch = p.onGround ? Math.max(o.pitch, 3) : o.pitch;
    const range = o.range * (this.size || 38), b = toRad(this.camHdg + 180 - o.yaw), pr = toRad(pitch);
    const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
    const off = new C.Cartesian3(Math.sin(b) * range * Math.cos(pr), Math.cos(b) * range * Math.cos(pr), range * Math.sin(pr));
    const cam = this._aboveGround(C.Matrix4.multiplyByPoint(enu, off, new C.Cartesian3()), p.onGround ? 2 : MIN_CLEARANCE_M);
    const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(this.anchor, cam, new C.Cartesian3()), new C.Cartesian3());
    const surfUp = C.Ellipsoid.WGS84.geodeticSurfaceNormal(cam, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, surfUp, new C.Cartesian3()), new C.Cartesian3());
    const up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    this.w.camera.setView({ destination: cam, orientation: { direction: dir, up } });
  }

  // ---- approach mode ---------------------------------------------------------------------------

  // Height of a threshold above the ellipsoid, from the rendered 3D surface (retried until the tiles are there).
  // Kept only if it's within 120 m of the published elevation (the geoid is within ~100 m of the ellipsoid
  // everywhere); otherwise the approach uses barometric altitude instead.
  _thresholdHeight(r, now) {
    if (r._h != null || r._busy || now - (r._hTry || 0) < 10000) return r._h ?? null;
    r._hTry = now;
    r._busy = true;
    this._groundAt(r.lat, r.lon).then((g) => {
      r._busy = false;
      if (g != null && Math.abs(g - r.elev * FT) < 120) r._h = g;
      else if (g != null) console.warn(`skyaware-cockpit: ${r.icao} ${r.id} surface sample ${g.toFixed(0)} m vs elevation ${(r.elev * FT).toFixed(0)} m, ignored`);
    });
    return null;
  }

  // The runway end this aircraft is approaching, if any: within 15 nm of the threshold and short of it, tracking
  // within 25° of the runway, within 2 nm of the extended centreline, below ~6,000 ft above the threshold and not
  // climbing. Prefers the flight's destination. The current runway is kept on looser limits (no flicker).
  _findApproach(a, p, now) {
    if (p.onGround || !this.runways?.length) return null;
    const fpm = fin(a.geom_rate) ? a.geom_rate : fin(a.baro_rate) ? a.baro_rate : 0;
    if (fpm > 500) return null;
    const dest = this.opts.dest?.(a);
    const cur = this._approach?.r;
    let best = null;
    for (const r of this.runways) {
      if (Math.abs(r.lat - p.lat) > 0.3) continue; // ~18 nm: cheap prefilter
      const keep = r === cur;
      const d = distNm(r.lat, r.lon, p.lat, p.lon);
      if (d > (keep ? 18 : 15)) continue;
      if (Math.abs(diffDeg(p.trk, r.hdg)) > (keep ? 40 : 25)) continue;
      const off = diffDeg(brgDeg(r.lat, r.lon, p.lat, p.lon), r.hdg + 180);
      const along = d * Math.cos(toRad(off)), cross = d * Math.sin(toRad(off));
      if (along < (keep ? 0.05 : 0.2) || Math.abs(cross) > (keep ? 3 : 2)) continue;
      // Height above the threshold: GPS altitude vs the 3D surface there, else baro corrected with the reported QNH.
      const thrH = this._thresholdHeight(r, now);
      let above, src;
      if (fin(a.alt_geom) && p.h != null && thrH != null) (above = (p.h - thrH) / FT), (src = "GPS");
      else if (fin(a.alt_baro)) {
        above = a.alt_baro + (fin(a.nav_qnh) ? (a.nav_qnh - 1013.25) * 27 : 0) - r.elev;
        src = fin(a.nav_qnh) ? "baro+QNH" : "baro";
      } else continue;
      if (above > (keep ? 7000 : 6000) || above < -200) continue;
      const score = Math.abs(cross) + along * 0.05 - (dest && dest === r.icao ? 5 : 0) - (keep ? 0.5 : 0);
      if (!best || score < best.score) best = { r, d, along, cross, above, src, score };
    }
    if (!best) return null;
    const alongFt = (best.along * NM) / FT;
    // Glideslope: angle above the glidepath origin, minus 3°. Positive = high.
    best.gsDev = toDeg(Math.atan2(best.above, alongFt + GPI_FT)) - GS_DEG;
    best.pathFt = Math.tan(toRad(GS_DEG)) * (alongFt + GPI_FT);
    // Localizer: angle seen from 1,000 ft beyond the far end. Positive = aircraft right of the centreline.
    const ant = destPt(best.r.flat, best.r.flon, best.r.hdg, 1000 * FT);
    best.locDev = -diffDeg(brgDeg(ant.lat, ant.lon, p.lat, p.lon), best.r.hdg + 180);
    return best;
  }

  // Extended centreline (dashed, 10 nm) and the 3° glidepath in the air, once the threshold's height is known.
  _drawApproachLines() {
    const C = this.C, ap = this._approach, r = ap?.r;
    const key = r && r._h != null ? r.icao + r.id : "";
    if (key === this._aprKey) return;
    this._aprKey = key;
    this.aprLines.removeAll();
    if (!key) return;
    const centre = [], path = [];
    for (let nm = 0; nm <= 10.001; nm += 0.25) {
      const pt = destPt(r.lat, r.lon, r.hdg + 180, nm * NM);
      centre.push(C.Cartesian3.fromDegrees(pt.lon, pt.lat, r._h + 3));
      path.push(C.Cartesian3.fromDegrees(pt.lon, pt.lat, r._h + Math.tan(toRad(GS_DEG)) * (nm * NM + GPI_FT * FT)));
    }
    this.aprLines.add({ positions: centre, width: 3, material: C.Material.fromType("PolylineDash", { color: C.Color.WHITE.withAlpha(0.85), dashLength: 20 }) });
    this.aprLines.add({ positions: path, width: 3, material: C.Material.fromType("Color", { color: C.Color.fromCssColorString("#ff6ef0").withAlpha(0.8) }) });
  }

  // ILS-style scales: glideslope on the right, localizer at the bottom. The diamonds show where the path is, as on a
  // real display: high puts the glideslope diamond below centre, right of course puts the localizer diamond left.
  _hudApproach() {
    const ap = this._approach;
    if (!ap) {
      if (this._aprShown) (this.$.apr.innerHTML = ""), (this.$.aprinfo.innerHTML = ""), (this._aprShown = false);
      return;
    }
    this._aprShown = true;
    const DOT = 30;
    const gs = clamp(ap.gsDev / GS_DOT_DEG, -2.6, 2.6), loc = clamp(-ap.locDev / LOC_DOT_DEG, -2.6, 2.6);
    const hud = this.hudStyle && this.mode === "cockpit";
    const mag = hud ? "#7CFC9A" : "#ff6ef0", dots = [-2, -1, 1, 2];
    let g = "";
    // Glideslope scale (x = 170)
    g += dots.map((k) => `<circle cx="170" cy="${k * DOT}" r="4" fill="none" stroke="#fff" stroke-width="1.6"/>`).join("");
    g += `<line x1="160" x2="180" y1="0" y2="0" stroke="#fff" stroke-width="2"/>`;
    g += `<path d="M170,${(gs * DOT - 9).toFixed(1)} L178,${(gs * DOT).toFixed(1)} L170,${(gs * DOT + 9).toFixed(1)} L162,${(gs * DOT).toFixed(1)} Z" fill="${mag}" stroke="#000" stroke-width="1"/>`;
    // Localizer scale (y = 128)
    g += dots.map((k) => `<circle cx="${k * DOT}" cy="128" r="4" fill="none" stroke="#fff" stroke-width="1.6"/>`).join("");
    g += `<line x1="0" x2="0" y1="118" y2="138" stroke="#fff" stroke-width="2"/>`;
    g += `<path d="M${(loc * DOT - 9).toFixed(1)},128 L${(loc * DOT).toFixed(1)},120 L${(loc * DOT + 9).toFixed(1)},128 L${(loc * DOT).toFixed(1)},136 Z" fill="${mag}" stroke="#000" stroke-width="1"/>`;
    this.$.apr.innerHTML = g;
    const dev = ap.above - ap.pathFt;
    const vert = Math.abs(dev) < 75 ? "on glidepath" : `${fmt(Math.abs(Math.round(dev / 10) * 10))} ft ${dev > 0 ? "high" : "low"}`;
    const lat = Math.abs(ap.cross) < 0.05 ? "on centreline" : `${fmt(Math.abs(ap.cross), 2)} nm ${ap.locDev > 0 ? "right" : "left"}`;
    this.$.aprinfo.innerHTML = `APPROACH <b>RWY ${esc(ap.r.id)} ${esc(ap.r.icao)}</b> · ${fmt(ap.along, 1)} nm · ${fmt(Math.max(0, ap.above))} ft above thr (${ap.src}) · ${vert} · ${lat}`;
  }

  // ---- HUD symbology ---------------------------------------------------------------------------
  // Drawn every frame over the 3D view, in screen pixels. The pitch ladder, horizon and flight path vector are
  // world-referenced: placed with the camera's real projection (the frustum's vertical field of view) and rolled with
  // the bank, so the horizon line sits on the 3D horizon. The rest is fixed to the "airframe" (the screen).
  _drawHud(a, p, camPitch, camHdg, roll) {
    const svg = this.$.hudsvg, W = svg.clientWidth || this.el.clientWidth, H = svg.clientHeight || 400;
    if (!W || !H) return;
    const G = "#7CFC9A", F = 'fill="#7CFC9A"', S = 'stroke="#7CFC9A" fill="none"';
    const fov = this.w.camera.frustum.fov, aspect = W / H;
    const fovy = aspect > 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
    const k = H / 2 / Math.tan(fovy / 2); // pixels per unit tangent
    const off = (deg) => k * Math.tan(toRad(clamp(deg, -80, 80)));
    const cx = W / 2, cy = H / 2;
    const n = (v) => v.toFixed(1);
    let o = "";

    // World-referenced: horizon with heading marks, pitch ladder, flight path vector (rotated by -roll).
    let w = "";
    const hy = -off(0 - camPitch); // horizon
    const tapeX = Math.min(W * 0.36, 430); // the tapes' distance from centre (below); the horizon stops short of them
    const half = Math.max(120, tapeX - 34);
    w += `<line x1="${n(-half)}" y1="${n(hy)}" x2="${n(-48)}" y2="${n(hy)}" ${S} stroke-width="1.6"/><line x1="48" y1="${n(hy)}" x2="${n(half)}" y2="${n(hy)}" ${S} stroke-width="1.6"/>`;
    for (let h = Math.ceil((camHdg - 40) / 5) * 5; h <= camHdg + 40; h += 5) {
      const x = off(diffDeg(norm360(h), camHdg));
      if (Math.abs(x) > half - 10 || Math.abs(x) < 50) continue;
      const big = norm360(h) % 10 === 0;
      w += `<line x1="${n(x)}" y1="${n(hy)}" x2="${n(x)}" y2="${n(hy - (big ? 9 : 5))}" ${S} stroke-width="1.3"/>`;
      if (big) w += `<text x="${n(x)}" y="${n(hy - 13)}" ${F} font-size="12" text-anchor="middle">${String(Math.round(norm360(h) / 10)).padStart(2, "0")}</text>`;
    }
    for (let e = -20; e <= 25; e += 5) {
      if (!e) continue;
      const y = -off(e - camPitch);
      if (Math.abs(y) > H * 0.4) continue;
      const lo = 46, hi = 112, tk = e > 0 ? 7 : -7, dash = e < 0 ? ' stroke-dasharray="9 6"' : "";
      w += `<path d="M${-hi},${n(y + tk)} L${-hi},${n(y)} L${-lo},${n(y)}" ${S} stroke-width="1.5"${dash}/><path d="M${hi},${n(y + tk)} L${hi},${n(y)} L${lo},${n(y)}" ${S} stroke-width="1.5"${dash}/>`;
      w += `<text x="${-hi - 6}" y="${n(y + 4)}" ${F} font-size="12" text-anchor="end">${e}</text><text x="${hi + 6}" y="${n(y + 4)}" ${F} font-size="12">${e}</text>`;
    }
    // Flight path vector: where the aircraft is going (track and flight-path angle).
    const fx = off(diffDeg(p.trk, camHdg)), fy = -off((this.fpa || 0) - camPitch);
    w += `<g transform="translate(${n(fx)},${n(fy)})"><circle r="8" ${S} stroke-width="2"/><path d="M-22,0H-8M8,0H22M0,-8V-17" ${S} stroke-width="2"/></g>`;
    o += `<g transform="translate(${n(cx)},${n(cy)}) rotate(${n(-roll)})">${w}</g>`;

    // Airframe-fixed: boresight, bank scale, heading box, tapes, modes, data.
    const bsy = cy - off(2); // roughly the nose, a little above the camera axis
    o += `<path d="M${n(cx - 26)},${n(bsy)} H${n(cx - 12)} L${n(cx - 6)},${n(bsy + 7)} L${n(cx)},${n(bsy)} L${n(cx + 6)},${n(bsy + 7)} L${n(cx + 12)},${n(bsy)} H${n(cx + 26)}" ${S} stroke-width="1.6"/>`;
    // Bank scale (sky pointer moves with the horizon).
    const R = Math.min(H * 0.36, 230), pt = (d, r) => [cx + Math.sin(toRad(d)) * r, cy - Math.cos(toRad(d)) * r];
    for (const d of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const L = d === 0 ? 0 : Math.abs(d) % 30 === 0 ? 14 : 8;
      if (L) {
        const [x1, y1] = pt(d, R), [x2, y2] = pt(d, R + L);
        o += `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${S} stroke-width="1.6"/>`;
      }
    }
    o += `<path d="M${n(cx)},${n(cy - R - 2)} l-6,-10 h12 z" ${S} stroke-width="1.5"/>`;
    o += `<g transform="rotate(${n(-clamp(roll, -60, 60))} ${n(cx)} ${n(cy)})"><path d="M${n(cx)},${n(cy - R + 3)} l-7,11 h14 z" ${F}/></g>`;
    if (Math.abs(roll) >= 2) o += `<text x="${n(cx)}" y="${n(cy - R + 30)}" ${F} font-size="12" text-anchor="middle">${Math.round(Math.abs(roll))}° ${roll > 0 ? "R" : "L"}${fin(a.roll) ? "" : " est."}</text>`;
    // Heading box and selected heading.
    const hb = cy - R - 30;
    o += `<rect x="${n(cx - 30)}" y="${n(hb - 15)}" width="60" height="20" ${S} stroke-width="1.5"/><text x="${n(cx)}" y="${n(hb)}" ${F} font-size="14" text-anchor="middle">H ${String(Math.round(camHdg) % 360).padStart(3, "0")}</text>`;
    if (fin(a.nav_heading)) o += `<text x="${n(cx + 40)}" y="${n(hb)}" ${F} font-size="12">SEL ${String(Math.round(a.nav_heading)).padStart(3, "0")}</text>`;
    // Mode annunciators (sent by some aircraft): autopilot, LNAV, VNAV, ALT, APP, TCAS.
    const MODES = { autopilot: "AP", lnav: "LNAV", vnav: "VNAV", althold: "ALT", approach: "APP", tcas: "TCAS" };
    const modes = (Array.isArray(a.nav_modes) ? a.nav_modes : []).map((m) => MODES[m]).filter(Boolean);
    if (modes.length) o += `<text x="${n(cx - R)}" y="${n(hb)}" ${F} font-size="12" text-anchor="middle">${esc(modes.join("  "))}</text>`;

    // Tapes: ground speed (left), altitude (right). The boxed value is the current one.
    const tH = Math.min(H * 0.5, 320), top = cy - tH / 2;
    const tape = (x, side, val, step, label, span, fmtv, title, unit) => {
      let t = `<line x1="${n(x)}" y1="${n(top)}" x2="${n(x)}" y2="${n(top + tH)}" ${S} stroke-width="1.5"/>`;
      const px = tH / span;
      for (let v = Math.ceil((val - span / 2) / step) * step; v <= val + span / 2; v += step) {
        if (v < 0 && unit === "kt") continue;
        const y = cy - (v - val) * px, majr = v % label === 0;
        t += `<line x1="${n(x)}" y1="${n(y)}" x2="${n(x + side * (majr ? 12 : 7))}" y2="${n(y)}" ${S} stroke-width="1.3"/>`;
        if (majr && Math.abs(y - cy) > 16) t += `<text x="${n(x + side * 16)}" y="${n(y + 4)}" ${F} font-size="12" text-anchor="${side > 0 ? "start" : "end"}">${fmtv(v)}</text>`;
      }
      const bw = 66, bx = side > 0 ? x + 4 : x - 4 - bw;
      t += `<rect x="${n(bx)}" y="${n(cy - 13)}" width="${bw}" height="26" fill="rgba(0,0,0,.35)" stroke="${G}" stroke-width="1.6"/><text x="${n(bx + bw / 2)}" y="${n(cy + 6)}" ${F} font-size="16" text-anchor="middle">${fmtv(Math.round(val))}</text>`;
      t += `<text x="${n(x + side * 10)}" y="${n(top - 10)}" ${F} font-size="12" text-anchor="${side > 0 ? "start" : "end"}">${title}</text>`;
      return t;
    };
    const lx = cx - tapeX, rx = cx + tapeX;
    const gs = fin(a.gs) ? a.gs : 0;
    o += tape(lx, -1, gs, 10, 20, 120, (v) => String(v), "GS", "kt");
    const alt = a.alt_baro === "ground" ? 0 : fin(a.alt_baro) ? a.alt_baro : 0;
    o += tape(rx, 1, alt, 100, 500, 1200, (v) => fmt(v), fin(a.nav_altitude_mcp) ? `SEL ${fmt(a.nav_altitude_mcp)}` : "ALT", "ft");
    // Selected altitude bug on the tape.
    if (fin(a.nav_altitude_mcp) && Math.abs(a.nav_altitude_mcp - alt) < 600) {
      const by = cy - (a.nav_altitude_mcp - alt) * (tH / 1200);
      o += `<path d="M${n(rx)},${n(by)} l-9,-7 v14 z" ${S} stroke-width="1.6"/>`;
    }
    // Vertical speed and baro under the altitude tape; distance/runway under the speed tape.
    const fpm = fin(a.geom_rate) ? a.geom_rate : a.baro_rate;
    if (fin(fpm) && Math.abs(fpm) >= 100) o += `<text x="${n(rx + 10)}" y="${n(top + tH + 22)}" ${F} font-size="13">${fpm > 0 ? "+" : "−"}${fmt(Math.abs(Math.round(fpm / 50) * 50))} VS</text>`;
    if (fin(a.nav_qnh)) o += `<text x="${n(rx + 10)}" y="${n(top + tH + 40)}" ${F} font-size="12">BARO ${Math.round(a.nav_qnh)}</text>`;
    const ap = this._approach;
    if (ap) o += `<text x="${n(lx - 10)}" y="${n(top + tH + 22)}" ${F} font-size="13" text-anchor="end">DME ${fmt(ap.along, 1)}</text><text x="${n(lx - 10)}" y="${n(top + tH + 40)}" ${F} font-size="12" text-anchor="end">RWY ${esc(ap.r.id)} ${esc(ap.r.icao)}</text>`;

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = o;
  }

  _drawTraffic(now) {
    const C = this.C;
    const keep = new Set();
    for (const [hex, entry] of this.acs) {
      const isSel = hex === this.sel;
      if (isSel) continue; // cockpit: we're in it; follow: drawn as the 3D model at the anchor
      const p = this._pos(entry, now, new C.Cartesian3());
      if (p.onGround) continue;
      keep.add(hex);
      let m = this.marks.get(hex);
      if (!m) {
        m = {
          pt: this.points.add({ pixelSize: 9, outlineColor: C.Color.BLACK, outlineWidth: 1.5 }),
          lb: this.labels.add({ font: "600 13px sans-serif", fillColor: C.Color.WHITE, showBackground: true,
            backgroundColor: new C.Color(0, 0, 0, 0.55), backgroundPadding: new C.Cartesian2(5, 3),
            pixelOffset: new C.Cartesian2(10, -10), horizontalOrigin: C.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new C.DistanceDisplayCondition(0, 400000) }),
        };
        this.marks.set(hex, m);
      }
      m.pt.position = p.pos;
      m.lb.position = p.pos;
      if (now - (m.styledMs || 0) > 1000) {
        m.styledMs = now;
        const a = entry.a;
        m.pt.color = C.Color.fromCssColorString(this.opts.color?.(a) || "#ffcc00");
        m.pt.pixelSize = isSel ? 13 : 9;
        const cs = (a.flight || "").trim() || hex.toUpperCase();
        m.lb.text = `${cs}  ${fin(a.alt_baro) ? fmt(Math.round(a.alt_baro / 100) * 100) + " ft" : ""}`;
      }
    }
    for (const [hex, m] of this.marks) {
      if (keep.has(hex)) continue;
      this.points.remove(m.pt);
      this.labels.remove(m.lb);
      this.marks.delete(hex);
    }
  }

  _hud(a, p) {
    if (!a) {
      this.$.cs.textContent = "";
      this.$.sub.textContent = "";
      this.$.spd.textContent = this.$.alt.textContent = "–";
      this.$.vs.textContent = "";
      this.$.tape.innerHTML = "";
      this.$.bankind.innerHTML = "";
      return;
    }
    const lab = this.opts.label?.(a) || {};
    this.$.cs.textContent = lab.cs || (a.flight || "").trim() || a.hex.toUpperCase();
    this.$.sub.innerHTML = esc(lab.sub || "") + (fin(a.roll) ? ` · bank ${fmt(Math.abs(this.bank ?? 0))}° (reported)` : "");
    this.$.spd.textContent = fmt(a.gs);
    this.$.alt.textContent = a.alt_baro === "ground" ? "GND" : fmt(a.alt_baro);
    const fpm = fin(a.geom_rate) ? a.geom_rate : a.baro_rate;
    this.$.vs.textContent = fin(fpm) && Math.abs(fpm) >= 100 ? `${fpm > 0 ? "▲" : "▼"} ${fmt(Math.abs(fpm))} fpm` : "";
    // Heading tape: ±60° across 420 px, ticks every 5°, numbers every 30°.
    const hdg = norm360((this.heading ?? 0) + this.look.yaw);
    let g = "";
    for (let d = Math.ceil((hdg - 60) / 5) * 5; d <= hdg + 60; d += 5) {
      const x = ((d - hdg) / 60) * 200;
      const v = norm360(d);
      const big = v % 30 === 0;
      g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${big ? 16 : 21}" y2="28" stroke="#fff" stroke-width="${big ? 1.6 : 1}"/>`;
      if (big && Math.abs(x) > 30) g += `<text x="${x.toFixed(1)}" y="12" fill="#fff" font-size="11" text-anchor="middle">${({ 0: "N", 90: "E", 180: "S", 270: "W" })[v] ?? String(v / 10).padStart(2, "0")}</text>`;
    }
    g += `<path d="M-6,34L0,28L6,34" fill="#7CFC9A"/><text x="0" y="12" dy="-0" fill="none"></text>`;
    g += `<rect x="-20" y="-1" width="40" height="15" rx="3" fill="rgba(0,0,0,.55)" stroke="#7CFC9A"/><text x="0" y="11" fill="#7CFC9A" font-size="12" text-anchor="middle">${String(Math.round(hdg) % 360).padStart(3, "0")}</text>`;
    this.$.tape.innerHTML = g;
    this._hudBank(a);
  }

  // Bank indicator, as on an airliner's display: a fixed arc with ticks at 10/20/30 (and 45, 60) degrees each side and
  // a sky pointer that moves with the horizon (right bank swings it left), plus "14° R" (est. = from the turn rate).
  _hudBank(a) {
    if (!a) return void (this.$.bankind.innerHTML = "");
    const R = 104, bank = this.bank || 0;
    const pt = (deg, r) => [Math.sin(toRad(deg)) * r, -Math.cos(toRad(deg)) * r];
    let g = `<path d="M${pt(-60, R).join(",")} A${R},${R} 0 0 1 ${pt(60, R).join(",")}" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1.6"/>`;
    for (const d of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const len = Math.abs(d) === 30 || Math.abs(d) === 60 ? 13 : 8;
      const [x1, y1] = pt(d, R), [x2, y2] = pt(d, R + len);
      g += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fff" stroke-width="${len > 8 ? 2 : 1.5}"/>`;
    }
    g += `<path d="M0,${-R - 2} L-6,${-R - 12} L6,${-R - 12} Z" fill="none" stroke="#fff" stroke-width="1.6"/>`; // zero mark
    // Sky pointer: rotates opposite the bank, along the inside of the arc.
    const b = clamp(bank, -60, 60);
    g += `<g transform="rotate(${(-b).toFixed(1)})"><path d="M0,${-R + 2} L-7,${-R + 14} L7,${-R + 14} Z" fill="#7CFC9A" stroke="#000" stroke-width="1"/></g>`;
    const est = !fin(a.roll);
    if (Math.abs(bank) >= 2) g += `<text x="0" y="${-R + 34}" fill="#7CFC9A" font-size="13" font-weight="700" stroke="#000" stroke-width="2.5" paint-order="stroke" text-anchor="middle">${Math.round(Math.abs(bank))}° ${bank > 0 ? "R" : "L"}${est ? '<tspan fill-opacity=".7" font-size="10"> est.</tspan>' : ""}</text>`;
    this.$.bankind.innerHTML = g;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._tilesTimer);
    this._removePre?.();
    for (const off of this._listeners) off();
    this._listeners = [];
    try {
      this.w?.destroy();
    } catch (e) {}
    this.w = null;
    this.el.innerHTML = "";
  }
}
