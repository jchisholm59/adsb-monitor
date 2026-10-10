// Cockpit view for skyaware-card: the selected aircraft's view out of the windscreen over Google's photorealistic
// 3D world (CesiumJS + Cesium ion), with a HUD. Loaded by skyaware-card.js only when the Cockpit tab opens, so the
// map never pays for Cesium (several MB, from Cesium's CDN).
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

const CESIUM_VERSION = "1.146";
const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;
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
const CHASE_BACK_M = 220;
const CHASE_UP_M = 45;
// The chased aircraft from behind: fuselage, wings with a little dihedral, tailplane and fin.
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
    s.src = CESIUM_BASE + "Cesium.js";
    s.async = true;
    s.onload = () => (window.Cesium ? resolve(window.Cesium) : reject(new Error("Cesium did not load")));
    s.onerror = () => {
      cesiumLoading = null;
      s.remove();
      reject(new Error("Couldn't download CesiumJS from cesium.com"));
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
  const KEY = "skyaware-card:runways2"; // 2: headings from the end coordinates
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
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), lat: rx.lat, lon: rx.lon, ends }));
  } catch (e) {}
  return ends;
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

function vrateMps(a) {
  const fpm = fin(a.geom_rate) ? a.geom_rate : fin(a.baro_rate) ? a.baro_rate : 0;
  return a.alt_baro === "ground" ? 0 : fpm * FT / 60;
}

