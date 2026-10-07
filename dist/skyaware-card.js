// SkyAware card for Home Assistant (custom:skyaware-card). See README.md.
// Live aircraft from the PiAware/SkyAware receiver (dump1090-fa's data/aircraft.json, which has CORS open) as a card
// with four tabs: a map (range rings, trails, altitude colours, like SkyAware's), a sortable aircraft list, the
// selected flight's status (route, progress, ETA, aircraft, live data) and the original SkyAware page.
// Routes come from adsb.im's routeset API (which checks the route against the plane's position), airline and
// aircraft details from adsbdb.com, photos from adsbdb or Planespotters. All are free, keyless and CORS-enabled.
// The ETA is an estimate: great-circle distance to go / current ground speed.
// Coverage history, phone alerts (squawks, military, helicopters, watched flights landing) and a CORS proxy for use
// over a VPN come from adsb-monitor (https://github.com/jchisholm59/adsb-monitor), a small always-on service.
// Install: copy to /config/www/ha-cards/, add /local/ha-cards/skyaware-card.js as a JavaScript module resource.

const DEFAULTS = {
  title: "Planes",
  urls: [], // PiAware, e.g. ["http://192.168.1.50"]; the first that answers is used. Empty: through `monitor`
  monitor: [], // adsb-monitor, e.g. ["http://192.168.1.20:7100", "http://100.x.y.z:7100"] (LAN, then VPN)
  path: "/skyaware/", // SkyAware on that box
  rings: [50, 100, 150, 200], // range rings, nm
  refresh: 2, // seconds between aircraft.json polls
  trail_minutes: 30,
  lookups: true, // routes / aircraft details / photos from the internet
};

const NM = 3440.065; // earth radius, nm
const RAD = Math.PI / 180;
const TABS = [["map", "Map", "mdi:map"], ["list", "Aircraft", "mdi:format-list-bulleted"], ["flight", "Flight", "mdi:airplane"],
  ["coverage", "Coverage", "mdi:radar"], ["alerts", "Alerts", "mdi:bell-ring-outline"], ["skyaware", "SkyAware", "mdi:web"]];
// Coverage altitude bands (as adsb-monitor records them), coloured like the map's altitude scale.
const BANDS = [["high", "Above 25,000 ft", 35000], ["mid", "10,000–25,000 ft", 15000], ["low", "Below 10,000 ft", 1500]];
const RANGES = [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]];
const SQUAWKS = { "7500": "Hijack", "7600": "Radio failure", "7700": "Emergency" };
const SQUAWK_EMERGENCY = { "7500": "unlawful", "7600": "nordo", "7700": "general" }; // matching ADS-B emergency status
const CATEGORY = {
  A1: "Light (< 7 t)", A2: "Small (7–34 t)", A3: "Large (34–136 t)", A4: "High vortex (B757)", A5: "Heavy (> 136 t)",
  A6: "High performance", A7: "Rotorcraft", B1: "Glider", B2: "Balloon", B4: "Ultralight", B6: "Drone",
  C1: "Emergency vehicle", C2: "Service vehicle", C3: "Obstruction",
};
// Aircraft classes, most specific first. Military/helicopter flags come from adsb-monitor's database when available.
const CLASSES = [
  ["mil", "Military", "mdi:shield-airplane", "#d4a72c"],
  ["heli", "Helicopter", "mdi:helicopter", "#26a69a"],
  ["com", "Commercial", "mdi:airplane", "#4ea1ff"],
  ["priv", "Private", "mdi:account", "#b07cf0"],
  ["other", "Unclassified", "mdi:shape-outline", "#9e9e9e"],
  ["unk", "Unknown", "mdi:help-circle-outline", "#6f6f6f"],
];
const CLASS = Object.fromEntries(CLASSES.map(([k, l, i, c]) => [k, { k, l, i, c }]));
const MIL_RANGES = [[0xadf7c8, 0xafffff], [0xc20000, 0xc3ffff], [0x43c000, 0x43cfff], [0x3aa000, 0x3affff], [0x3b7000, 0x3bffff], [0x3ea000, 0x3ebfff], [0x3f4000, 0x3fbfff]];
const MIL_CALLSIGN = /^(CFC|RCH|CNV|RRR|ASY|NATO|PAT|SAM|SPAR|GAF|CTM|BAF|IAM|HKY|KIWI|TUAF|VENUS|NAVY|ARMY|EVAC|REACH|TOPCT)\d/;
// Callsigns that are registrations: US N-numbers, Canadian C-Fxxx/C-Gxxx/C-Ixxx, and other "prefix + letters" ones.
const REG_CALLSIGN = /^(N[1-9][0-9A-Z]{0,4}|C[FGI][A-Z]{3}|G[A-Z]{4}|D[A-Z]{4}|F[A-Z]{4}|VH[A-Z]{3}|ZK[A-Z]{3}|EI[A-Z]{3})$/;
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/;
const AIRLINE_OWNER = /air ?lines?|airways|airline|express|cargo|fedex|\bups\b|dhl|jazz|westjet|porter|flair|transat|lufthansa|klm|easyjet|ryanair/i;
// Military operator ("RCAF", "RAF", "USAF"…) from the registered owner, the callsign, or the address block and
// serial format. Same logic in adsb-monitor's server.js and the card; keep them in step.
const MIL_OWNERS = [
  [/royal canadian air force|canadian (armed )?forces|national defen[cs]e canada|\bdnd\b/i, "RCAF", "Royal Canadian Air Force"],
  [/royal australian air force/i, "RAAF", "Royal Australian Air Force"],
  [/royal new zealand air force/i, "RNZAF", "Royal New Zealand Air Force"],
  [/royal netherlands air force|koninklijke luchtmacht/i, "RNLAF", "Royal Netherlands Air Force"],
  [/royal danish air force/i, "RDAF", "Royal Danish Air Force"],
  [/royal norwegian air force/i, "RNoAF", "Royal Norwegian Air Force"],
  [/royal air force|\braf\b/i, "RAF", "Royal Air Force"],
  [/royal navy|fleet air arm/i, "RN", "Royal Navy"],
  [/marine corps|\busmc\b/i, "USMC", "US Marine Corps"],
  [/united states navy|\bus navy\b|\busn\b/i, "USN", "US Navy"],
  [/united states army|\bus army\b/i, "US Army", "US Army"],
  [/united states coast guard|\buscg\b/i, "USCG", "US Coast Guard"],
  [/united states air force|\busaf\b|air national guard/i, "USAF", "US Air Force"],
  [/luftwaffe|german air force|bundeswehr/i, "GAF", "German Air Force"],
  [/arm[ée]e de l.air|french air/i, "FAF", "French Air and Space Force"],
  [/aeronautica militare|italian air force/i, "ItAF", "Italian Air Force"],
  [/belgian (air|defen)/i, "BAF", "Belgian Air Component"],
  [/ej[ée]rcito del aire|spanish air/i, "SpAF", "Spanish Air and Space Force"],
  [/turkish air force/i, "TurAF", "Turkish Air Force"],
  [/\bnato\b/i, "NATO", "NATO"],
];
const MIL_PREFIXES = {
  CFC: "RCAF", HUSK: "RCAF", CANFORCE: "RCAF", RCH: "USAF", REACH: "USAF", SAM: "USAF", SPAR: "USAF", VENUS: "USAF",
  EVAC: "USAF", PAT: "US Army", ARMY: "US Army", CNV: "USN", NAVY: "USN", RRR: "RAF", ASY: "RAAF", KIWI: "RNZAF",
  GAF: "GAF", CTM: "FAF", BAF: "BAF", IAM: "ItAF", TUAF: "TurAF", NATO: "NATO",
};
const MIL_NAMES = Object.fromEntries(MIL_OWNERS.map(([, c, n]) => [c, n]));
function milOperator(hex, cs, owner, reg) {
  const o = MIL_OWNERS.find(([re]) => re.test(owner || ""));
  if (o) return { code: o[1], name: o[2] };
  const p = /^([A-Z]+)\d/.exec(cs || "");
  if (p && MIL_PREFIXES[p[1]]) return { code: MIL_PREFIXES[p[1]], name: MIL_NAMES[MIL_PREFIXES[p[1]]] };
  const n = parseInt(hex, 16), r = (reg || "").trim();
  const inR = (lo, hi) => n >= lo && n <= hi;
  if (inR(0xc20000, 0xc3ffff)) return { code: "RCAF", name: MIL_NAMES.RCAF };
  if (inR(0x43c000, 0x43cfff)) return { code: "RAF", name: MIL_NAMES.RAF };
  if (inR(0x3aa000, 0x3affff) || inR(0x3b7000, 0x3bffff)) return { code: "FAF", name: MIL_NAMES.FAF };
  if (inR(0x3ea000, 0x3ebfff) || inR(0x3f4000, 0x3fbfff)) return { code: "GAF", name: MIL_NAMES.GAF };
  if (inR(0xadf7c8, 0xafffff)) {
    if (/^\d{2}-\d{4,5}$/.test(r)) return { code: "USAF", name: MIL_NAMES.USAF }; // USAF serial, e.g. 92-3292
    if (/^\d{6}$/.test(r)) return { code: "USN", name: MIL_NAMES.USN }; // Navy/Marines BuNo, e.g. 170018
    return { code: "US Mil", name: "US military" };
  }
  return null;
}

// Small national-insignia icons for the military operator tag, drawn here (no image files).
const MAPLE = "M10 4.6L10.9 6.6L12 6.1L11.6 8.8L13.3 7.6L13.7 8.6L15.2 8.3L14.5 10.1L15.2 10.6L12.4 12.5L12.8 13.4L10.3 13L10.3 15.4L9.7 15.4L9.7 13L7.2 13.4L7.6 12.5L4.8 10.6L5.5 10.1L4.8 8.3L6.3 8.6L6.7 7.6L8.4 8.8L8 6.1L9.1 6.6Z";
function rings(cols, extra = "") {
  const r = cols.length === 4 ? [9.5, 7.2, 4.9, 2.6] : cols.length === 3 ? [9.5, 6.4, 3.2] : [9.5, 4.8];
  return `<svg viewBox="0 0 20 20" width="14" height="14">${cols.map((c, i) => `<circle cx="10" cy="10" r="${r[i]}" fill="${c}"${i ? "" : ` stroke="rgba(0,0,0,.35)" stroke-width=".6"`}/>`).join("")}${extra}</svg>`;
}
const US_STAR = `<svg viewBox="0 0 34 20" width="24" height="14"><rect x="1" y="6" width="32" height="8" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width=".6"/><rect x="1" y="8.6" width="32" height="2.8" fill="#b22234"/><circle cx="17" cy="10" r="9.3" fill="#3c3b6e" stroke="rgba(0,0,0,.35)" stroke-width=".6"/><path d="M17 1.6L19 7.6L25.2 7.6L20.2 11.3L22.1 17.3L17 13.6L11.9 17.3L13.8 11.3L8.8 7.6L15 7.6Z" fill="#fff"/></svg>`;
const ROUNDELS = {
  RCAF: rings(["#1d3f8f", "#fff"], `<path d="${MAPLE}" fill="#d52b1e"/>`),
  RAF: rings(["#00247d", "#fff", "#cf142b"]),
  RN: rings(["#00247d", "#fff", "#cf142b"]),
  RAAF: rings(["#00247d", "#fff", "#cf142b"]),
  RNZAF: rings(["#00247d", "#fff", "#cf142b"]),
  FAF: rings(["#ef4135", "#fff", "#0055a4"]),
  ItAF: rings(["#ce2b37", "#fff", "#009246"]),
  BAF: rings(["#e30613", "#fdda24", "#111"]),
  RNLAF: rings(["#ae1c28", "#fff", "#21468b", "#ff8200"]),
  RDAF: rings(["#c8102e", "#fff", "#c8102e"]),
  RNoAF: rings(["#ba0c2f", "#fff", "#00205b"]),
  SpAF: rings(["#c60b1e", "#ffc400", "#c60b1e"]),
  TurAF: rings(["#e30a17", "#fff", "#e30a17"]),
  GAF: `<svg viewBox="0 0 20 20" width="14" height="14"><path d="M7 1h6v6h6v6h-6v6H7v-6H1V7h6z" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width=".6"/><path d="M8.5 2.5h3v6h6v3h-6v6h-3v-6h-6v-3h6z" fill="#111"/></svg>`,
  NATO: `<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="10" cy="10" r="9.5" fill="#004990"/><path d="M10 2L11.6 8.4L18 10L11.6 11.6L10 18L8.4 11.6L2 10L8.4 8.4Z" fill="#fff"/></svg>`,
};
for (const k of ["USAF", "USN", "USMC", "US Army", "USCG", "US Mil"]) ROUNDELS[k] = US_STAR;

const MODES = { autopilot: "AP", vnav: "VNAV", lnav: "LNAV", tcas: "TCAS", althold: "ALT", approach: "APP" };

// Plane silhouettes, nose up, centred on 0,0.
const SHAPES = {
  jet: "M0,-12C1.2,-12 1.6,-10 1.6,-8L1.6,-3L11,2.5L11,4.5L1.6,2L1.4,8L4.5,10.5L4.5,12L0,11L-4.5,12L-4.5,10.5L-1.4,8L-1.6,2L-11,4.5L-11,2.5L-1.6,-3L-1.6,-8C-1.6,-10 -1.2,-12 0,-12Z",
  light: "M0,-9C1,-9 1.2,-8 1.2,-6L1.2,-3L10,-2.5L10,0L1.2,.5L.8,6L4,7L4,8.5L0,8L-4,8.5L-4,7L-.8,6L-1.2,.5L-10,0L-10,-2.5L-1.2,-3L-1.2,-6C-1.2,-8 -1,-9 0,-9Z",
  heli: "M0,-7A3.6,3.6 0 1 1 -.01,-7ZM-.8,1L.8,1L.6,10L-.6,10ZM-3,9L3,9L3,10.4L-3,10.4ZM-9,-3.4L9,-3.4L9,-2.4L-9,-2.4ZM-.5,-12L.5,-12L.5,5L-.5,5Z",
  ground: "M-4,-5L4,-5L4,5L-4,5Z",
};
function shapeOf(ac) {
  const c = ac.category || "";
  if (c === "A7") return ["heli", 1];
  if (c[0] === "C") return ["ground", 1];
  if (c === "A1" || c === "B1" || c === "B4") return ["light", 0.95];
  if (c === "A2") return ["light", 1.1];
  if (c === "A5") return ["jet", 1.3];
  if (c === "A4") return ["jet", 1.12];
  return ["jet", c ? 1 : 0.9];
}