const STYLE = `
  .ck { position: relative; width: 100%; height: min(70vh, 640px); min-height: 320px; border-radius: 12px; overflow: hidden; background: #0b1020; color: #e8f0ff; font-variant-numeric: tabular-nums; }
  .ck .scene { position: absolute; inset: 0; }
  .ck .scene canvas { display: block; touch-action: none; }
  .ck .credits { position: absolute; left: 8px; bottom: 6px; font-size: 10px; opacity: .8; max-width: 55%; pointer-events: auto; }
  .ck .credits img { max-height: 16px; vertical-align: middle; }
  .ck .credits a { color: inherit; }
  .ck .credits .cesium-credit-lightbox-overlay { position: fixed; }
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
  .ck .status:empty { display: none; }
  .ck .apr { position: absolute; left: 50%; top: 50%; width: 380px; height: 290px; transform: translate(-50%, -50%); overflow: visible; }
  .ck .aprinfo { position: absolute; left: 50%; top: 50px; transform: translateX(-50%); padding: 3px 10px; border: 1.5px solid #ff6ef0; border-radius: 6px; background: rgba(0,0,0,.35); color: #ffb8f6; font-size: .85em; white-space: nowrap; }
  .ck .aprinfo:empty { display: none; }
  .ck .aprinfo b { color: #fff; }
  .ck .build { position: absolute; right: 12px; bottom: 46px; font-size: 10px; opacity: .45; }
  .ck .btns { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .ck .btns button { font: inherit; font-size: .85em; color: #fff; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.35); border-radius: 999px; padding: 5px 11px; cursor: pointer; }
  .ck .btns button:hover { background: rgba(255,255,255,.18); }
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
  //         receiver {lat, lon} (for the runway list), dest(a) -> destination ICAO (preferred runway for approach mode) }
  constructor(container, opts) {
    this.el = container;
    this.opts = opts;
    this.acs = new Map(); // hex -> { a, recvMs }
    this.sel = null;
    this.mode = "cockpit"; // or "chase"
    this.look = { yaw: 0, pitch: 0 };
    this.fov = 60;
    this.destroyed = false;
    this._listeners = [];
    this._render();
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
          <svg class="apr" viewBox="-190 -145 380 290"></svg>
          <div class="aprinfo"></div>
          <div class="status"></div>
          <div class="build">${BUILD ? "v" + esc(BUILD) : ""}</div>
          <div class="btns">
            <button data-ck="prev" title="Previous aircraft (by distance)">◀</button>
            <button data-ck="next" title="Next aircraft (by distance)">▶</button>
            <button data-ck="mode">Chase view</button>
            <button data-ck="reset" title="Look ahead again">Look ahead</button>
            <button data-ck="exit">Map</button>
          </div>
        </div>
        <div class="credits"></div>
        <div class="msg">Loading the 3D world…</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { apr: q(".apr"), aprinfo: q(".aprinfo"), scene: q(".scene"), cs: q(".ident .cs"), sub: q(".ident .sub"), tape: q(".tape"), spd: q(".spd b"),
      alt: q(".alt b"), vs: q(".alt .vs"), status: q(".status"), msg: q(".msg"), credits: q(".credits"), mode: q('[data-ck="mode"]') };
    this._on(this.el, "click", (e) => {
      const b = e.target.closest("[data-ck]");
      if (!b) return;
      const act = b.dataset.ck;
      if (act === "exit") this.opts.onExit?.();
      else if (act === "next" || act === "prev") this._step(act === "next" ? 1 : -1);
      else if (act === "mode") {
        this.mode = this.mode === "cockpit" ? "chase" : "cockpit";
        this.$.mode.textContent = this.mode === "cockpit" ? "Chase view" : "Cockpit view";
        this.look = { yaw: 0, pitch: 0 };
      } else if (act === "reset") (this.look = { yaw: 0, pitch: 0 }), (this.fov = 60);
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
      l.href = CESIUM_BASE + "Widgets/widgets.css";
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
    try {
      const res = await C.IonResource.fromAssetId(GOOGLE_3D_ASSET, { accessToken: token });
      if (this.destroyed) return;
      this.tiles = await C.Cesium3DTileset.fromUrl(res, { cacheBytes: 768 * 1024 * 1024, enableCollision: true, asynchronouslyLoadImagery: true });
      if (this.destroyed) return;
      scene.primitives.add(this.tiles);
      scene.globe.show = false;
    } catch (e) {
      // No Google tiles (token scope, quota, or the asset not added to the ion account): Cesium World Terrain + imagery.
      console.warn("skyaware-cockpit: Google 3D tiles unavailable, falling back to terrain", e);
      try {
        w.scene.imageryLayers.add(C.ImageryLayer.fromProviderAsync(C.IonImageryProvider.fromAssetId(2)));
        w.scene.terrainProvider = await C.createWorldTerrainAsync();
        this._note = "Google 3D tiles unavailable on this token: showing terrain";
      } catch (e2) {
        const m = String(e2?.message || e?.message || e2 || e);
        if (/401|403|Invalid access token|Unauthorized/i.test(m))
          this._askToken(`<b>Cesium ion refused the token.</b> Check it was copied whole, and that its Allowed URLs include <code>${esc(location.origin)}</code>, or paste another.`);
        else this.$.msg.innerHTML = `<div>Couldn't load the 3D world: ${esc(m)}</div>`;
        return;
      }
    }
    if (this.destroyed) return;
    this.points = scene.primitives.add(new C.PointPrimitiveCollection());
    this.bbs = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.chaseBb = this.bbs.add({ image: REAR_SVG, width: 132, height: 66, show: false });
    this.labels = scene.primitives.add(new C.LabelCollection());
    this.marks = new Map(); // hex -> { pt, lb }
    this.aprLines = scene.primitives.add(new C.PolylineCollection());
    this.$.msg.textContent = "";
    this._initInput();
    this._last = performance.now();
    this._removePre = scene.preUpdate.addEventListener(() => this._frame());
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

  _initInput() {
    const cv = this.w.canvas;
    let drag = null;
    this._on(cv, "pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, yaw: this.look.yaw, pitch: this.look.pitch };
      cv.setPointerCapture?.(e.pointerId);
    });
    this._on(cv, "pointermove", (e) => {
      if (!drag) return;
      const k = this.fov / Math.max(200, cv.clientWidth);
      this.look.yaw = norm360(drag.yaw - (e.clientX - drag.x) * k + 180) - 180;
      this.look.pitch = clamp(drag.pitch + (e.clientY - drag.y) * k, -80, 60);
    });
    const end = () => (drag = null);
    this._on(cv, "pointerup", end);
    this._on(cv, "pointercancel", end);
    this._on(cv, "dblclick", () => (this.look = { yaw: 0, pitch: 0 }));
    this._on(cv, "wheel", (e) => {
      e.preventDefault();
      this.fov = clamp(this.fov * Math.exp(e.deltaY * 0.001), 15, 100);
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
        const e = { a, recvMs: now - (a.seen_pos || 0) * 1000, hist: old?.hist || [], turn: old?.turn || 0 };
        const t = e.recvMs / 1000, trk = fin(a.track) ? a.track : fin(a.true_heading) ? a.true_heading : null;
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
      this.heading = this.bank = this.fpa = null;
      this.look = { yaw: 0, pitch: 0 };
    }
  }

  _step(dir) {
    const list = [...this.acs.values()].map((x) => x.a).filter((a) => a.alt_baro !== "ground").sort((p, q) => (p._dist ?? 1e9) - (q._dist ?? 1e9));
    if (!list.length) return;
    const i = list.findIndex((a) => a.hex === this.sel);
    const next = list[(i + dir + list.length) % list.length];
    this.opts.onPick?.(next.hex);
  }

  // Extrapolated position of an aircraft at time `nowMs`: Cartesian3 + speed/heading/vs used.
  _project(entry, nowMs, out) {
    const C = this.C, a = entry.a;
    const age = Math.max(0, (nowMs - entry.recvMs) / 1000);
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
    let h = heightM(a);
    if (h != null) h += vrateMps(a) * t;
    return { pos: C.Cartesian3.fromDegrees(lon, lat, h ?? 0, C.Ellipsoid.WGS84, out), lat, lon, h, gs, trk, turn, stale, age, onGround: h == null };
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
      this.$.status.textContent = this.sel ? "Aircraft out of range" : "Pick an aircraft on the map, or use ◀ ▶";
      this._hud(null);
      return;
    }
    const a = entry.a;
    const p = this._project(entry, now, this._tmp || (this._tmp = new C.Cartesian3()));
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
    }

    // Heading eases onto the predicted track (which itself comes round continuously in a turn).
    if (this.heading == null) this.heading = p.trk;
    else {
      const dh = diffDeg(p.trk, this.heading) * (1 - Math.exp(-dt / HEADING_TAU_S));
      this.heading = norm360(this.heading + clamp(dh, -HEADING_MAX_DPS * dt, HEADING_MAX_DPS * dt));
    }
    const vs = vrateMps(a);
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

    // Inertial anchor converging on the extrapolated position (GEV).
    if (!this.anchor) this.anchor = C.Cartesian3.clone(p.pos);
    else if (p.stale) C.Cartesian3.clone(p.pos, this.anchor);
    else {
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

    // Camera: cockpit = a few metres ahead and above; chase = behind and above, looking at the aircraft.
    const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
    const hr = C.Math.toRadians(this.heading);
    const off = this.mode === "cockpit"
      ? new C.Cartesian3(Math.sin(hr) * FORWARD_OFFSET_M, Math.cos(hr) * FORWARD_OFFSET_M, UP_OFFSET_M)
      : new C.Cartesian3(-Math.sin(hr) * CHASE_BACK_M, -Math.cos(hr) * CHASE_BACK_M, CHASE_UP_M);
    const cam = C.Matrix4.multiplyByPoint(enu, off, new C.Cartesian3());
    // Never below the surface (+ clearance).
    const cc = C.Cartographic.fromCartesian(cam);
    if (cc && this._ground != null && cc.height < this._ground + (p.onGround ? 2 : MIN_CLEARANCE_M)) {
      cc.height = this._ground + (p.onGround ? 2 : MIN_CLEARANCE_M);
      C.Cartographic.toCartesian(cc, C.Ellipsoid.WGS84, cam);
    }
    const chasePitch = (-Math.atan2(CHASE_UP_M, CHASE_BACK_M) * 180) / Math.PI; // aimed straight at the aircraft
    const pitch = (this.mode === "cockpit" ? VIEW_PITCH_DEG + this.fpa : chasePitch) + this.look.pitch;
    // The chased aircraft is drawn where the camera follows (the smoothed anchor), banked like it.
    this.chaseBb.show = this.mode === "chase";
    this.el.querySelector(".bore").style.display = this.mode === "chase" ? "none" : "";
    if (this.mode === "chase") {
      this.chaseBb.position = this.anchor;
      this.chaseBb.rotation = C.Math.toRadians(-(this.bank || 0));
    }
    this.w.camera.frustum.fov = C.Math.toRadians(this.fov);
    this.w.camera.setView({
      destination: cam,
      orientation: {
        heading: C.Math.toRadians(norm360(this.heading + this.look.yaw)),
        pitch: C.Math.toRadians(pitch),
        roll: C.Math.toRadians(this.mode === "cockpit" ? this.bank : 0),
      },
    });
    const age = (now - entry.recvMs) / 1000;
    this.$.status.textContent = age > LOST_S ? "Signal lost: holding last position"
      : age > NOTE_S ? `Last position ${Math.round(age)} s ago${p.stale ? ": holding" : ": estimating"}`
      : this._note || (this._rwyErr ? `Approach mode off: ${this._rwyErr}` : "");
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
    const mag = "#ff6ef0", dots = [-2, -1, 1, 2];
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

  _drawTraffic(now) {
    const C = this.C;
    const keep = new Set();
    for (const [hex, entry] of this.acs) {
      const isSel = hex === this.sel;
      if (isSel) continue; // cockpit: we're in it; chase: drawn as the silhouette at the camera's anchor
      const p = this._project(entry, now, new C.Cartesian3());
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
  }

  destroy() {
    this.destroyed = true;
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