// SkyAware's altitude colours: orange low, green ~10,000 ft, magenta 40,000 ft.
function altHue(alt) {
  if (alt <= 2000) return 20;
  if (alt <= 10000) return 20 + ((alt - 2000) / 8000) * 120;
  if (alt <= 40000) return 140 + ((alt - 10000) / 30000) * 160;
  return 300;
}
function altColor(alt, sel) {
  if (alt === "ground") return `hsl(15 ${sel ? 70 : 80}% ${sel ? 55 : 38}%)`;
  if (typeof alt !== "number") return `hsl(0 0% ${sel ? 75 : 55}%)`;
  return `hsl(${altHue(alt).toFixed(0)} ${sel ? 75 : 85}% ${sel ? 68 : 50}%)`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const callsign = (ac) => (ac.flight || "").trim();
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
function ago(s) {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
// Vertical rate in ft/min; one encoding step (64) either way counts as level.
function vrate(a) {
  const v = a.baro_rate ?? a.geom_rate ?? 0;
  return Math.abs(v) <= 64 ? 0 : v;
}

// ---- geo -------------------------------------------------------------------------------------
function dist(a1, o1, a2, o2) {
  const dA = (a2 - a1) * RAD, dO = (o2 - o1) * RAD;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * RAD) * Math.cos(a2 * RAD) * Math.sin(dO / 2) ** 2;
  return 2 * NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a1, o1, a2, o2) {
  const y = Math.sin((o2 - o1) * RAD) * Math.cos(a2 * RAD);
  const x = Math.cos(a1 * RAD) * Math.sin(a2 * RAD) - Math.sin(a1 * RAD) * Math.cos(a2 * RAD) * Math.cos((o2 - o1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
function destPoint(lat, lon, brg, d) {
  const δ = d / NM, θ = brg * RAD, φ1 = lat * RAD, λ1 = lon * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 / RAD, λ2 / RAD];
}
// Web Mercator, in units of the whole world (0..1).
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => {
  const s = Math.sin(Math.max(-85, Math.min(85, lat)) * RAD);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

// ---- shared state (survives the card being re-created when you switch dashboard tabs) ---------
const STORE = {
  trails: new Map(), // hex -> [{t, lat, lon, alt, gs}]
  routes: new Map(), // callsign -> {t, r: {codes, airports, plausible} | null}
  airlines: new Map(), // callsign -> adsbdb flightroute (airline name, IATA flight number) | null
  photos: new Map(), // hex -> {src, link, by} | null
  aircraft: null, // hex -> adsbdb aircraft | null (also in localStorage)
  historyLoaded: false,
  carriers: null, // airline ICAO code -> {name, iata} | null (also in localStorage)
};
function acCache() {
  if (!STORE.aircraft) {
    STORE.aircraft = new Map();
    try {
      const o = JSON.parse(localStorage.getItem("skyaware-card:aircraft") || "{}");
      for (const [k, v] of Object.entries(o)) STORE.aircraft.set(k, v);
    } catch (e) {}
  }
  return STORE.aircraft;
}
function carriers() {
  if (!STORE.carriers) {
    STORE.carriers = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem("skyaware-card:carriers") || "{}"))) STORE.carriers.set(k, v);
    } catch (e) {}
  }
  return STORE.carriers;
}
function saveCarriers() {
  try {
    localStorage.setItem("skyaware-card:carriers", JSON.stringify(Object.fromEntries(carriers())));
  } catch (e) {}
}
// Airline ICAO code of a commercial flight's callsign ("ACA612" -> "ACA"), or "".
const carrierOf = (a) => (AIRLINE_CALLSIGN.test(callsign(a)) ? callsign(a).slice(0, 3) : "");

function saveAcCache() {
  try {
    const entries = [...acCache().entries()].slice(-3000);
    localStorage.setItem("skyaware-card:aircraft", JSON.stringify(Object.fromEntries(entries)));
  } catch (e) {}
}

async function getJSON(url, opt = {}, ms = 8000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

class SkyAwareCard extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULTS, ...(config || {}) };
    if (!Array.isArray(this._config.urls)) this._config.urls = [this._config.urls];
    if (!Array.isArray(this._config.monitor)) this._config.monitor = this._config.monitor ? [this._config.monitor] : [];
    this._config.urls = this._config.urls.filter(Boolean);
    // No PiAware URL: use adsb-monitor's proxy of it.
    if (!this._config.urls.length) this._config.urls = [...this._config.monitor];
    if (!this._config.urls.length) throw new Error("skyaware-card: set `urls` (your PiAware) and/or `monitor` (adsb-monitor)");
    this._config.path = ("/" + this._config.path + "/").replace(/\/+/g, "/");
    const get = (k, d) => {
      try {
        return localStorage.getItem("skyaware-card:" + k) ?? d;
      } catch (e) {
        return d;
      }
    };
    this._tab = get("tab", "map");
    this._labels = get("labels", "1") === "1";
    this._sat = get("sat", "0") === "1"; // satellite basemap
    this._trailsAll = get("trails", "1") === "1";
    this._sort = get("sort", "dist");
    this._sortDir = Number(get("sortdir", "1"));
    this._covRange = get("covrange", "7");
    this._clsFilter = get("class", "all");
    // Map filter: classes and airlines to show (empty = no restriction).
    this._fCls = new Set(get("mapcls", "").split(",").filter(Boolean));
    this._fAir = new Set(get("mapair", "").split(",").filter(Boolean));
    this._covOn = get("covmap", "0") === "1";
    this._acs = [];
    this._view = null; // map centre {x, y} (mercator units) and zoom z
    this._sel = null;
    this._follow = false;
  }

  static getStubConfig() {
    return {};
  }

  getCardSize() {
    return 12;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6, rows: "auto" };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    const dark = !!hass.themes?.darkMode;
    if (dark !== this._dark) {
      this._dark = dark;
      this._tiles?.clear();
      if (this.$("tiles")) this.$("tiles").innerHTML = "";
      this._renderMap();
    }
  }

  connectedCallback() {
    if (!this._built && this._config) this._build();
    this._start();
    if (!this._ro) this._ro = new ResizeObserver(() => this._renderMap());
    if (this._built) this._ro.observe(this.$("map"));
  }

  disconnectedCallback() {
    for (const t of this._timers || []) clearInterval(t);
    this._timers = [];
    if (this._ro) this._ro.disconnect();
  }

  $(id) {
    return this.shadowRoot.getElementById(id);
  }

  _save(k, v) {
    try {
      localStorage.setItem("skyaware-card:" + k, String(v));
    } catch (e) {}
  }

  // ---- data ----------------------------------------------------------------------------------

  async _get(path) {
    const urls = this._base ? [this._base, ...this._config.urls.filter((u) => u !== this._base)] : this._config.urls;
    let err;
    for (const u of urls) {
      try {
        const d = await getJSON(u.replace(/\/$/, "") + path, {}, 5000);
        if (d === null) throw new Error("HTTP 404");
        this._base = u;
        return d;
      } catch (e) {
        err = e;
      }
    }
    this._base = null;
    throw err;
  }

  _start() {
    if (this._timers?.length) return;
    const every = (fn, ms) => {
      fn();
      return setInterval(() => document.visibilityState === "visible" && fn(), ms);
    };
    this._timers = [
      every(() => this._poll(), Math.max(1, this._config.refresh) * 1000),
    ];
    if (this._config.monitor.length) {
      this._timers.push(every(() => this._loadMonitor(), 30000), every(() => this._loadCoverage(), 300000), every(() => this._loadClasses(), 15000));
    }
    if (this._config.lookups) {
      this._timers.push(every(() => this._lookupRoutes(), 15000), every(() => this._lookupAircraft(), 1500));
    }
    this._loadReceiver();
  }

  // ---- adsb-monitor --------------------------------------------------------------------------

  async _mon(path, opt) {
    const all = this._config.monitor;
    const urls = this._monBase ? [this._monBase, ...all.filter((u) => u !== this._monBase)] : all;
    let err;
    for (const u of urls) {
      try {
        const d = await getJSON(u.replace(/\/$/, "") + path, opt, 6000);
        if (d === null) throw new Error("HTTP 404");
        this._monBase = u;
        return d;
      } catch (e) {
        err = e;
      }
    }
    this._monBase = null;
    throw err || new Error("no monitor configured");
  }

  async _loadMonitor() {
    try {
      const [st, set] = await Promise.all([this._mon("/api/status"), this._mon("/api/settings")]);
      this._monStatus = st;
      this._monErr = null;
      this._settings = set;
      if (this._tab === "alerts") this._alertsList = await this._mon("/api/alerts");
    } catch (e) {
      this._monErr = e.message || String(e);
    }
    this._renderHead();
    if (this._tab === "alerts") this._renderAlerts();
    if (this._tab === "flight") this._renderFlight();
  }

  async _loadClasses() {
    try {
      this._classes = await this._mon("/api/classes");
    } catch (e) {}
  }

  async _loadCoverage() {
    if (this._tab !== "coverage" && !this._covOn && this._cov) return;
    try {
      this._cov = await this._mon("/api/coverage");
      this._covErr = null;
    } catch (e) {
      this._covErr = e.message || String(e);
    }
    if (this._tab === "coverage") this._renderCoverage();
    if (this._tab === "map") this._renderMap();
  }

  async _saveSettings(patch) {
    try {
      this._settings = await this._mon("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      this._monErr = null;
    } catch (e) {
      this._monErr = e.message || String(e);
    }
    this._renderAlerts(true);
    this._renderFlight();
    if (this._tab === "map") this._renderPop();
  }

  async _watch(cs, remove) {
    try {
      this._settings = await this._mon("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callsign: cs, remove }) });
    } catch (e) {
      this._monErr = e.message || String(e);
    }
    this._renderAlerts(true);
    this._renderFlight();
    if (this._tab === "map") this._renderPop();
  }

  // "Alert me when it lands" toggle; shown whenever a monitor is configured (settings load in the background).
  _watchBtn(cs, short) {
    if (!cs || !this._config.monitor.length) return "";
    if (!this._settings?.airport) return "";
    const ap = this._settings.airport.iata || this._settings.airport.icao;
    return this._watching(cs)
      ? `<button class="btn on" data-act="unwatch" data-cs="${esc(cs)}" title="Tap to stop"><ha-icon icon="mdi:bell-ring"></ha-icon>${short ? "Watching" : `Alerting when it lands at ${esc(ap)}`}</button>`
      : `<button class="btn" data-act="watch" data-cs="${esc(cs)}" title="Phone alert when it lands at ${esc(ap)}"><ha-icon icon="mdi:bell-plus-outline"></ha-icon>${short ? `Alert at ${esc(ap)}` : `Alert me when it lands at ${esc(ap)}`}</button>`;
  }

  _watching(cs) {
    return !!cs && !!this._settings?.watch?.some((w) => w.callsign === cs || w.label === cs);
  }

  async _loadReceiver() {
    try {
      const r = await this._get(this._config.path + "data/receiver.json");
      this._rx = { lat: this._config.lat ?? r.lat, lon: this._config.lon ?? r.lon, history: r.history || 0 };
      this._loadHistory();
      this._renderAll();
    } catch (e) {
      setTimeout(() => this._loadReceiver(), 10000);
    }
  }

  // Pre-fill trails from SkyAware's history snapshots (a ring buffer of ~30 s snapshots), once per page load.
  async _loadHistory() {
    if (STORE.historyLoaded || !this._rx?.history) return;
    STORE.historyLoaded = true;
    const n = this._rx.history, snaps = [];
    for (let i = 0; i < n; i += 20) {
      const batch = [];
      for (let j = i; j < Math.min(n, i + 20); j++) batch.push(this._get(`${this._config.path}data/history_${j}.json`).catch(() => null));
      snaps.push(...(await Promise.all(batch)).filter(Boolean));
    }
    const cutoff = Date.now() / 1000 - this._config.trail_minutes * 60;
    snaps.sort((a, b) => a.now - b.now);
    const pre = new Map();
    for (const s of snaps) {
      if (s.now < cutoff) continue;
      for (const ac of s.aircraft || []) {
        if (ac.lat === undefined || (ac.seen_pos ?? 99) > 10) continue;
        if (!pre.has(ac.hex)) pre.set(ac.hex, []);
        pre.get(ac.hex).push({ t: s.now - ac.seen_pos, lat: ac.lat, lon: ac.lon, alt: ac.alt_baro, gs: ac.gs });
      }
    }
    for (const [hex, pts] of pre) {
      const live = STORE.trails.get(hex) || [];
      const first = live[0]?.t ?? Infinity;
      STORE.trails.set(hex, [...pts.filter((p) => p.t < first), ...live]);
    }
    this._renderAll();
  }

  async _poll() {
    let d;
    try {
      d = await this._get(this._config.path + "data/aircraft.json");
      this._err = null;
    } catch (e) {
      this._err = e.message || String(e);
      this._renderHead();
      return;
    }
    if (this._last && d.now > this._last.now) this._rate = (d.messages - this._last.messages) / (d.now - this._last.now);
    this._last = { now: d.now, messages: d.messages };
    this._now = d.now;
    const rx = this._rx;
    for (const ac of d.aircraft) {
      if (ac.lat !== undefined && rx) {
        ac._dist = dist(rx.lat, rx.lon, ac.lat, ac.lon);
        ac._brg = bearing(rx.lat, rx.lon, ac.lat, ac.lon);
      }
      // Trails: a point when it has moved, at most every 4 s.
      if (ac.lat !== undefined && ac.seen_pos < 10) {
        const t = d.now - ac.seen_pos;
        let tr = STORE.trails.get(ac.hex);
        if (!tr) STORE.trails.set(ac.hex, (tr = []));
        const p = tr[tr.length - 1];
        if (!p || (t - p.t >= 4 && (p.lat !== ac.lat || p.lon !== ac.lon))) tr.push({ t, lat: ac.lat, lon: ac.lon, alt: ac.alt_baro, gs: ac.gs });
      }
    }
    const cutoff = d.now - this._config.trail_minutes * 60;
    for (const [hex, tr] of STORE.trails) {
      while (tr.length && tr[0].t < cutoff) tr.shift();
      if (!tr.length) STORE.trails.delete(hex);
    }
    // Emergency squawks seen, for _emerg(): when each code was first seen and the message count then.
    if (!this._sq) this._sq = new Map();
    for (const ac of d.aircraft) {
      const code = SQUAWKS[ac.squawk] ? ac.squawk : ac.emergency && ac.emergency !== "none" ? ac.emergency : null;
      const q = this._sq.get(ac.hex);
      if (!code) this._sq.delete(ac.hex);
      else if (!q || q.code !== code) this._sq.set(ac.hex, { code, t: Date.now(), msgs: ac.messages || 0 });
    }
    this._acs = d.aircraft;
    if (!this._kicked && this._config.lookups) {
      this._kicked = true;
      setTimeout(() => this._lookupRoutes(), 0);
    }
    this._byHex = new Map(d.aircraft.map((a) => [a.hex, a]));
    if (this._sel && this._byHex.has(this._sel)) {
      this._selLast = this._byHex.get(this._sel);
      this._selSeenAt = d.now - (this._selLast.seen || 0);
    }
    if (this._follow && this._selLast?.lat !== undefined && this._byHex.has(this._sel)) this._centerOn(this._selLast, false);
    this._renderAll();
  }

  // Routes for every visible callsign, in one request (adsb.im checks each against the plane's position).
  async _lookupRoutes() {
    const now = Date.now();
    const want = this._acs.filter((a) => {
      const cs = callsign(a);
      if (!cs || a.lat === undefined) return false;
      const c = STORE.routes.get(cs);
      return !c || now - c.t > (c.r ? 30 : 10) * 60000;
    });
    if (!want.length) return;
    try {
      const res = await getJSON("https://adsb.im/api/0/routeset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planes: want.slice(0, 60).map((a) => ({ callsign: callsign(a), lat: a.lat, lng: a.lon })) }),
      });
      for (const r of res || []) {
        const ok = r.airport_codes && r.airport_codes !== "unknown" && r._airports?.length >= 2;
        STORE.routes.set(r.callsign, { t: now, r: ok ? { codes: r._airport_codes_iata, airports: r._airports, plausible: r.plausible !== false } : null });
      }
      this._renderAll();
    } catch (e) {}
  }

  // Aircraft details (type, registration, owner), one at a time, selected aircraft first.
  async _lookupAircraft() {
    if (this._busy) return;
    const cache = acCache();
    const order = [...this._acs].sort((a, b) => (b.hex === this._sel) - (a.hex === this._sel) || (a._dist ?? 9e9) - (b._dist ?? 9e9));
    const ac = order.find((a) => !cache.has(a.hex) && !a.hex.startsWith("~"));
    const sel = this._sel && this._byHex?.get(this._sel);
    const cs = sel && callsign(sel);
    let code = null;
    this._busy = true;
    try {
      if (cs && !STORE.airlines.has(cs)) {
        const d = await getJSON(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`);
        STORE.airlines.set(cs, d?.response?.flightroute || null);
        this._renderFlight();
      } else if (sel && !STORE.photos.has(sel.hex)) {
        await this._lookupPhoto(sel.hex);
      } else if ((code = this._acs.map(carrierOf).find((c) => c && !carriers().has(c)))) {
        const d = await getJSON(`https://api.adsbdb.com/v0/airline/${code}`);
        const x = Array.isArray(d?.response) ? d.response[0] : null;
        carriers().set(code, x ? { name: x.name, iata: x.iata || "" } : null);
        saveCarriers();
        if (this._fOpen) this._renderFilter();
      } else if (ac) {
        const d = await getJSON(`https://api.adsbdb.com/v0/aircraft/${ac.hex}`);
        const a = d?.response?.aircraft;
        cache.set(ac.hex, a ? { type: a.type, icao: a.icao_type, mfr: a.manufacturer, reg: a.registration, owner: a.registered_owner,
          country: a.registered_owner_country_name, photo: a.url_photo_thumbnail, photoLink: a.url_photo } : null);
        saveAcCache();
        this._renderAll();
      }
    } catch (e) {
      if (cs && !STORE.airlines.has(cs)) STORE.airlines.set(cs, null);
      else if (code) carriers().set(code, null);
      else if (ac && !cache.has(ac.hex)) cache.set(ac.hex, null);
    }
    this._busy = false;
  }

  async _lookupPhoto(hex) {
    const info = acCache().get(hex);
    let p = null;
    if (info?.photo) p = { src: info.photo, link: info.photoLink || info.photo, by: "airport-data.com" };
    else {
      try {
        const d = await getJSON(`https://api.planespotters.net/pub/photos/hex/${hex}`);
        const ph = d?.photos?.[0];
        if (ph) p = { src: ph.thumbnail_large?.src || ph.thumbnail?.src, link: ph.link, by: `${ph.photographer} / Planespotters.net` };
      } catch (e) {}
    }
    STORE.photos.set(hex, p);
    this._renderFlight();
  }

  // The leg of the route the plane is on (routes can have stops): the one it's closest to being on.
  _route(ac) {
    const c = STORE.routes.get(callsign(ac));
    if (!c?.r) return null;
    const ap = c.r.airports;
    let best = null;
    for (let i = 0; i < ap.length - 1; i++) {
      const o = ap[i], d = ap[i + 1];
      const direct = dist(o.lat, o.lon, d.lat, d.lon);
      const flown = ac.lat !== undefined ? dist(o.lat, o.lon, ac.lat, ac.lon) : null;
      const togo = ac.lat !== undefined ? dist(ac.lat, ac.lon, d.lat, d.lon) : null;
      const detour = flown === null ? 0 : flown + togo - direct;
      if (!best || detour < best.detour) best = { o, d, direct, flown, togo, detour, legs: ap.length - 1, all: ap, plausible: c.r.plausible };
    }
    return best;
  }

  // Commercial / helicopter / military / private / unclassified / unknown.
  _class(a) {
    const m = this._classes?.[a.hex], cs = callsign(a), info = this._info(a.hex);
    const hex = parseInt(a.hex, 16);
    if (m?.mil || MIL_RANGES.some(([lo, hi]) => hex >= lo && hex <= hi) || MIL_CALLSIGN.test(cs)) return CLASS.mil;
    if (m?.heli || a.category === "A7") return CLASS.heli;
    const reg = (info?.reg || m?.reg || "").replace(/-/g, "").toUpperCase();
    if (cs && (cs === reg || REG_CALLSIGN.test(cs))) return CLASS.priv;
    if (AIRLINE_CALLSIGN.test(cs)) return CLASS.com;
    // No callsign (often just not received yet): go by owner, then by size.
    if (AIRLINE_OWNER.test(info?.owner || m?.owner || "")) return CLASS.com;
    if (!cs && ["A3", "A4", "A5"].includes(a.category)) return CLASS.com;
    if (["A1", "A2", "B1", "B4"].includes(a.category)) return CLASS.priv;
    if (cs || info?.type || info?.reg || a.category) return CLASS.other;
    return CLASS.unk;
  }

  // Class tag; for military aircraft the operator's roundel and code (RCAF, RAF, USAF…) when it can be told.
  _tag(c, short, a) {
    const op = c.k === "mil" && a ? this._milOp(a) : null;
    if (op) return `<span class="ctag" style="--c:${c.c}" title="Military · ${esc(op.name)}">${ROUNDELS[op.code] || `<ha-icon icon="${c.i}"></ha-icon>`}${esc(op.code)}</span>`;
    return `<span class="ctag" style="--c:${c.c}" title="${c.l}"><ha-icon icon="${c.i}"></ha-icon>${short ? "" : c.l}</span>`;
  }

  _milOp(a) {
    const m = this._classes?.[a.hex], info = this._info(a.hex);
    return milOperator(a.hex, callsign(a), m?.owner || info?.owner, info?.reg || m?.reg);
  }

  // Emergency squawk: {code, name, ok}. ok (confirmed) = the matching ADS-B emergency status, or the code held for
  // 60 s while 20+ more messages arrived. A single corrupted Mode S reply often decodes as 7500 and dump1090 keeps it.
  _emerg(a) {
    const q = this._sq?.get(a.hex);
    if (!q) return null;
    const adsb = a.emergency && a.emergency !== "none" && (!SQUAWKS[q.code] || a.emergency === SQUAWK_EMERGENCY[q.code]);
    const held = Date.now() - q.t >= 60000 && (a.messages || 0) - q.msgs >= 20 && a.seen < 10;
    return { code: q.code, name: SQUAWKS[q.code] || q.code, ok: !!(adsb || held) };
  }

  _info(hex) {
    return acCache().get(hex) || null;
  }

  // ---- UI ------------------------------------------------------------------------------------

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { --sa-good: var(--success-color, #3fb68b); --sa-warn: var(--warning-color, #e5a93a); --sa-bad: var(--error-color, #e5534b);
                --sa-h: ${c.map_height ? Number(c.map_height) + "px" : "max(440px, calc(100vh - 230px))"}; }
        ha-card { padding: 16px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .title { display: flex; align-items: center; gap: 8px; font-size: 1.25em; font-weight: 500; }
        .title ha-icon { color: var(--primary-color); }
        .pill { font-size: .8em; padding: 3px 10px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
        .pill.ok { background: color-mix(in srgb, var(--sa-good) 18%, transparent); color: var(--sa-good); }
        .pill.warn { background: color-mix(in srgb, var(--sa-warn) 18%, transparent); color: var(--sa-warn); }
        .pill.bad { background: color-mix(in srgb, var(--sa-bad) 18%, transparent); color: var(--sa-bad); }
        .pill.dim { background: var(--secondary-background-color); color: var(--secondary-text-color); font-weight: 500; }
        .dots { display: inline-flex; gap: 8px; }
        .dot { display: inline-flex; align-items: center; gap: 4px; }
        .dot i { width: 8px; height: 8px; border-radius: 50%; background: var(--disabled-text-color, #888); display: inline-block; }
        .dot i.green { background: var(--sa-good); } .dot i.amber, .dot i.yellow { background: var(--sa-warn); } .dot i.red { background: var(--sa-bad); }
        .meta { margin-left: auto; font-size: .78em; color: var(--secondary-text-color); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--secondary-background-color); margin: 12px 0; width: fit-content; max-width: 100%; overflow-x: auto; }
        .tabs button { border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-size: .88em; padding: 6px 14px;
                       border-radius: 999px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
        .tabs button ha-icon { --mdc-icon-size: 18px; }
        .tabs button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .tabs .n { font-size: .8em; opacity: .8; }
        .pane { display: none; } .pane.on { display: block; }
        .good { color: var(--sa-good); } .warn { color: var(--sa-warn); } .bad { color: var(--sa-bad); }
        .muted { color: var(--secondary-text-color); }
        a { color: var(--primary-color); }

        /* map */
        .map { position: relative; height: var(--sa-h); border-radius: 12px; overflow: hidden; background: var(--secondary-background-color);
               touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
        .map.drag { cursor: grabbing; }
        #tiles { position: absolute; inset: 0; z-index: 0; } /* own stacking context: labels layer stays under the overlays */
        #tiles img { position: absolute; left: 0; top: 0; pointer-events: none; }
        #ov { position: absolute; inset: 0; width: 100%; height: 100%; }
        .ring { fill: none; stroke: var(--sa-ring); stroke-width: 1.2; }
        .ringl { fill: var(--sa-ring-t); font-size: 11px; font-weight: 600; paint-order: stroke; stroke: var(--sa-halo); stroke-width: 3px; }
        .lbl { font-size: 11px; font-weight: 600; fill: var(--sa-text); paint-order: stroke; stroke: var(--sa-halo); stroke-width: 3px; stroke-linejoin: round; }
        .lbl2 { font-size: 10px; font-weight: 500; fill: var(--sa-text2); paint-order: stroke; stroke: var(--sa-halo); stroke-width: 3px; }
        .ac path { stroke-width: .9; }
        .ac.stale { opacity: .45; }
        .selring { fill: none; stroke: var(--primary-color); stroke-width: 2; }
        .route { fill: none; stroke: var(--primary-color); stroke-width: 1.6; stroke-dasharray: 5 5; opacity: .8; }
        .apt { fill: var(--primary-color); stroke: var(--sa-halo); stroke-width: 2; }
        .ctrls { position: absolute; top: 10px; right: 10px; display: flex; flex-direction: column; gap: 6px; }
        .ctrls button, .chip { width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--divider-color); cursor: pointer;
               background: var(--card-background-color, #fff); color: var(--primary-text-color); display: flex; align-items: center; justify-content: center; padding: 0; }
        .ctrls button ha-icon { --mdc-icon-size: 20px; }
        .ctrls button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .legend { position: absolute; left: 10px; bottom: 10px; background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent);
                  border-radius: 8px; padding: 6px 8px; font-size: 10px; color: var(--secondary-text-color); }
        .legend .bar { width: 170px; height: 7px; border-radius: 4px; margin: 3px 0 2px; }
        .legend .ticks { display: flex; justify-content: space-between; }
        .attr { position: absolute; right: 6px; bottom: 4px; font-size: 9px; color: var(--secondary-text-color);
                background: color-mix(in srgb, var(--card-background-color, #fff) 70%, transparent); padding: 1px 4px; border-radius: 4px; }
        .attr a { color: inherit; }
        .fpanel { position: absolute; top: 10px; right: 56px; width: min(330px, calc(100% - 76px)); max-height: calc(100% - 20px); overflow: auto;
                  background: var(--card-background-color, #fff); border-radius: 12px; box-shadow: var(--ha-card-box-shadow, 0 2px 10px rgba(0,0,0,.25));
                  padding: 10px 12px; display: none; cursor: default; z-index: 2; }
        .fpanel.on { display: block; }
        .fpanel h5 { margin: 10px 0 6px; font-size: .72em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); }
        .fpanel .fh { display: flex; align-items: center; gap: 8px; font-weight: 600; }
        .fpanel .fh a { margin-left: auto; font-weight: 400; font-size: .85em; cursor: pointer; }
        .fchips { display: flex; flex-wrap: wrap; gap: 6px; }
        .fchips button { border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); font: inherit; font-size: .8em;
                         padding: 3px 9px 3px 6px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; max-width: 100%; }
        .fchips button ha-icon { --mdc-icon-size: 15px; color: var(--c); }
        .fchips button img { width: 18px; height: 18px; object-fit: contain; border-radius: 3px; background: #fff; }
        .fchips button .n { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .fchips button .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fchips button.on { border-color: var(--c, var(--primary-color)); background: color-mix(in srgb, var(--c, var(--primary-color)) 20%, transparent); }
        .fchips button.dim { opacity: .45; }
        .fnote { font-size: .75em; color: var(--secondary-text-color); margin-top: 8px; }
        .fpill { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); background: var(--primary-color); color: var(--text-primary-color, #fff);
                 font-size: .8em; padding: 4px 6px 4px 12px; border-radius: 999px; display: none; align-items: center; gap: 6px; z-index: 1; white-space: nowrap; }
        .fpill.on { display: inline-flex; }
        .fpill ha-icon { --mdc-icon-size: 16px; cursor: pointer; }
        .ctrls button { position: relative; }
        .ctrls .badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--sa-warn); color: #000;
                        font-size: 10px; font-weight: 700; display: none; align-items: center; justify-content: center; padding: 0 3px; }
        .ctrls .badge.on { display: flex; }
        .pop { position: absolute; left: 10px; top: 10px; width: min(300px, calc(100% - 70px)); background: var(--card-background-color, #fff);
               border-radius: 12px; box-shadow: var(--ha-card-box-shadow, 0 2px 10px rgba(0,0,0,.25)); padding: 10px 12px; display: none; cursor: default; }
        .pop.on { display: block; }
        .pop .cs { font-size: 1.15em; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .pop .x { margin-left: auto; cursor: pointer; color: var(--secondary-text-color); --mdc-icon-size: 18px; }
        .pop .rt { font-size: .85em; margin: 2px 0 6px; }
        .pop .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; font-size: .78em; }
        .pop .kv b { display: block; font-size: 1.15em; font-variant-numeric: tabular-nums; }
        .pop .kv span { color: var(--secondary-text-color); }
        .pop .acts { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        .btn { border: 1px solid var(--divider-color); background: var(--card-background-color, #fff); color: var(--primary-text-color); font: inherit; font-size: .82em;
               padding: 5px 10px; border-radius: 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
        .btn.pri { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .btn.on { border-color: var(--primary-color); color: var(--primary-color); }
        .btn ha-icon { --mdc-icon-size: 16px; }

        /* tiles / panels */
        .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
        .tile { background: var(--secondary-background-color); border-radius: 12px; padding: 9px 11px; min-width: 0; }
        .tile .l { font-size: .78em; color: var(--secondary-text-color); }
        .tile .v { font-size: 1.4em; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tile .v small { font-size: .55em; font-weight: 500; color: var(--secondary-text-color); margin-left: 2px; }
        .tile .s { font-size: .72em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .panel { background: var(--secondary-background-color); border-radius: 12px; padding: 10px 12px; min-width: 0; }
        .panel h4 { margin: 0 0 6px; font-size: .75em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); }
        .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; margin-top: 10px; }

        /* list */
        .scroll { overflow: auto; max-height: var(--sa-h); margin-top: 10px; border-radius: 12px; background: var(--secondary-background-color); }
        table { width: 100%; border-collapse: collapse; font-size: .85em; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--divider-color); white-space: nowrap; }
        th { color: var(--secondary-text-color); font-weight: 500; position: sticky; top: 0; background: var(--secondary-background-color); cursor: pointer; z-index: 1; }
        th.pin, td.pin { width: 30px; padding: 2px 0 2px 6px; }
        td.pin button { border: none; background: transparent; color: var(--primary-color); cursor: pointer; padding: 3px; border-radius: 8px; display: flex; }
        td.pin button:hover { background: color-mix(in srgb, var(--primary-color) 18%, transparent); }
        td.pin ha-icon { --mdc-icon-size: 20px; }
        th.r, td.r { text-align: right; font-variant-numeric: tabular-nums; }
        th.on { color: var(--primary-color); }
        tbody tr { cursor: pointer; }
        tbody tr:hover { background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
        tbody tr.sel { background: color-mix(in srgb, var(--primary-color) 16%, transparent); }
        tbody tr.stale td { opacity: .55; }
        tbody tr.emerg { background: color-mix(in srgb, var(--sa-bad) 22%, transparent); }
        .sw { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }
        .ctag { display: inline-flex; align-items: center; gap: 4px; font-size: .74em; font-weight: 600; padding: 2px 8px 2px 6px; border-radius: 999px;
                color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); white-space: nowrap; vertical-align: middle; }
        .ctag ha-icon { --mdc-icon-size: 14px; }
        .ctag svg { flex: none; display: block; }
        .ctag:empty, .ctag.icon { padding: 2px 5px; }
        .cfilter { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
        .cfilter button { border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); font: inherit; font-size: .8em;
                          padding: 4px 10px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
        .cfilter button ha-icon { --mdc-icon-size: 15px; color: var(--c); }
        .cfilter button.on { border-color: var(--c, var(--primary-color)); background: color-mix(in srgb, var(--c, var(--primary-color)) 18%, transparent); }
        .cfilter button .n { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .tag { font-size: .72em; padding: 1px 5px; border-radius: 5px; background: var(--card-background-color, #fff); color: var(--secondary-text-color); margin-left: 4px; }
        .listbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; font-size: .82em; color: var(--secondary-text-color); }

        /* flight */
        .fhead { display: flex; gap: 14px; align-items: stretch; flex-wrap: wrap; }
        .photo { width: 240px; max-width: 100%; aspect-ratio: 16 / 10; border-radius: 12px; object-fit: cover; background: var(--secondary-background-color); display: block; }
        .photo-wrap { position: relative; }
        .photo-wrap .cr { position: absolute; left: 6px; bottom: 5px; font-size: 9px; color: #fff; text-shadow: 0 0 3px #000; }
        .photo-wrap .cr a { color: #fff; }
        .fid { flex: 1; min-width: 220px; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
        .fid .cs { font-size: 1.9em; font-weight: 600; line-height: 1.1; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .fid .al { font-size: 1.02em; }
        .fid .al img { height: 22px; vertical-align: middle; margin-right: 6px; border-radius: 3px; background: #fff; }
        .fid .ty { font-size: .88em; color: var(--secondary-text-color); }
        .route-box { margin-top: 14px; background: var(--secondary-background-color); border-radius: 14px; padding: 14px 16px; }
        .rt-row { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: start; }
        .rt-row .ap.dst { text-align: right; }
        .ap .code { font-size: 2em; font-weight: 700; letter-spacing: .02em; line-height: 1; }
        .ap .city { font-size: .95em; margin-top: 3px; }
        .ap .nm { font-size: .75em; color: var(--secondary-text-color); }
        .rt-mid { text-align: center; font-size: .8em; color: var(--secondary-text-color); padding-top: 6px; }
        .prog { position: relative; height: 26px; margin: 12px 4px 4px; }
        .prog .track { position: absolute; left: 0; right: 0; top: 12px; height: 3px; border-radius: 2px; background: var(--divider-color); }
        .prog .done { position: absolute; left: 0; top: 12px; height: 3px; border-radius: 2px; background: var(--primary-color); }
        .prog .end { position: absolute; top: 8px; width: 11px; height: 11px; border-radius: 50%; background: var(--primary-color); }
        .prog .end.r { right: -5px; background: var(--card-background-color, #fff); border: 2px solid var(--primary-color); top: 7px; }
        .prog .end.l { left: -5px; }
        .prog .pl { position: absolute; top: 1px; width: 24px; height: 24px; transform: translateX(-50%) rotate(90deg); color: var(--primary-color); --mdc-icon-size: 24px; }
        .prog-lab { display: flex; justify-content: space-between; font-size: .8em; color: var(--secondary-text-color); }
        .eta { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px; align-items: baseline; }
        .eta .big { font-size: 1.5em; font-weight: 600; font-variant-numeric: tabular-nums; }
        .eta .lab { font-size: .75em; color: var(--secondary-text-color); display: block; }
        .warnbox { margin-top: 10px; font-size: .82em; padding: 6px 10px; border-radius: 10px; background: color-mix(in srgb, var(--sa-warn) 16%, transparent); }
        .ch svg { display: block; width: 100%; }
        .ch .grid { stroke: var(--divider-color); stroke-width: 1; }
        .ch .ax { fill: var(--secondary-text-color); font-size: 10px; }
        .links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .links a { text-decoration: none; }
        .covwrap { display: grid; grid-template-columns: minmax(0, 560px) minmax(240px, 1fr); gap: 12px; align-items: start; }
        @media (max-width: 800px) { .covwrap { grid-template-columns: 1fr; } }
        .polar svg { display: block; width: 100%; height: auto; }
        .polar .pr { fill: none; stroke: var(--divider-color); stroke-width: 1; }
        .polar .pl { fill: var(--secondary-text-color); font-size: 11px; }
        .polar .wedge { fill: transparent; } .polar .wedge:hover { fill: color-mix(in srgb, var(--primary-color) 14%, transparent); }
        .chips { display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--secondary-background-color); width: fit-content; }
        .chips button { border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-size: .8em; padding: 4px 11px; border-radius: 999px; cursor: pointer; }
        .chips button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .bandrow { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--divider-color); font-size: .88em; }
        .bandrow:last-child { border-bottom: none; }
        .bandrow .v { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
        .swq { width: 14px; height: 14px; border-radius: 4px; flex: none; }
        .bars svg { display: block; width: 100%; }
        .bars .b { fill: var(--primary-color); opacity: .8; } .bars .b:hover { opacity: 1; }
        .arow { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--divider-color); flex-wrap: wrap; font-size: .9em; }
        .arow:last-child { border-bottom: none; }
        .arow .grow { flex: 1; min-width: 180px; }
        .arow .sub { font-size: .8em; color: var(--secondary-text-color); }
        .arow input[type=number] { width: 64px; } .arow input[type=time] { width: 110px; }
        .arow input[type=number], .arow input[type=time], .arow input[type=text] { font: inherit; padding: 5px 8px; border-radius: 8px;
          border: 1px solid var(--divider-color); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
        input.tg { appearance: none; -webkit-appearance: none; width: 38px; height: 22px; border-radius: 999px; background: var(--divider-color);
          position: relative; cursor: pointer; flex: none; margin: 0; transition: background .15s; }
        input.tg::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
        input.tg:checked { background: var(--primary-color); } input.tg:checked::after { left: 19px; }
        .wl { display: flex; flex-wrap: wrap; gap: 6px; }
        .wchip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; border-radius: 999px; background: var(--card-background-color, #fff); font-size: .88em; }
        .wchip ha-icon { --mdc-icon-size: 16px; cursor: pointer; color: var(--secondary-text-color); }
        .alog { max-height: 420px; overflow: auto; }
        .alog .t { font-size: .78em; color: var(--secondary-text-color); white-space: nowrap; min-width: 92px; }
        .alog .msg { white-space: pre-line; font-size: .85em; color: var(--secondary-text-color); }
        .empty { padding: 30px 10px; text-align: center; color: var(--secondary-text-color); }
        .picks { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 14px; }
        dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; font-size: .86em; }
        dt { color: var(--secondary-text-color); } dd { margin: 0; font-variant-numeric: tabular-nums; }
        iframe { width: 100%; height: var(--sa-h); border: 0; border-radius: 12px; background: var(--secondary-background-color); display: block; }
        @media (max-width: 600px) { .photo { width: 100%; } .ap .code { font-size: 1.6em; } }
      </style>
      <ha-card>
        <div class="head">
          <div class="title"><ha-icon icon="mdi:airplane"></ha-icon><span>${esc(c.title)}</span></div>
          <span class="pill bad" id="state">Connecting…</span>
          <span class="pill bad" id="emerg" hidden></span>
          <span class="meta" id="meta"></span>
        </div>
        <div class="tabs" id="tabs">${TABS.map(([k, l, i]) => `<button data-t="${k}"><ha-icon icon="${i}"></ha-icon><span>${l}</span><span class="n" id="n-${k}"></span></button>`).join("")}</div>

        <div class="pane" id="p-map">
          <div class="map" id="map">
            <div id="tiles"></div>
            <svg id="ov"></svg>
            <div class="ctrls">
              <button id="zin" title="Zoom in"><ha-icon icon="mdi:plus"></ha-icon></button>
              <button id="zout" title="Zoom out"><ha-icon icon="mdi:minus"></ha-icon></button>
              <button id="home" title="Back to the receiver"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
              <button id="lbl" title="Labels"><ha-icon icon="mdi:label-outline"></ha-icon></button>
              <button id="sat" title="Satellite"><ha-icon icon="mdi:satellite-variant"></ha-icon></button>
              <button id="trl" title="Trails for all aircraft"><ha-icon icon="mdi:chart-timeline-variant"></ha-icon></button>
              <button id="cvm" title="Receiver coverage (last 30 days)"><ha-icon icon="mdi:radar"></ha-icon></button>
              <button id="flt" title="Filter: classes and airlines"><ha-icon icon="mdi:filter-variant"></ha-icon><span class="badge" id="fbadge"></span></button>
            </div>
            <div class="pop" id="pop"></div>
            <div class="fpanel" id="fpanel"></div>
            <div class="fpill" id="fpill"></div>
            <div class="legend">Altitude (ft)
              <div class="bar" style="background: linear-gradient(90deg, ${[0, 2000, 6000, 10000, 20000, 30000, 40000].map((a, i, arr) => `${altColor(a)} ${((i / (arr.length - 1)) * 100).toFixed(0)}%`).join(", ")})"></div>
              <div class="ticks"><span>0</span><span>2k</span><span>6k</span><span>10k</span><span>20k</span><span>30k</span><span>40k+</span></div></div>
            <div class="attr">Esri, Maxar, Earthstar Geographics, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></div>
          </div>
        </div>

        <div class="pane" id="p-list">
          <div class="tiles" id="rx-tiles"></div>
          <div class="cfilter" id="cfilter"></div>
          <div class="scroll"><table><thead id="lhead"></thead><tbody id="lbody"></tbody></table></div>
          <div class="listbar"><span id="lfoot"></span></div>
        </div>

        <div class="pane" id="p-flight"><div id="flight"></div></div>

        <div class="pane" id="p-coverage"><div id="cov"></div></div>

        <div class="pane" id="p-alerts"><div id="alerts"></div></div>

        <div class="pane" id="p-skyaware"><div id="sa"></div></div>
      </ha-card>`;

    this.$("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-t]");
      if (b) this._setTab(b.dataset.t);
    });
    this.$("zin").addEventListener("click", () => this._zoomBy(1));
    this.$("zout").addEventListener("click", () => this._zoomBy(-1));
    this.$("home").addEventListener("click", () => {
      this._follow = false;
      this._view = null;
      this._renderMap();
    });
    this.$("lbl").addEventListener("click", () => {
      this._labels = !this._labels;
      this._save("labels", this._labels ? 1 : 0);
      this._renderMap();
    });
    this.$("sat").addEventListener("click", () => {
      this._sat = !this._sat;
      this._save("sat", this._sat ? 1 : 0);
      if (this._view) this._view.z = Math.min(this._view.z, this._maxZ());
      this._renderMap();
    });
    this.$("trl").addEventListener("click", () => {
      this._trailsAll = !this._trailsAll;
      this._save("trails", this._trailsAll ? 1 : 0);
      this._renderMap();
    });
    this.$("flt").addEventListener("click", () => {
      this._fOpen = !this._fOpen;
      this._renderFilter();
    });
    const fclick = (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      const [kind, v] = [b.dataset.f, b.dataset.v];
      if (kind === "reset") this._fCls.clear(), this._fAir.clear();
      else if (kind === "close") this._fOpen = false;
      else if (kind === "open") this._fOpen = true;
      else {
        const set = kind === "cls" ? this._fCls : this._fAir;
        set.has(v) ? set.delete(v) : set.add(v);
      }
      this._save("mapcls", [...this._fCls].join(","));
      this._save("mapair", [...this._fAir].join(","));
      this._renderMap();
    };
    this.$("fpanel").addEventListener("click", fclick);
    this.$("fpill").addEventListener("click", fclick);
    this.$("cvm").addEventListener("click", () => {
      this._covOn = !this._covOn;
      this._save("covmap", this._covOn ? 1 : 0);
      if (this._covOn && !this._cov) this._loadCoverage();
      this._renderMap();
    });
    // Alerts settings: switches/inputs save as soon as they change.
    this.$("alerts").addEventListener("change", (e) => {
      const el = e.target.closest("[data-set]");
      if (!el) return;
      const k = el.dataset.set, v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      this._saveSettings(k.startsWith("quiet.") ? { quiet: { [k.slice(6)]: v } } : { [k]: v });
    });
    this.$("alerts").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "watch-in") this.$("watch-add").click();
    });
    this.$("cfilter").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-c]");
      if (!b) return;
      this._clsFilter = b.dataset.c === this._clsFilter ? "all" : b.dataset.c;
      this._save("class", this._clsFilter);
      this._renderList();
    });
    this.$("lhead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]");
      if (!th) return;
      if (this._sort === th.dataset.k) this._sortDir = -this._sortDir;
      else {
        this._sort = th.dataset.k;
        this._sortDir = ["alt", "gs", "rssi", "msgs"].includes(th.dataset.k) ? -1 : 1;
      }
      this._save("sort", this._sort);
      this._save("sortdir", this._sortDir);
      this._renderList();
    });
    this.$("lbody").addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return; // the map pin has its own action
      const tr = e.target.closest("tr[data-hex]");
      if (!tr) return;
      this._select(tr.dataset.hex);
      this._setTab("flight");
    });
    this.shadowRoot.addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const act = a.dataset.act;
      if (act === "details") this._setTab("flight");
      else if (act === "close") this._select(null);
      else if (act === "follow") {
        this._follow = !this._follow;
        if (this._follow && this._selLast) this._centerOn(this._selLast, false);
        this._renderMap();
      } else if (act === "locate") {
        this._locate(a.dataset.hex);
      } else if (act === "showmap") {
        this._follow = true;
        if (this._selLast) this._centerOn(this._selLast, false);
        this._setTab("map");
      } else if (act === "pick") {
        this._select(a.dataset.hex);
        this._renderFlight();
      } else if (act === "watch" || act === "unwatch") {
        const cs = act === "watch" && a.id === "watch-add" ? this.$("watch-in").value.trim() : a.dataset.cs;
        if (cs) this._watch(cs.toUpperCase(), act === "unwatch");
      } else if (act === "test") {
        a.disabled = true;
        this._mon("/api/test-alert", { method: "POST" }).then(() => this._loadMonitor(), () => {}).finally(() => (a.disabled = false));
      } else if (act === "range") {
        this._covRange = a.dataset.r;
        this._save("covrange", this._covRange);
        this._renderCoverage();
      }
    });
    this._initMapInput();
    this._built = true;
    if (this.isConnected && this._ro) this._ro.observe(this.$("map"));
    this._setTab(this._tab);
  }

  _setTab(t) {
    if (!TABS.some(([k]) => k === t)) t = "map";
    this._tab = t;
    this._save("tab", t);
    for (const b of this.$("tabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.t === t);
    for (const [k] of TABS) this.$("p-" + k).classList.toggle("on", k === t);
    if (t === "skyaware" && !this.$("sa").firstChild) {
      const u = (this._base || this._config.urls[0]).replace(/\/$/, "") + this._config.path;
      this.$("sa").innerHTML = `<iframe src="${esc(u)}" title="SkyAware" loading="lazy"></iframe>
        <div class="listbar"><a href="${esc(u)}" target="_blank" rel="noreferrer">Open SkyAware in a new tab</a></div>`;
    }
    if (t === "coverage") {
      this._renderCoverage();
      if (!this._cov || Date.now() - (this._covAt || 0) > 60000) (this._covAt = Date.now()), this._loadCoverage();
    }
    if (t === "alerts") {
      this._renderAlerts(true);
      this._loadMonitor();
    }
    this._renderAll();
  }

  _select(hex) {
    this._sel = hex;
    this._selLast = hex ? this._byHex?.get(hex) || null : null;
    if (this._selLast) this._selSeenAt = (this._now || 0) - (this._selLast.seen || 0);
    if (!hex) this._follow = false;
    this._renderAll();
  }

  _renderAll() {
    if (!this._built) return;
    this._renderHead();
    if (this._tab === "map") this._renderMap();
    if (this._tab === "list") this._renderList();
    if (this._tab === "flight") this._renderFlight();
  }

  _renderHead() {
    if (!this._built) return;
    const st = this.$("state"), acs = this._acs || [];
    const withPos = acs.filter((a) => a.lat !== undefined && a.seen_pos < 60).length;
    if (this._err) {
      st.className = "pill bad";
      st.textContent = this._last ? "Receiver unreachable" : "Can't reach PiAware";
      st.title = this._err;
    } else if (this._last) {
      st.className = "pill ok";
      st.textContent = `${acs.length} aircraft`;
      st.title = `${withPos} with positions`;
    }
    const em = acs.map((a) => [a, this._emerg(a)]).filter(([, x]) => x);
    const e = this.$("emerg");
    e.hidden = !em.length;
    if (em.length) {
      e.className = `pill ${em.some(([, x]) => x.ok) ? "bad" : "warn"}`;
      e.textContent = em.map(([a, x]) => (x.ok ? `${callsign(a) || a.hex} ${x.name}` : `${callsign(a) || a.hex} ${x.code}?`)).join(" · ");
      e.title = em.some(([, x]) => !x.ok) ? "? = not confirmed yet: no matching ADS-B emergency status, and not held for a minute (often a corrupted Mode S reply)" : "";
    }
    const s = this._monStatus?.piaware;
    const dots = s && !this._monErr
      ? `<span class="dots">${[["piaware", "PiAware"], ["adept", "FlightAware"], ["mlat", "MLAT"], ["radio", "Radio"]]
          .filter(([k]) => s[k]).map(([k, l]) => `<span class="dot" title="${esc(s[k].message)}"><i class="${esc(s[k].status)}"></i>${l}</span>`).join("")}</span>`
      : "";
    this.$("meta").innerHTML = `${this._rate !== undefined ? `<span>${num(this._rate)} msg/s</span>` : ""}${dots}`;
    const nw = this._settings?.watch?.length;
    this.$("n-alerts").textContent = nw ? `${nw} watched` : "";
    this.$("n-list").textContent = acs.length ? acs.length : "";
    const sel = this._sel && (this._byHex?.get(this._sel) || this._selLast);
    this.$("n-flight").textContent = sel ? callsign(sel) || sel.hex.toUpperCase() : "";
  }

  // ---- map -----------------------------------------------------------------------------------

  _size() {
    const el = this.$("map");
    return [el.clientWidth, el.clientHeight];
  }

  // Default view: the receiver in the middle, zoomed so the largest ring just fits.
  _defaultView() {
    const [w, h] = this._size();
    const rx = this._rx;
    if (!rx || !w) return null;
    const r = Math.max(...this._config.rings, 50);
    const [nlat] = destPoint(rx.lat, rx.lon, 0, r);
    const span = Math.abs(my(nlat) - my(rx.lat)); // ring radius in world units
    const z = Math.max(3, Math.min(13, Math.log2((Math.min(w, h) / 2 - 24) / (span * 256))));
    return { x: mx(rx.lon), y: my(rx.lat), z };
  }

  _pt(lat, lon, v, w, h) {
    const S = 256 * 2 ** v.z;
    return [(mx(lon) - v.x) * S + w / 2, (my(lat) - v.y) * S + h / 2];
  }

  // From the Aircraft list: select it, centre the map on it (zoomed in to at least z9) and pulse a ring around it.
  _locate(hex) {
    const a = this._byHex?.get(hex);
    if (!a || a.lat === undefined) return;
    this._select(hex);
    this._follow = false;
    const v = this._view || this._defaultView();
    this._view = { x: mx(a.lon), y: my(a.lat), z: Math.max(v?.z || 9, 9) };
    this._flash = { hex, until: Date.now() + 3500 };
    setTimeout(() => this._renderMap(), 3600);
    this._setTab("map");
  }

  _centerOn(ac, render = true) {
    if (!this._view) this._view = this._defaultView();
    if (!this._view) return;
    this._view.x = mx(ac.lon);
    this._view.y = my(ac.lat);
    if (render) this._renderMap();
  }

  // Closest zoom: the gray canvas has tiles to 16 (shown up to 17, scaled); the imagery goes to 19.
  _maxZ() {
    return this._sat ? 19 : 17;
  }

  _zoomBy(dz, px, py) {
    const [w, h] = this._size();
    const v = this._view || this._defaultView();
    if (!v) return;
    const z = Math.max(3, Math.min(this._maxZ(), v.z + dz));
    if (Math.abs(z - v.z) < 1e-3) return;
    if (px === undefined) [px, py] = [w / 2, h / 2];
    const S = 256 * 2 ** v.z, S2 = 256 * 2 ** z;
    const ux = v.x + (px - w / 2) / S, uy = v.y + (py - h / 2) / S;
    this._view = { x: ux - (px - w / 2) / S2, y: uy - (py - h / 2) / S2, z };
    this._frame();
  }

  _initMapInput() {
    const el = this.$("map");
    const pts = new Map();
    let moved = 0, pinch = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ctrls, .pop, .attr, .fpanel, .fpill")) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const [px, py] = pts.get(e.pointerId);
      const dx = e.clientX - px, dy = e.clientY - py;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const v = this._view || (this._view = this._defaultView());
      if (!v) return;
      if (pts.size === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved < 4) return;
        el.classList.add("drag");
        this._follow = false;
        const S = 256 * 2 ** v.z;
        v.x -= dx / S;
        v.y -= dy / S;
        this._frame();
      } else if (pts.size === 2 && pinch) {
        moved = 99;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const r = el.getBoundingClientRect();
        const cx = (a[0] + b[0]) / 2 - r.left, cy = (a[1] + b[1]) / 2 - r.top;
        this._zoomBy(Math.log2(d / pinch), cx, cy);
        pinch = d;
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      el.classList.remove("drag");
      if (pts.size === 0 && moved < 4 && e.type === "pointerup") {
        const r = el.getBoundingClientRect();
        this._clickMap(e.clientX - r.left, e.clientY - r.top);
      }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      if (e.target.closest(".pop, .fpanel")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this._zoomBy(Math.max(-0.5, Math.min(0.5, -px / 250)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest(".ctrls, .pop, .fpanel, .fpill")) return;
      const r = el.getBoundingClientRect();
      this._zoomBy(1, e.clientX - r.left, e.clientY - r.top);
    });
  }

  _frame() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._renderMap();
    });
  }

  _clickMap(x, y) {
    let best = null, bd = 22;
    for (const [hex, px, py] of this._hits || []) {
      const d = Math.hypot(px - x, py - y);
      if (d < bd) (bd = d), (best = hex);
    }
    this._follow = false;
    this._select(best);
  }

  // Esri's gray canvas basemap, or World Imagery when satellite is on (free, no key), plus labels; tiles from the nearest whole zoom, scaled.
  _renderTiles(v, w, h) {
    const box = this.$("tiles");
    if (!this._tiles) this._tiles = new Map();
    const tz = Math.max(0, Math.min(this._sat ? 19 : 16, Math.round(v.z))), n = 2 ** tz;
    const S = 256 * 2 ** v.z, T = S / n; // world size and tile size in px
    const x0 = Math.floor((v.x * S - w / 2) / T), x1 = Math.floor((v.x * S + w / 2) / T);
    const y0 = Math.max(0, Math.floor((v.y * S - h / 2) / T)), y1 = Math.min(n - 1, Math.floor((v.y * S + h / 2) / T));
    const shade = this._dark ? "Dark" : "Light";
    const keep = new Set();
    const src = (layer) => this._sat
      ? (layer === "Base" ? "World_Imagery" : "Reference/World_Boundaries_and_Places")
      : `Canvas/World_${shade}_Gray_${layer}`;
    for (const layer of ["Base", "Reference"]) {
      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
          const wx = ((tx % n) + n) % n;
          const key = `${this._sat ? "s" : shade}/${layer}/${tz}/${tx}/${ty}`;
          keep.add(key);
          let img = this._tiles.get(key);
          if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.style.zIndex = layer === "Base" ? 0 : 1;
            img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/${src(layer)}/MapServer/tile/${tz}/${ty}/${wx}`;
            this._tiles.set(key, img);
            box.appendChild(img);
          }
          const left = Math.round(tx * T - v.x * S + w / 2), top = Math.round(ty * T - v.y * S + h / 2);
          img.style.transform = `translate(${left}px, ${top}px)`;
          img.style.width = img.style.height = `${Math.round((tx + 1) * T - v.x * S + w / 2) - left}px`;
        }
      }
    }
    for (const [k, img] of this._tiles) {
      if (!keep.has(k)) {
        img.remove();
        this._tiles.delete(k);
      }
    }
  }

  _renderMap() {
    if (!this._built || this._tab !== "map") return;
    const [w, h] = this._size();
    if (!w || !h) return;
    const v = this._view || this._defaultView();
    if (!v) return;
    const map = this.$("map");
    const dk = this._dark || this._sat;
    map.style.setProperty("--sa-ring", dk ? "rgba(140,170,255,.55)" : "rgba(40,70,160,.5)");
    map.style.setProperty("--sa-ring-t", dk ? "#b4c6ff" : "#28469f");
    map.style.setProperty("--sa-halo", dk ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.9)");
    map.style.setProperty("--sa-text", dk ? "#f2f2f2" : "#1d1d1d");
    map.style.setProperty("--sa-text2", dk ? "#c9c9c9" : "#444");
    this._renderTiles(v, w, h);
    this.$("lbl").classList.toggle("on", this._labels);
    this.$("sat").classList.toggle("on", this._sat);
    this.$("trl").classList.toggle("on", this._trailsAll);
    const P = (lat, lon) => this._pt(lat, lon, v, w, h);
    const inView = ([x, y], m = 40) => x > -m && y > -m && x < w + m && y < h + m;
    let g = "";
    const rx = this._rx;
    // Range rings (geodesic circles) with labels at the top.
    if (rx) {
      for (const r of this._config.rings) {
        let d = "";
        for (let b = 0; b <= 360; b += 4) {
          const [x, y] = P(...destPoint(rx.lat, rx.lon, b, r));
          d += `${b ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
        }
        g += `<path class="ring" d="${d}Z"/>`;
        const [lx, ly] = P(...destPoint(rx.lat, rx.lon, 0, r));
        g += `<text class="ringl" x="${lx + 4}" y="${ly - 4}">${r} nm</text>`;
      }
      const [hx, hy] = P(rx.lat, rx.lon);
      g += `<g transform="translate(${hx},${hy})"><circle r="6" fill="var(--primary-color)" stroke="var(--sa-halo)" stroke-width="2.5"/><circle r="2" fill="var(--sa-halo)"/></g>`;
    }
    const acs = (this._acs || []).filter((a) => a.lat !== undefined && a.seen_pos < 60 && (a.hex === this._sel || this._shown(a)));
    // Selected flight's route.
    const sel = this._sel && this._byHex?.get(this._sel);
    if (sel?.lat !== undefined) {
      const rt = this._route(sel);
      if (rt) {
        const seg = (a, b, done) => {
          const n = Math.max(2, Math.ceil(dist(a.lat, a.lon, b.lat, b.lon) / 20)), brg = bearing(a.lat, a.lon, b.lat, b.lon), D = dist(a.lat, a.lon, b.lat, b.lon);
          let d = "";
          for (let i = 0; i <= n; i++) {
            const [x, y] = P(...destPoint(a.lat, a.lon, brg, (D * i) / n));
            d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
          }
          return `<path class="route" d="${d}" style="${done ? "opacity:.35" : ""}"/>`;
        };
        g += seg(rt.o, { lat: sel.lat, lon: sel.lon }, true) + seg({ lat: sel.lat, lon: sel.lon }, rt.d, false);
        for (const ap of [rt.o, rt.d]) {
          const [x, y] = P(ap.lat, ap.lon);
          g += `<circle class="apt" cx="${x}" cy="${y}" r="5"/><text class="lbl" x="${x + 8}" y="${y + 4}">${esc(ap.iata || ap.icao)}</text>`;
        }
      }
    }
    // Receiver coverage, last 30 days, all altitudes.
    this.$("cvm").classList.toggle("on", this._covOn);
    if (this._covOn && this._cov && rx) {
      const data = this._covData("30"), n = data.high.length;
      let d = "";
      for (let i = 0; i <= n; i++) {
        const k = i % n, r = Math.max(data.high[k], data.mid[k], data.low[k]);
        const [x, y] = P(...destPoint(rx.lat, rx.lon, (k + 0.5) * (360 / n), r));
        d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }
      g += `<path d="${d}Z" fill="color-mix(in srgb, var(--primary-color) 10%, transparent)" stroke="var(--primary-color)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
    // Trails, coloured by altitude.
    for (const a of acs) {
      const isSel = a.hex === this._sel;
      if (!this._trailsAll && !isSel) continue;
      const tr = STORE.trails.get(a.hex);
      if (!tr || tr.length < 2) continue;
      let prev = P(tr[0].lat, tr[0].lon), out = "";
      for (let i = 1; i < tr.length; i++) {
        const p = P(tr[i].lat, tr[i].lon);
        if (inView(p, 300) || inView(prev, 300))
          out += `<line x1="${prev[0].toFixed(1)}" y1="${prev[1].toFixed(1)}" x2="${p[0].toFixed(1)}" y2="${p[1].toFixed(1)}" stroke="${altColor(tr[i].alt)}"/>`;
        prev = p;
      }
      g += `<g stroke-width="${isSel ? 3 : 1.8}" stroke-linecap="round" opacity="${isSel ? 0.95 : 0.55}">${out}</g>`;
    }
    // Aircraft, selected last so it's on top.
    this._hits = [];
    const order = [...acs].sort((a, b) => (a.hex === this._sel) - (b.hex === this._sel) || (typeof a.alt_baro === "number" ? a.alt_baro : 0) - (typeof b.alt_baro === "number" ? b.alt_baro : 0));
    for (const a of order) {
      const p = P(a.lat, a.lon);
      if (!inView(p)) continue;
      const isSel = a.hex === this._sel;
      const [shape, sc] = shapeOf(a);
      const stale = a.seen_pos > 15;
      const mlat = (a.mlat || []).includes("lat");
      const rot = shape === "ground" ? 0 : a.track ?? a.true_heading ?? 0;
      this._hits.push([a.hex, p[0], p[1]]);
      g += `<g class="ac${stale ? " stale" : ""}" transform="translate(${p[0].toFixed(1)},${p[1].toFixed(1)})">`;
      if (isSel) g += `<circle class="selring" r="${17 * sc}"/>`;
      if (this._flash?.hex === a.hex && Date.now() < this._flash.until)
        g += `<circle r="18" fill="none" stroke="var(--primary-color)" stroke-width="3"><animate attributeName="r" values="14;46" dur="1.1s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.1s" repeatCount="indefinite"/></circle>`;
      const emg = this._emerg(a);
      if (emg) g += `<circle r="${19 * sc}" fill="none" stroke="var(${emg.ok ? "--sa-bad" : "--sa-warn"})" stroke-width="2.5"${emg.ok ? "" : ` stroke-dasharray="4 3"`}/>`;
      g += `<path d="${SHAPES[shape]}" transform="rotate(${rot.toFixed(0)}) scale(${(sc * (isSel ? 1.25 : 1)).toFixed(2)})" fill="${altColor(a.alt_baro, isSel)}" stroke="${mlat ? "#4040ff" : this._dark || this._sat ? "#000" : "#222"}"/>`;
      if (this._labels || isSel) {
        const cs = callsign(a) || a.hex.toUpperCase();
        // Military operator's roundel in front of the callsign.
        const op = this._class(a).k === "mil" ? this._milOp(a) : null, rd = op && ROUNDELS[op.code];
        let lx = 13 * sc + 2;
        if (rd) {
          g += rd.replace("<svg ", `<svg x="${lx}" y="-12" `);
          lx += op.code.startsWith("US") ? 26 : 16;
        }
        g += `<text class="lbl" x="${lx}" y="-1">${esc(cs)}</text>`;
        if (isSel || this._labels) {
          const alt = a.alt_baro === "ground" ? "GND" : typeof a.alt_baro === "number" ? (a.alt_baro >= 18000 ? `FL${Math.round(a.alt_baro / 100)}` : `${num(a.alt_baro)}`) : "";
          g += `<text class="lbl2" x="${13 * sc + 2}" y="11">${alt}${a.gs ? ` · ${Math.round(a.gs)} kt` : ""}</text>`;
        }
      }
      g += `</g>`;
    }
    this.$("ov").innerHTML = g;
    this._renderPop();
    this._renderFilter();
  }

  // Map filter. Picking airlines shows just those airlines' flights (plus any classes also picked);
  // picking only classes shows those classes. Nothing picked: everything.
  _filtering() {
    return this._fCls.size > 0 || this._fAir.size > 0;
  }

  _shown(a) {
    if (!this._filtering()) return true;
    const c = this._class(a).k;
    if (c === "com" && this._fAir.size) return this._fAir.has(carrierOf(a));
    return this._fCls.has(c);
  }

  _renderFilter() {
    if (!this._built || this._tab !== "map") return;
    const acs = (this._acs || []).filter((a) => a.lat !== undefined && a.seen_pos < 60);
    const shown = acs.filter((a) => this._shown(a)).length, on = this._filtering();
    const badge = this.$("fbadge");
    badge.classList.toggle("on", on);
    badge.textContent = on ? this._fCls.size + this._fAir.size : "";
    this.$("flt").classList.toggle("on", !!this._fOpen);
    const pill = this.$("fpill");
    pill.classList.toggle("on", on && !this._fOpen);
    if (on) pill.innerHTML = `<ha-icon icon="mdi:filter-variant" data-f="open"></ha-icon>Showing ${shown} of ${acs.length}<ha-icon icon="mdi:close-circle" data-f="reset" title="Clear filter"></ha-icon>`;
    const panel = this.$("fpanel");
    panel.classList.toggle("on", !!this._fOpen);
    if (!this._fOpen) return;
    const cc = {}, ac = {};
    for (const a of acs) {
      const c = this._class(a).k;
      cc[c] = (cc[c] || 0) + 1;
      const code = c === "com" && carrierOf(a);
      if (code) ac[code] = (ac[code] || 0) + 1;
    }
    const name = (code) => carriers().get(code)?.name || code;
    const airlines = Object.keys(ac).sort((x, y) => ac[y] - ac[x] || name(x).localeCompare(name(y)));
    const html = `
      <div class="fh"><ha-icon icon="mdi:filter-variant" style="--mdc-icon-size:18px"></ha-icon>Show on the map
        ${on ? `<a data-f="reset">Show all</a>` : ""}<ha-icon icon="mdi:close" data-f="close" style="--mdc-icon-size:18px;cursor:pointer;color:var(--secondary-text-color)${on ? "" : ";margin-left:auto"}"></ha-icon></div>
      <h5>Class</h5>
      <div class="fchips">${CLASSES.filter(([c]) => cc[c] || this._fCls.has(c)).map(([c, l, i, col]) =>
        `<button data-f="cls" data-v="${c}" class="${this._fCls.has(c) ? "on" : ""}" style="--c:${col}"><ha-icon icon="${i}"></ha-icon>${l} <span class="n">${cc[c] || 0}</span></button>`).join("")}</div>
      <h5>Airlines in view</h5>
      <div class="fchips">${[...new Set([...airlines, ...this._fAir])].map((code) =>
        `<button data-f="air" data-v="${esc(code)}" class="${this._fAir.has(code) ? "on" : ""}" style="--c:${CLASS.com.c}" title="${esc(code)}${carriers().get(code)?.iata ? " / " + esc(carriers().get(code).iata) : ""}">
          <img src="https://www.flightaware.com/images/airline_logos/90p/${esc(code)}.png" alt="" onerror="this.remove()"><span class="nm">${esc(name(code))}</span> <span class="n">${ac[code] || 0}</span></button>`).join("") || `<span class="muted" style="font-size:.85em">No airline flights in view</span>`}</div>
      <div class="fnote">${on ? `Showing ${shown} of ${acs.length} aircraft. ` : ""}Pick classes, airlines or both. The selected aircraft always stays visible. Remembered in this browser.</div>`;
    if (html !== this._fHtml) {
      const top = panel.scrollTop;
      panel.innerHTML = this._fHtml = html;
      panel.scrollTop = top;
    }
  }

  _renderPop() {
    const pop = this.$("pop");
    const a = this._sel && (this._byHex?.get(this._sel) || this._selLast);
    pop.classList.toggle("on", !!a);
    if (!a) return;
    const cs = callsign(a);
    const rt = this._route(a), info = this._info(a.hex);
    const vr = vrate(a);
    pop.innerHTML = `
      <div class="cs"><span class="sw" style="background:${altColor(a.alt_baro)}"></span>${esc(cs || a.hex.toUpperCase())}${this._tag(this._class(a), true, a)}
        ${info?.icao ? `<span class="tag">${esc(info.icao)}</span>` : ""}${info?.reg ? `<span class="tag">${esc(info.reg)}</span>` : ""}
        <ha-icon class="x" icon="mdi:close" data-act="close"></ha-icon></div>
      <div class="rt">${rt ? `<b>${esc(rt.o.iata || rt.o.icao)}</b> ${esc(rt.o.location)} → <b>${esc(rt.d.iata || rt.d.icao)}</b> ${esc(rt.d.location)}` : `<span class="muted">${cs ? "Route unknown" : "No callsign"}</span>`}</div>
      <div class="kv">
        <div><span>Altitude</span><b>${a.alt_baro === "ground" ? "Ground" : num(a.alt_baro)}</b></div>
        <div><span>Speed</span><b>${num(a.gs)} kt</b></div>
        <div><span>V/S</span><b>${vr ? `${vr > 0 ? "▲" : "▼"} ${num(Math.abs(vr))}` : "level"}</b></div>
        <div><span>Distance</span><b>${num(a._dist, 1)} nm</b></div>
        <div><span>Bearing</span><b>${a._brg !== undefined ? `${num(a._brg)}° ${compass(a._brg)}` : "–"}</b></div>
        <div><span>Squawk</span><b class="${this._emerg(a) ? (this._emerg(a).ok ? "bad" : "warn") : ""}">${esc(a.squawk || "–")}${this._emerg(a) && !this._emerg(a).ok ? "?" : ""}</b></div>
      </div>
      <div class="acts"><button class="btn pri" data-act="details"><ha-icon icon="mdi:information-outline"></ha-icon>Flight details</button>
        <button class="btn ${this._follow ? "on" : ""}" data-act="follow"><ha-icon icon="mdi:crosshairs"></ha-icon>${this._follow ? "Following" : "Follow"}</button>
        ${this._watchBtn(cs, true)}</div>`;
  }

  // ---- list ----------------------------------------------------------------------------------

  _renderList() {
    if (!this._built || this._tab !== "list") return;
    const acs = this._acs || [];
    // Receiver summary tiles.
    const pos = acs.filter((a) => a.lat !== undefined && a.seen_pos < 60);
    const far = pos.reduce((m, a) => (!m || a._dist > m._dist ? a : m), null);
    const high = acs.filter((a) => typeof a.alt_baro === "number").reduce((m, a) => (!m || a.alt_baro > m.alt_baro ? a : m), null);
    const fast = acs.filter((a) => a.gs).reduce((m, a) => (!m || a.gs > m.gs ? a : m), null);
    const near = pos.reduce((m, a) => (!m || a._dist < m._dist ? a : m), null);
    const mlat = acs.filter((a) => (a.mlat || []).includes("lat")).length;
    const name = (a) => (a ? esc(callsign(a) || a.hex.toUpperCase()) : "");
    const tile = (l, v, s) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s || "&nbsp;"}</div></div>`;
    this.$("rx-tiles").innerHTML = [
      tile("Aircraft", `${acs.length}`, `${pos.length} with position · ${mlat} MLAT`),
      tile("Messages", `${num(this._rate)}<small>/s</small>`, this._last ? `${(this._last.messages / 1e6).toFixed(1)} M total` : ""),
      tile("Nearest", near ? `${num(near._dist, 1)}<small>nm</small>` : "–", name(near)),
      tile("Farthest", far ? `${num(far._dist)}<small>nm</small>` : "–", far ? `${name(far)} · ${compass(far._brg)}` : ""),
      tile("Highest", high ? `${num(high.alt_baro)}<small>ft</small>` : "–", name(high)),
      tile("Fastest", fast ? `${num(fast.gs)}<small>kt</small>` : "–", name(fast)),
    ].join("");

    const cols = [
      ["pin", ""], ["cs", "Flight"], ["cls", "Class"], ["route", "Route"], ["type", "Type"], ["reg", "Reg"], ["sq", "Squawk"], ["alt", "Altitude", 1], ["vr", "V/S", 1],
      ["gs", "Speed", 1], ["trk", "Track", 1], ["dist", "Dist", 1], ["rssi", "RSSI", 1], ["msgs", "Msgs", 1], ["seen", "Seen", 1],
    ];
    const key = (a, k) => {
      const info = this._info(a.hex);
      switch (k) {
        case "cs": return callsign(a) || "~" + a.hex;
        case "cls": return CLASSES.findIndex(([c]) => c === this._class(a).k);
        case "route": return this._route(a)?.o.iata || "~";
        case "type": return info?.icao || "~";
        case "reg": return info?.reg || "~";
        case "sq": return a.squawk || "~";
        case "alt": return a.alt_baro === "ground" ? 0 : a.alt_baro ?? -1;
        case "vr": return vrate(a);
        case "gs": return a.gs ?? -1;
        case "trk": return a.track ?? -1;
        case "dist": return a._dist ?? 1e9;
        case "rssi": return a.rssi ?? -99;
        case "msgs": return a.messages ?? 0;
        case "seen": return a.seen ?? 0;
      }
    };
    const k = this._sort, dir = this._sortDir;
    // Class filter chips with counts.
    const counts = {};
    for (const a of acs) counts[this._class(a).k] = (counts[this._class(a).k] || 0) + 1;
    if (this._clsFilter !== "all" && !counts[this._clsFilter]) this._clsFilter = "all";
    const f = this._clsFilter;
    this.$("cfilter").innerHTML = `<button data-c="all" class="${f === "all" ? "on" : ""}">All <span class="n">${acs.length}</span></button>` +
      CLASSES.filter(([c]) => counts[c]).map(([c, l, i, col]) => `<button data-c="${c}" class="${f === c ? "on" : ""}" style="--c:${col}"><ha-icon icon="${i}"></ha-icon>${l} <span class="n">${counts[c]}</span></button>`).join("");
    const rows = [...acs].filter((a) => f === "all" || this._class(a).k === f).sort((a, b) => {
      const x = key(a, k), y = key(b, k);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    this.$("lhead").innerHTML = `<tr>${cols.map(([c, l, r]) => c === "pin" ? `<th class="pin"></th>` : `<th data-k="${c}" class="${r ? "r" : ""}${c === k ? " on" : ""}">${l}${c === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>`;
    this.$("lbody").innerHTML = rows.map((a) => {
      const info = this._info(a.hex), rt = this._route(a);
      const vr = vrate(a);
      const emg = this._emerg(a), em = emg?.ok ? emg.name : "";
      const cls = [a.hex === this._sel ? "sel" : "", a.seen > 30 ? "stale" : "", em ? "emerg" : ""].join(" ");
      return `<tr data-hex="${esc(a.hex)}" class="${cls}">
        <td class="pin">${a.lat !== undefined ? `<button data-act="locate" data-hex="${esc(a.hex)}" title="Show on the map"><ha-icon icon="mdi:map-marker-radius"></ha-icon></button>` : ""}</td>
        <td><span class="sw" style="background:${altColor(a.alt_baro)}"></span><b>${esc(callsign(a) || "")}</b>${callsign(a) ? "" : `<span class="muted">${esc(a.hex.toUpperCase())}</span>`}${(a.mlat || []).includes("lat") ? `<span class="tag">MLAT</span>` : ""}</td>
        <td>${this._tag(this._class(a), false, a)}</td>
        <td>${rt ? `${esc(rt.o.iata || rt.o.icao)} → ${esc(rt.d.iata || rt.d.icao)}` : `<span class="muted">–</span>`}</td>
        <td>${esc(info?.icao || this._classes?.[a.hex]?.type || "")}</td>
        <td>${esc(info?.reg || this._classes?.[a.hex]?.reg || "")}</td>
        <td class="${em ? "bad" : emg ? "warn" : ""}">${esc(a.squawk || "")}${em ? ` ${em}` : emg ? "?" : ""}</td>
        <td class="r">${a.alt_baro === "ground" ? "GND" : num(a.alt_baro)}</td>
        <td class="r">${vr ? `<span class="${vr > 0 ? "good" : "warn"}">${vr > 0 ? "▲" : "▼"}</span> ${num(Math.abs(vr))}` : ""}</td>
        <td class="r">${a.gs ? num(a.gs) : ""}</td>
        <td class="r">${a.track !== undefined ? `${num(a.track)}°` : ""}</td>
        <td class="r">${a._dist !== undefined ? num(a._dist, 1) : ""}</td>
        <td class="r">${num(a.rssi, 1)}</td>
        <td class="r">${num(a.messages)}</td>
        <td class="r">${a.seen < 1 ? "now" : `${Math.round(a.seen)} s`}</td></tr>`;
    }).join("") || `<tr><td colspan="${cols.length}" class="muted">No aircraft right now</td></tr>`;
    this.$("lfoot").textContent = "Click a row for its flight details. Altitudes ft, speeds kt (ground), distances nm from the receiver, V/S ft/min.";
  }

  // ---- flight --------------------------------------------------------------------------------

  _renderFlight() {
    if (!this._built || this._tab !== "flight") return;
    const box = this.$("flight");
    const live = this._sel && this._byHex?.get(this._sel);
    const a = live || (this._sel && this._selLast);
    if (!a) {
      const near = (this._acs || []).filter((x) => x._dist !== undefined && callsign(x)).sort((x, y) => x._dist - y._dist).slice(0, 8);
      box.innerHTML = `<div class="empty"><ha-icon icon="mdi:airplane-search" style="--mdc-icon-size:40px"></ha-icon>
        <div style="margin-top:8px">Pick a plane on the map or in the list${near.length ? ", or one of the nearest:" : "."}</div>
        <div class="picks">${near.map((x) => `<button class="btn" data-act="pick" data-hex="${esc(x.hex)}"><span class="sw" style="background:${altColor(x.alt_baro)}"></span>${esc(callsign(x))} <span class="muted">${num(x._dist)} nm</span></button>`).join("")}</div></div>`;
      return;
    }
    const cs = callsign(a), info = this._info(a.hex), rt = this._route(a);
    const al = cs ? STORE.airlines.get(cs) : null;
    const photo = STORE.photos.get(a.hex);
    const vr = vrate(a);
    const lostFor = live ? 0 : Math.max(0, (this._now || 0) - (this._selSeenAt || 0));
    const emg = this._emerg(a), sqName = emg?.ok ? emg.name : "";

    // Phase of flight.
    let phase = "";
    if (a.alt_baro === "ground") phase = "On the ground";
    else if (typeof a.alt_baro === "number") {
      if (rt && rt.togo < 40 && a.alt_baro < 10000) phase = "On approach";
      else if (vr > 500) phase = "Climbing";
      else if (vr < -500) phase = "Descending";
      else phase = a.alt_baro > 18000 ? "Cruising" : "Level";
    }

    // Header.
    const airlineName = al?.airline?.name;
    const iataFlight = al?.callsign_iata;
    const logo = (al?.airline?.icao || (rt && /^[A-Z]{3}\d/.test(cs) ? cs.slice(0, 3) : "")) || "";
    let html = `<div class="fhead">
      <div class="photo-wrap">${photo?.src ? `<a href="${esc(photo.link)}" target="_blank" rel="noreferrer"><img class="photo" src="${esc(photo.src)}" alt=""></a><div class="cr">© ${esc(photo.by)}</div>`
        : `<div class="photo" style="display:flex;align-items:center;justify-content:center;color:var(--secondary-text-color)"><ha-icon icon="mdi:airplane" style="--mdc-icon-size:48px;opacity:.4"></ha-icon></div>`}</div>
      <div class="fid">
        <div class="cs">${esc(cs || a.hex.toUpperCase())}${iataFlight && iataFlight !== cs ? `<span class="pill dim">${esc(iataFlight)}</span>` : ""}${this._tag(this._class(a), false, a)}
          ${phase ? `<span class="pill ok">${phase}</span>` : ""}${!live ? `<span class="pill warn">Signal lost</span>` : ""}${sqName ? `<span class="pill bad">${sqName} · ${a.squawk}</span>` : emg ? `<span class="pill warn" title="Not confirmed yet: often a corrupted Mode S reply">${esc(emg.code)} unconfirmed</span>` : ""}</div>
        <div class="al">${logo ? `<img src="https://www.flightaware.com/images/airline_logos/90p/${esc(logo)}.png" alt="" onerror="this.remove()">` : ""}${esc(airlineName || info?.owner || (this._class(a).k === "mil" && this._milOp(a)?.name) || (cs ? "" : "No callsign"))}</div>
        <div class="ty">${[info?.mfr && info?.type ? `${info.mfr} ${info.type}` : info?.type, info?.icao && `(${info.icao})`].filter(Boolean).map(esc).join(" ")}
          ${info?.reg ? ` · <b>${esc(info.reg)}</b>` : ""}${info?.owner && airlineName && info.owner !== airlineName ? ` · ${esc(info.owner)}` : ""}</div>
        <div class="ty">ICAO ${esc(a.hex.toUpperCase())}${a.category ? ` · ${esc(CATEGORY[a.category] || a.category)}` : ""}${info?.country ? ` · ${esc(info.country)}` : ""}${(a.mlat || []).includes("lat") ? " · position by MLAT" : a.version !== undefined ? ` · ADS-B v${a.version}` : ""}</div>
      </div></div>`;

    // Route, progress and ETA.
    if (rt && rt.flown !== null) {
      const total = rt.flown + rt.togo;
      const pct = Math.max(0, Math.min(1, rt.flown / total));
      const etaMin = a.gs > 40 && a.alt_baro !== "ground" ? (rt.togo / a.gs) * 60 : null;
      const ap = (x, cls) => `<div class="ap ${cls}"><div class="code">${esc(x.iata || x.icao)}</div><div class="city">${esc(x.location || "")}</div><div class="nm">${esc(x.name || "")}${x.icao ? ` · ${esc(x.icao)}` : ""}</div></div>`;
      html += `<div class="route-box">
        <div class="rt-row">${ap(rt.o, "org")}<div class="rt-mid">${num(rt.direct)} nm<br>${rt.legs > 1 ? `${rt.legs} legs: ${rt.all.map((x) => esc(x.iata || x.icao)).join(" → ")}` : "direct"}</div>${ap(rt.d, "dst")}</div>
        <div class="prog"><div class="track"></div><div class="done" style="width:${(pct * 100).toFixed(1)}%"></div><div class="end l"></div><div class="end r"></div>
          <span class="pl" style="left:${(pct * 100).toFixed(1)}%"><ha-icon icon="mdi:airplane"></ha-icon></span></div>
        <div class="prog-lab"><span>${num(rt.flown)} nm flown</span><span>${Math.round(pct * 100)}%</span><span>${num(rt.togo)} nm to go</span></div>
        <div class="eta">
          <div><span class="lab">Estimated arrival</span><span class="big">${etaMin !== null ? hhmm(Date.now() + etaMin * 60000) : "–"}</span></div>
          <div><span class="lab">Time to go</span><span class="big">${etaMin !== null ? (etaMin < 60 ? `${Math.round(etaMin)} min` : `${Math.floor(etaMin / 60)} h ${Math.round(etaMin % 60)} min`) : "–"}</span></div>
          <div><span class="lab">Heading to destination</span><span class="big">${a.lat !== undefined ? `${num(bearing(a.lat, a.lon, rt.d.lat, rt.d.lon))}°` : "–"}</span></div>
          <div class="muted" style="font-size:.75em;flex-basis:100%">Arrival is estimated from the distance left and current ground speed (your local time); approach and holding add a few minutes.</div>
        </div>
        ${!rt.plausible || rt.detour > Math.max(60, rt.direct * 0.25) ? `<div class="warnbox">This route is from a public database and doesn't quite match where the plane is; it may be out of date.</div>` : ""}
      </div>`;
    } else {
      html += `<div class="route-box"><div class="muted">${cs ? `No published route for ${esc(cs)}${STORE.routes.has(cs) ? "" : " yet (looking it up…)"}. Private, military, cargo and charter flights often have none.` : "This aircraft isn't sending a callsign, so its route can't be looked up."}</div></div>`;
    }

    // Live data tiles.
    const tile = (l, v, s, cls = "") => `<div class="tile"><div class="l">${l}</div><div class="v ${cls}">${v}</div><div class="s">${s || "&nbsp;"}</div></div>`;
    const alt = a.alt_baro;
    html += `<div class="tiles" style="margin-top:12px">
      ${tile("Altitude", alt === "ground" ? "Ground" : `${num(alt)}<small>ft</small>`, a.alt_geom ? `GPS ${num(a.alt_geom)} ft` : typeof alt === "number" && alt >= 18000 ? `FL${Math.round(alt / 100)}` : "")}
      ${tile("Vertical speed", vr ? `${vr > 0 ? "▲" : "▼"} ${num(Math.abs(vr))}<small>ft/min</small>` : "Level", a.baro_rate !== undefined ? "barometric" : a.geom_rate !== undefined ? "GPS" : "", vr > 0 ? "good" : vr < 0 ? "warn" : "")}
      ${tile("Ground speed", `${num(a.gs)}<small>kt</small>`, a.gs ? `${num(a.gs * 1.852)} km/h${a.tas ? ` · TAS ${num(a.tas)} kt` : ""}${a.mach ? ` · M${a.mach.toFixed(2)}` : ""}` : "")}
      ${tile("Track", a.track !== undefined ? `${num(a.track)}°` : "–", a.track !== undefined ? `heading ${compass(a.track)}` : "")}
      ${tile("From you", a._dist !== undefined ? `${num(a._dist, 1)}<small>nm</small>` : "–", a._brg !== undefined ? `${num(a._dist * 1.852)} km · ${num(a._brg)}° ${compass(a._brg)}` : "")}
      ${tile("Squawk", esc(a.squawk || "–"), sqName || (a.squawk === "1200" ? "VFR" : ""), sqName ? "bad" : "")}
      ${tile("Autopilot", a.nav_altitude_mcp !== undefined ? `${num(a.nav_altitude_mcp)}<small>ft</small>` : "–",
        [a.nav_heading !== undefined && `hdg ${num(a.nav_heading)}°`, a.nav_qnh && `QNH ${num(a.nav_qnh, 1)}`, (a.nav_modes || []).map((m) => MODES[m] || m).join(" ")].filter(Boolean).join(" · ") || "selected altitude")}
      ${tile("Signal", `${num(a.rssi, 1)}<small>dBFS</small>`, `${num(a.messages)} msgs · seen ${live ? (a.seen < 1 ? "now" : `${Math.round(a.seen)} s ago`) : `${ago(lostFor)} ago`}`)}
    </div>`;

    // Altitude and speed since we've been tracking it.
    const tr = STORE.trails.get(a.hex) || [];
    html += `<div class="grid2">
      <div class="panel"><h4>Altitude (ft)</h4><div class="ch" id="c-alt"></div></div>
      <div class="panel"><h4>Ground speed (kt)</h4><div class="ch" id="c-gs"></div></div></div>`;

    // Links.
    const q = encodeURIComponent(cs || a.hex);
    html += `<div class="links">
      <button class="btn pri" data-act="showmap"><ha-icon icon="mdi:map-marker-radius"></ha-icon>Show on map</button>
      ${this._watchBtn(cs)}${this._monErr && cs ? `<span class="bad" style="font-size:.8em;align-self:center">adsb-monitor unreachable: ${esc(this._monErr)}</span>` : ""}
      ${cs ? `<a class="btn" href="https://flightaware.com/live/flight/${q}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>FlightAware</a>
              <a class="btn" href="https://www.flightradar24.com/${q}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>Flightradar24</a>` : ""}
      <a class="btn" href="https://globe.adsbexchange.com/?icao=${esc(a.hex)}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>ADS-B Exchange</a>
      ${info?.reg ? `<a class="btn" href="https://www.planespotters.net/search?q=${encodeURIComponent(info.reg)}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>Planespotters</a>` : ""}
    </div>`;
    box.innerHTML = html;
    const now = this._now || Date.now() / 1000;
    this._spark(this.$("c-alt"), tr.map((p) => ({ t: p.t, v: p.alt === "ground" ? 0 : p.alt })), now, 2000, (v) => altColor(v));
    this._spark(this.$("c-gs"), tr.map((p) => ({ t: p.t, v: p.gs })), now, 40);
  }

  // ---- coverage -----------------------------------------------------------------------------

  // Farthest range per bearing bucket and band over the chosen period ("1"/"7"/"30" days, or "all").
  _covData(range) {
    const c = this._cov, out = {};
    const n = c?.buckets || 72;
    for (const [b] of BANDS) {
      if (range === "all") out[b] = (c?.allTime?.[b] || []).map((x) => x?.d || 0);
      else {
        out[b] = Array(n).fill(0);
        const days = Object.keys(c?.days || {}).sort().slice(-Number(range));
        for (const k of days) (c.days[k][b] || []).forEach((v, i) => (out[b][i] = Math.max(out[b][i], v || 0)));
      }
      while (out[b].length < n) out[b].push(0);
    }
    return out;
  }

  _renderCoverage() {
    if (!this._built || this._tab !== "coverage") return;
    const box = this.$("cov");
    if (!this._cov) {
      box.innerHTML = `<div class="empty">${this._covErr ? `Can't reach adsb-monitor (${esc(this._covErr)}). Coverage is recorded by adsb-monitor.` : "Loading coverage…"}</div>`;
      return;
    }
    const c = this._cov, range = this._covRange, data = this._covData(range), n = data.high.length;
    const maxD = Math.max(50, ...BANDS.flatMap(([b]) => data[b]));
    const step = maxD > 260 ? 100 : 50, R = Math.ceil(maxD / step) * step;
    const W = 520, cx = W / 2, cy = W / 2, rad = W / 2 - 34;
    const xy = (brg, d) => [cx + (d / R) * rad * Math.sin(brg * RAD), cy - (d / R) * rad * Math.cos(brg * RAD)];
    let g = "";
    for (let d = step; d <= R; d += step) {
      g += `<circle class="pr" cx="${cx}" cy="${cy}" r="${((d / R) * rad).toFixed(1)}"/>`;
      const [lx, ly] = xy(45, d);
      g += `<text class="pl" x="${lx + 3}" y="${ly - 3}">${d} nm</text>`;
    }
    for (let b = 0; b < 360; b += 30) {
      const [x, y] = xy(b, R), [lx, ly] = xy(b, R * 1.09);
      g += `<line class="pr" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      g += `<text class="pl" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" style="${b % 90 ? "" : "font-weight:700;font-size:13px"}">${b % 90 ? b + "°" : ["N", "E", "S", "W"][b / 90]}</text>`;
    }
    for (const [b, , alt] of BANDS) {
      const col = altColor(alt);
      let d = "";
      for (let i = 0; i <= n; i++) {
        const [x, y] = xy((i % n + 0.5) * (360 / n), data[b][i % n]);
        d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }
      g += `<path d="${d}Z" fill="${col}" fill-opacity=".22" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>`;
    }
    // Hover wedges with the numbers.
    for (let i = 0; i < n; i++) {
      const a0 = i * (360 / n), a1 = (i + 1) * (360 / n);
      const [x0, y0] = xy(a0, R), [x1, y1] = xy(a1, R);
      g += `<path class="wedge" d="M${cx},${cy}L${x0.toFixed(1)},${y0.toFixed(1)}A${rad},${rad} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}Z"><title>${a0}°–${a1}° (${compass((a0 + a1) / 2)})\n${BANDS.map(([b, l]) => `${l}: ${data[b][i] ? Math.round(data[b][i]) + " nm" : "–"}`).join("\n")}</title></path>`;
    }
    g += `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--primary-color)"/>`;

    // Side panel: farthest per band, records.
    const far = (b) => {
      let best = 0, bi = -1;
      data[b].forEach((v, i) => v > best && ((best = v), (bi = i)));
      return bi < 0 ? null : { d: best, brg: (bi + 0.5) * (360 / n) };
    };
    const days = Object.keys(c.days || {}).sort();
    const sel = range === "all" ? days : days.slice(-Number(range));
    const dmax = sel.map((k) => c.days[k].max).filter(Boolean).sort((a, b) => b.d - a.d)[0];
    let rec = null;
    for (const [b] of BANDS) for (const x of c.allTime?.[b] || []) if (x && (!rec || x.d > rec.d)) rec = x;
    const recLine = (x) => x ? `<b>${num(x.d, 1)} nm</b>${x.brg !== undefined ? ` ${compass(x.brg)}` : ""} · ${esc(x.flight || x.hex?.toUpperCase() || "")} at ${typeof x.alt === "number" ? num(x.alt) + " ft" : "?"}<div class="muted" style="font-size:.85em">${new Date(x.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : "–";
    const avgAc = sel.length ? sel.reduce((a, k) => a + (c.days[k].aircraft || 0), 0) / sel.length : 0;
    const side = `<div class="panel"><h4>Farthest by altitude</h4>
        ${BANDS.map(([b, l, alt]) => {
          const f = far(b);
          return `<div class="bandrow"><span class="swq" style="background:${altColor(alt)}"></span>${l}<span class="v">${f ? `${num(f.d)} nm <span class="muted" style="font-weight:400">${compass(f.brg)}</span>` : "–"}</span></div>`;
        }).join("")}</div>
      <div class="panel" style="margin-top:10px"><h4>${range === "all" ? "Farthest ever" : "Farthest in this period"}</h4>${recLine(range === "all" ? rec : dmax)}</div>
      <div class="panel" style="margin-top:10px"><h4>Traffic</h4>
        <div class="bandrow">Aircraft per day (avg)<span class="v">${num(avgAc)}</span></div>
        <div class="bandrow">Today so far<span class="v">${num(c.days?.[days[days.length - 1]]?.aircraft)}</span></div>
        <div class="bandrow">Recording since<span class="v">${days[0] ? esc(new Date(days[0] + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" })) : "–"}</span></div></div>
      <div class="muted" style="font-size:.75em;margin-top:8px">Each 5° slice shows the farthest position received in that direction. Hover a slice for the numbers. Recorded by adsb-monitor.</div>`;

    box.innerHTML = `<div class="chips" style="margin-bottom:10px">${RANGES.map(([k, l]) => `<button data-act="range" data-r="${k}" class="${k === range ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="covwrap"><div class="panel polar"><svg viewBox="0 0 ${W} ${W}">${g}</svg></div><div>${side}</div></div>
      <div class="grid2"><div class="panel"><h4>Aircraft per day</h4><div class="bars" id="b-ac"></div></div>
        <div class="panel"><h4>Farthest per day (nm)</h4><div class="bars" id="b-far"></div></div></div>`;
    const last = days.slice(-30);
    const lab = (k) => new Date(k + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" });
    this._bars(this.$("b-ac"), last.map((k) => ({ l: lab(k), v: c.days[k].aircraft || 0 })));
    this._bars(this.$("b-far"), last.map((k) => ({ l: lab(k), v: c.days[k].max?.d || 0, s: c.days[k].max ? `${c.days[k].max.flight || ""} ${compass(c.days[k].max.brg)}` : "" })));
  }

  _bars(el, items) {
    if (!items.length) {
      el.innerHTML = `<div class="muted" style="font-size:.85em;padding:30px 0;text-align:center">No days recorded yet</div>`;
      return;
    }
    const W = Math.max(260, el.clientWidth || 300), H = 130, pad = { l: 34, r: 4, t: 6, b: 18 };
    const max = Math.max(1, ...items.map((x) => x.v));
    const bw = (W - pad.l - pad.r) / Math.max(items.length, 7);
    const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    let g = `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max)}" y2="${y(max)}"/><text class="ax" x="${pad.l - 4}" y="${y(max) + 3}" text-anchor="end">${num(max)}</text>`;
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/><text class="ax" x="${pad.l - 4}" y="${y(0) + 3}" text-anchor="end">0</text>`;
    items.forEach((it, i) => {
      const x = pad.l + i * bw + 1;
      g += `<rect class="b" x="${x.toFixed(1)}" y="${y(it.v).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(y(0) - y(it.v)).toFixed(1)}" rx="2"><title>${esc(it.l)}: ${num(it.v)}${it.s ? ` · ${esc(it.s)}` : ""}</title></rect>`;
    });
    g += `<text class="ax" x="${pad.l}" y="${H - 4}">${esc(items[0].l)}</text><text class="ax" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${esc(items[items.length - 1].l)}</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" class="ch">${g}</svg>`;
  }

  // ---- alerts -------------------------------------------------------------------------------

  _renderAlerts(force) {
    if (!this._built || this._tab !== "alerts") return;
    const box = this.$("alerts");
    if (!force && box.contains(this.shadowRoot.activeElement)) return; // don't clobber typing
    const s = this._settings;
    if (!s) {
      box.innerHTML = `<div class="empty">${this._monErr ? `Can't reach adsb-monitor (${esc(this._monErr)}).<br>Alerts are sent by adsb-monitor (set <code>monitor</code> in the card's configuration).` : "Loading…"}</div>`;
      return;
    }
    const st = this._monStatus, ap = s.airport || {};
    const sw = (k, on) => `<input type="checkbox" class="tg" data-set="${k}" ${on ? "checked" : ""}>`;
    const nb = (k, v, min, max) => `<input type="number" data-set="${k}" value="${esc(v)}" min="${min}" max="${max}">`;
    const list = this._alertsList || [];
    const icon = { squawk: "mdi:alert-octagon", military: "mdi:shield-airplane", heli: "mdi:helicopter", overhead: "mdi:home-alert", watch: "mdi:airplane-landing", test: "mdi:bell-check" };
    box.innerHTML = `
      <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <ha-icon icon="mdi:cellphone-message" style="color:var(--primary-color)"></ha-icon>
        <div style="flex:1;min-width:220px;font-size:.88em">Sticky phone notifications from <b>adsb-monitor</b>, which watches the receiver around the clock,
          through the HA automation <b>ADS-B alerts</b>. Tap one to open this tab.
          <div class="muted">${this._monErr ? `<span class="bad">Monitor unreachable: ${esc(this._monErr)}</span>` : st ? `Monitor ${st.ok ? `<span class="good">running</span>` : `<span class="warn">not getting data</span>`} · ${st.webhook ? "webhook set" : `<span class="bad">no HA webhook</span>`} · database: ${num(st.db?.military)} military, ${num(st.db?.helicopters)} helicopters${st.quiet ? " · <b>quiet hours now</b>" : ""}` : ""}</div></div>
        <button class="btn" data-act="test"><ha-icon icon="mdi:send"></ha-icon>Send a test</button>
      </div>
      <div class="grid2">
        <div class="panel"><h4>Alert me about</h4>
          <div class="arow">${sw("squawk", s.squawk)}<div class="grow">Emergency squawks<div class="sub">7700 emergency, 7600 radio failure, 7500 hijack, at any distance</div></div></div>
          <div class="arow">${sw("military", s.military)}<div class="grow">Military aircraft<div class="sub">from the tar1090 database and military address blocks</div></div>within ${nb("militaryRadius", s.militaryRadius, 1, 250)} nm</div>
          <div class="arow">${sw("heli", s.heli)}<div class="grow">Helicopters<div class="sub">civil ones; military helicopters count as military</div></div>within ${nb("heliRadius", s.heliRadius, 1, 100)} nm</div>
          <div class="arow">${sw("overhead", s.overhead ?? true)}<div class="grow">Overhead<div class="sub">a military aircraft or helicopter passing close: alert again even if it already alerted, at most once per ${nb("overheadMinutes", s.overheadMinutes ?? 60, 10, 1440)} min</div></div>within ${nb("overheadRadius", s.overheadRadius ?? 3, 0.5, 20)} nm</div>
          <div class="arow"><div class="grow">Same aircraft again after<div class="sub">for military and helicopter alerts</div></div>${nb("cooldownHours", s.cooldownHours, 1, 72)} h</div>
          <div class="arow">${sw("quiet.enabled", s.quiet?.enabled)}<div class="grow">Quiet hours<div class="sub">hold back military and helicopter alerts (squawks and watched flights still come through)</div></div>
            <input type="time" data-set="quiet.start" value="${esc(s.quiet?.start)}"> to <input type="time" data-set="quiet.end" value="${esc(s.quiet?.end)}"></div>
        </div>
        ${!s.airport ? `<div class="panel"><h4>Flights landing</h4><div class="muted" style="font-size:.88em">Landing alerts are off: set <code>AIRPORT</code> (an ICAO code such as KBOS or EGLL) in adsb-monitor's <code>.env</code> and restart it.</div></div>` : `
        <div class="panel"><h4>Flights landing at ${esc(ap.iata || ap.icao)} · ${esc(ap.name || "")}</h4>
          <div class="sub muted" style="font-size:.82em;margin-bottom:8px">An alert when the flight is on approach (within 20 nm, descending below 6,000 ft, with an estimated landing time), then another when it lands.
            The flight comes off the list after it lands, or after 36 hours. Use the Flight tab's bell button, or type a flight number (AC612 or ACA612).</div>
          <div class="wl">${(s.watch || []).map((w) => `<span class="wchip"><ha-icon icon="mdi:airplane-landing" style="cursor:default;color:var(--primary-color)"></ha-icon>${esc(w.label || w.callsign)}${w.airline ? ` <span class="muted">${esc(w.airline)}</span>` : ""}<ha-icon icon="mdi:close" data-act="unwatch" data-cs="${esc(w.callsign)}" title="Stop watching"></ha-icon></span>`).join("") || `<span class="muted" style="font-size:.88em">No flights watched</span>`}</div>
          <div class="arow" style="border:none"><input type="text" id="watch-in" placeholder="Flight number" maxlength="8" style="width:140px;text-transform:uppercase">
            <button class="btn pri" id="watch-add" data-act="watch"><ha-icon icon="mdi:bell-plus"></ha-icon>Watch</button></div>
        </div>`}
      </div>
      <div class="panel" style="margin-top:10px"><h4>Recent alerts</h4><div class="alog">
        ${list.map((a) => `<div class="arow"><span class="t">${new Date(a.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
          <ha-icon icon="${icon[a.kind] || "mdi:bell"}" style="--mdc-icon-size:20px;color:${a.kind === "squawk" ? "var(--sa-bad)" : "var(--primary-color)"}"></ha-icon>
          <div class="grow"><div>${esc(a.title)}${a.sent === false ? ` <span class="pill bad">not delivered</span>` : ""}</div><div class="msg">${esc(a.message)}</div></div></div>`).join("") || `<div class="muted" style="font-size:.88em">None yet</div>`}
      </div></div>`;
  }

  // Small SVG line chart over the tracked period; color(v) colours each segment (altitude), else primary.
  _spark(el, pts, now, minSpan, color) {
    pts = pts.filter((p) => typeof p.v === "number");
    if (pts.length < 2) {
      el.innerHTML = `<div class="muted" style="font-size:.85em;padding:30px 0;text-align:center">Not enough track yet</div>`;
      return;
    }
    const W = Math.max(260, el.clientWidth || 300), H = 130, pad = { l: 44, r: 8, t: 6, b: 18 };
    const t0 = pts[0].t, t1 = Math.max(now, pts[pts.length - 1].t);
    let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0, mid - minSpan / 2);
      hi = lo + minSpan;
    }
    // Round the axis to a 1/2/2.5/5 step so the gridlines get round numbers.
    const raw = (hi - lo) / 3, e = 10 ** Math.floor(Math.log10(raw)), f = raw / e;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
    lo = Math.floor(lo / step) * step;
    hi = Math.max(lo + 3 * step, Math.ceil(hi / step) * step);
    const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    let g = "";
    for (let v = lo; v <= hi + step / 2; v += step) {
      g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pad.l - 4}" y="${y(v) + 3}" text-anchor="end">${num(v)}</text>`;
    }
    g += `<text class="ax" x="${pad.l}" y="${H - 4}">${hhmm(t0 * 1000)}</text><text class="ax" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${hhmm(t1 * 1000)}</text>`;
    if (color) {
      for (let i = 1; i < pts.length; i++)
        g += `<line x1="${x(pts[i - 1].t)}" y1="${y(pts[i - 1].v)}" x2="${x(pts[i].t)}" y2="${y(pts[i].v)}" stroke="${color(pts[i].v)}" stroke-width="2.5" stroke-linecap="round"/>`;
    } else {
      g += `<polyline fill="none" stroke="var(--primary-color)" stroke-width="2" points="${pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>`;
    }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}</svg>`;
  }
}

customElements.define("skyaware-card", SkyAwareCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "skyaware-card",
  name: "SkyAware",
  description: "Live aircraft from a PiAware/SkyAware receiver: map with range rings, aircraft list, and the selected flight's route, ETA and details.",
});
