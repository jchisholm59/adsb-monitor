'use strict';
// ADS-B monitor: watches the PiAware receiver's aircraft.json around the clock (the HA card only runs while it's open).
// - Coverage: farthest position per 5° of bearing and altitude band, per day, for the card's polar chart.
// - Alerts: emergency squawks, military aircraft and helicopters nearby, and watched flights landing at the home
//   airport, sent to Home Assistant's webhook (an HA automation turns them into sticky phone notifications).
// - Proxy: /skyaware/* and /status.json from PiAware with CORS, so the card works over Tailscale.
// No dependencies. Settings, coverage and the alert log live in data/.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {}

// Everything station-specific comes from .env (see .env.example).
const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => (Number.isFinite(Number(env(k))) && env(k) !== '' ? Number(env(k)) : d);
const PORT = num('PORT', 7100);
const PIAWARE = env('PIAWARE', 'http://piaware.local').replace(/\/$/, '');
const SKYAWARE = ('/' + env('SKYAWARE_PATH', '/skyaware/') + '/').replace(/\/+/g, '/');
const HA_WEBHOOK = env('HA_WEBHOOK');
const UA = 'adsb-monitor/1.0 (+https://github.com/jchisholm59/adsb-monitor)';
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const COVERAGE_FILE = path.join(DATA_DIR, 'coverage.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const DB_FILE = path.join(DATA_DIR, 'aircraft.csv.gz');
const DB_URL = 'https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz';

const POLL_MS = 2000;
const SAVE_MS = 60_000;
const DB_MAX_AGE_MS = 7 * 86400_000;
const KEEP_DAYS = 60;
const NM = 3440.065;
const RAD = Math.PI / 180;
const BUCKETS = 72; // 5° each
const BANDS = [['low', -1e9, 10000], ['mid', 10000, 25000], ['high', 25000, 1e9]];
const SQUAWKS = { '7500': 'Hijack', '7600': 'Radio failure', '7700': 'Emergency' };
// ADS-B emergency status that goes with each squawk (dump1090-fa's `emergency` field).
const SQUAWK_EMERGENCY = { '7500': 'unlawful', '7600': 'nordo', '7700': 'general' };
// Military ICAO address blocks (as in readsb) and callsign prefixes, on top of the database's military flag.
const MIL_RANGES = [[0xadf7c8, 0xafffff], [0xc20000, 0xc3ffff], [0x43c000, 0x43cfff], [0x3aa000, 0x3affff], [0x3b7000, 0x3bffff], [0x3ea000, 0x3ebfff], [0x3f4000, 0x3fbfff]];
const MIL_CALLSIGN = /^(CFC|RCH|CNV|RRR|ASY|NATO|PAT|SAM|SPAR|GAF|CTM|BAF|IAM|HKY|KIWI|TUAF|VENUS|NAVY|ARMY|EVAC|REACH|TOPCT)\d/;

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

// Starting values; after that the card's Alerts tab changes them (data/settings.json).
const DEFAULT_SETTINGS = {
  squawk: true, // 7500/7600/7700 or an ADS-B emergency, any distance
  military: true,
  militaryRadius: num('MILITARY_RADIUS', 30), // nm from the receiver
  heli: true,
  heliRadius: num('HELI_RADIUS', 10),
  watch: [], // [{callsign, added, label}] alert when landing at `airport`
  cooldownHours: num('COOLDOWN_HOURS', 6), // per aircraft, for military/helicopter alerts
  quiet: { enabled: false, start: '23:00', end: '07:00' }, // holds back military/helicopter alerts only
};
const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const AIRPORT_FILE = path.join(DATA_DIR, 'airport.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- helpers -------------------------------------------------------------

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return dflt;
  }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
async function fetchT(url, opt = {}, ms = 5000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opt, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opt.headers || {}) } });
  } finally {
    clearTimeout(to);
  }
}
async function getJson(url, opt, ms) {
  const r = await fetchT(url, opt, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
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
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
const callsign = (a) => (a.flight || '').trim().toUpperCase();
const dayKey = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA'); // local YYYY-MM-DD
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); // 24-hour
const fmtAlt = (alt) => (alt === 'ground' ? 'on the ground' : typeof alt === 'number' ? `${alt.toLocaleString('en-CA')} ft` : 'altitude unknown');
function vrate(a) {
  const v = a.baro_rate ?? a.geom_rate ?? 0;
  return Math.abs(v) <= 64 ? 0 : v;
}

// ---- settings --------------------------------------------------------------

let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
settings.quiet = { ...DEFAULT_SETTINGS.quiet, ...settings.quiet };
// The home airport comes from .env (AIRPORT=ICAO code), not from the card; looked up below.
settings.airport = null;

function saveSettings() {
  const { airport, ...s } = settings;
  writeJson(SETTINGS_FILE, s);
}

// AIRPORT=KBOS -> name, position and elevation from OurAirports (cached in data/airport.json). Any of
// AIRPORT_NAME / AIRPORT_IATA / AIRPORT_LAT / AIRPORT_LON / AIRPORT_ELEV in .env override what it finds.
async function loadAirport() {
  const icao = env('AIRPORT').toUpperCase();
  if (!icao) return log('no AIRPORT set: landing alerts are off');
  let ap = readJson(AIRPORT_FILE, null);
  if (!ap || ap.icao !== icao) {
    ap = null;
    try {
      const r = await fetchT(AIRPORTS_URL, {}, 60_000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rl = readline.createInterface({ input: require('stream').Readable.fromWeb(r.body), crlfDelay: Infinity });
      let cols = null;
      for await (const line of rl) {
        const f = (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
        if (!cols) {
          cols = f;
          continue;
        }
        const row = Object.fromEntries(cols.map((c, i) => [c, f[i]]));
        if (row.ident === icao || row.gps_code === icao || row.icao_code === icao) {
          ap = { icao, iata: row.iata_code || '', name: row.name, lat: Number(row.latitude_deg), lon: Number(row.longitude_deg), elev: Number(row.elevation_ft) || 0 };
          break;
        }
      }
      if (ap) writeJson(AIRPORT_FILE, ap);
      else log(`airport ${icao} not found in OurAirports`);
    } catch (e) {
      log('airport lookup failed:', e.message);
    }
  }
  ap = { icao, iata: '', name: icao, lat: NaN, lon: NaN, elev: 0, ...(ap || {}) };
  if (env('AIRPORT_NAME')) ap.name = env('AIRPORT_NAME');
  if (env('AIRPORT_IATA')) ap.iata = env('AIRPORT_IATA').toUpperCase();
  ap.lat = num('AIRPORT_LAT', ap.lat);
  ap.lon = num('AIRPORT_LON', ap.lon);
  ap.elev = num('AIRPORT_ELEV', ap.elev);
  if (!Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) return log(`airport ${icao}: no position, set AIRPORT_LAT/AIRPORT_LON`);
  settings.airport = ap;
  log(`airport: ${ap.icao} ${ap.iata} ${ap.name} (${ap.lat}, ${ap.lon}, ${ap.elev} ft)`);
}

// Accepts a partial settings object from the card; ignores unknown keys and bad values.
async function updateSettings(p) {
  const s = settings;
  for (const k of ['squawk', 'military', 'heli']) if (typeof p[k] === 'boolean') s[k] = p[k];
  for (const k of ['militaryRadius', 'heliRadius', 'cooldownHours']) {
    const v = Number(p[k]);
    if (p[k] !== undefined && Number.isFinite(v) && v > 0 && v <= 500) s[k] = v;
  }
  if (p.quiet && typeof p.quiet === 'object') {
    if (typeof p.quiet.enabled === 'boolean') s.quiet.enabled = p.quiet.enabled;
    for (const k of ['start', 'end']) if (/^\d{1,2}:\d{2}$/.test(p.quiet[k] || '')) s.quiet[k] = p.quiet[k];
  }
  if (Array.isArray(p.watch)) {
    const out = [];
    for (const w of p.watch.slice(0, 20)) {
      const cs = String(typeof w === 'string' ? w : w?.callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!cs || out.some((x) => x.callsign === cs || x.label === cs)) continue;
      const old = s.watch.find((x) => x.callsign === cs || x.label === cs);
      out.push(old || (await resolveCallsign(cs)));
    }
    s.watch = out;
  }
  saveSettings();
  return s;
}

// "AC612" (IATA, as on a ticket) -> "ACA612" (the ADS-B callsign), via adsbdb. Unknown ones are kept as typed.
async function resolveCallsign(cs) {
  const w = { callsign: cs, label: cs, added: Date.now() };
  try {
    const d = await getJson(`https://api.adsbdb.com/v0/callsign/${cs}`, {}, 5000);
    const fr = d?.response?.flightroute;
    if (fr?.callsign_icao) {
      w.callsign = fr.callsign_icao.toUpperCase();
      w.label = fr.callsign_iata && fr.callsign_iata !== w.callsign ? `${w.callsign} (${fr.callsign_iata})` : w.callsign;
      if (fr.airline?.name) w.airline = fr.airline.name;
    }
  } catch (e) {}
  return w;
}

function inQuiet() {
  const q = settings.quiet;
  if (!q.enabled) return false;
  const m = (s) => {
    const [h, mi] = s.split(':').map(Number);
    return h * 60 + mi;
  };
  const d = new Date(), now = d.getHours() * 60 + d.getMinutes(), a = m(q.start), b = m(q.end);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

// ---- aircraft database (military flag, helicopter types) ----------------

const DB = { mil: new Map(), heli: new Map(), loadedAt: 0, types: 0, error: null };

async function loadDb() {
  try {
    const st = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE) : null;
    if (!st || Date.now() - st.mtimeMs > DB_MAX_AGE_MS) {
      log('downloading aircraft database');
      const r = await fetchT(DB_URL, {}, 120_000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(DB_FILE + '.tmp', Buffer.from(await r.arrayBuffer()));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    }
    // ICAO type designator -> class ("H2T" = helicopter, 2 turbine engines), from SkyAware's own copy.
    const types = await getJson(`${PIAWARE}${SKYAWARE}db/aircraft_types/icao_aircraft_types.json`, {}, 15000);
    const heliTypes = new Set(Object.entries(types).filter(([, v]) => (v.desc || '')[0] === 'H').map(([k]) => k));
    const mil = new Map(), heli = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(DB_FILE).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      // icao;reg;type;flags;description;year;owner
      const f = line.split(';');
      const isMil = f[3]?.[0] === '1', isHeli = heliTypes.has(f[2]);
      if (!isMil && !isHeli) continue;
      const rec = { reg: f[1] || '', type: f[2] || '', desc: f[4] || '', owner: f[6] || '' };
      const hex = f[0].toLowerCase();
      if (isMil) mil.set(hex, rec);
      if (isHeli) heli.set(hex, rec);
    }
    Object.assign(DB, { mil, heli, loadedAt: Date.now(), types: heliTypes.size, error: null });
    log(`aircraft database: ${mil.size} military, ${heli.size} helicopters`);
  } catch (e) {
    DB.error = e.message;
    log('aircraft database failed:', e.message);
  }
}

function isMilitary(a) {
  if (DB.mil.has(a.hex)) return true;
  const n = parseInt(a.hex, 16);
  if (MIL_RANGES.some(([lo, hi]) => n >= lo && n <= hi)) return true;
  return MIL_CALLSIGN.test(callsign(a));
}
const isHeli = (a) => a.category === 'A7' || DB.heli.has(a.hex);

// ---- coverage --------------------------------------------------------------

let rx = null; // receiver position
let cov = readJson(COVERAGE_FILE, null) || { allTime: {}, days: {} };
for (const [b] of BANDS) if (!cov.allTime[b]) cov.allTime[b] = Array(BUCKETS).fill(null);
let today = null; // { key, seen: Set } unique aircraft today
const prevPos = new Map(); // hex -> {t, lat, lon}

function dayRec(key) {
  if (!cov.days[key]) {
    cov.days[key] = { aircraft: 0, withPos: 0, msgs: 0, max: null };
    for (const [b] of BANDS) cov.days[key][b] = Array(BUCKETS).fill(0);
  }
  return cov.days[key];
}

function recordCoverage(d, nowMs) {
  const key = dayKey(nowMs);
  if (!today || today.key !== key) {
    const saved = cov.today && cov.today.key === key ? cov.today : null;
    today = { key, seen: new Set(saved?.seen || []), pos: new Set(saved?.pos || []) };
    for (const k of Object.keys(cov.days).sort().slice(0, -KEEP_DAYS)) delete cov.days[k];
  }
  const day = dayRec(key);
  if (last && d.messages >= last.messages) day.msgs += d.messages - last.messages;
  for (const a of d.aircraft) {
    if (a.seen < 60) today.seen.add(a.hex);
    if (a.lat === undefined || a.seen_pos > 3 || !rx) continue;
    const t = d.now - a.seen_pos;
    // Only count a position that's consistent with the previous one (no CPR glitches or bogus MLAT jumps).
    const p = prevPos.get(a.hex);
    prevPos.set(a.hex, { t, lat: a.lat, lon: a.lon });
    if (!p || t - p.t > 60 || t <= p.t) continue;
    const jump = dist(p.lat, p.lon, a.lat, a.lon), maxJump = (Math.max(a.gs || 0, 600) * (t - p.t)) / 3600 * 1.5 + 1;
    if (jump > maxJump) continue;
    const dd = dist(rx.lat, rx.lon, a.lat, a.lon);
    if (dd > 450) continue;
    today.pos.add(a.hex);
    const br = bearing(rx.lat, rx.lon, a.lat, a.lon), bi = Math.floor(br / (360 / BUCKETS)) % BUCKETS;
    const alt = a.alt_baro === 'ground' ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null;
    if (alt === null) continue;
    const band = BANDS.find(([, lo, hi]) => alt >= lo && alt < hi)[0];
    const r = Math.round(dd * 10) / 10;
    if (r > day[band][bi]) day[band][bi] = r;
    const at = cov.allTime[band][bi];
    if (!at || r > at.d) cov.allTime[band][bi] = { d: r, t: Math.round(t), hex: a.hex, flight: callsign(a), alt };
    if (!day.max || r > day.max.d) day.max = { d: r, t: Math.round(t), hex: a.hex, flight: callsign(a), alt, brg: Math.round(br) };
  }
  day.aircraft = today.seen.size;
  day.withPos = today.pos.size;
  for (const [hex, p] of prevPos) if (d.now - p.t > 300) prevPos.delete(hex);
}

function saveCoverage() {
  if (!today) return;
  cov.today = { key: today.key, seen: [...today.seen], pos: [...today.pos] };
  cov.rx = rx;
  writeJson(COVERAGE_FILE, cov);
}

// ---- alerts ---------------------------------------------------------------

let alerts = readJson(ALERTS_FILE, []); // newest last, last 200
const watchState = new Map(); // callsign -> {approach, last:{t, alt, d}}
const squawkSeen = new Map(); // hex -> {code, t, msgs} when the code was first seen

function recentlyAlerted(kind, hex, hours) {
  const since = Date.now() - hours * 3600_000;
  return alerts.some((x) => x.kind === kind && x.hex === hex && x.t >= since);
}

async function photoOf(hex) {
  try {
    const d = await getJson(`https://api.planespotters.net/pub/photos/hex/${hex}`, {}, 5000);
    return d?.photos?.[0]?.thumbnail_large?.src || '';
  } catch (e) {
    return '';
  }
}
async function routeOf(a) {
  const cs = callsign(a);
  if (!cs || a.lat === undefined) return '';
  try {
    const r = await getJson('https://adsb.im/api/0/routeset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: [{ callsign: cs, lat: a.lat, lng: a.lon }] }),
    }, 5000);
    const x = r?.[0];
    return x && x._airport_codes_iata && x._airport_codes_iata !== 'unknown' && x.plausible !== false ? x._airport_codes_iata.replace(/-/g, '→') : '';
  } catch (e) {
    return '';
  }
}
async function describe(a) {
  const rec = DB.mil.get(a.hex) || DB.heli.get(a.hex);
  if (rec) return { type: rec.desc || rec.type, reg: rec.reg, owner: rec.owner };
  try {
    const d = await getJson(`https://api.adsbdb.com/v0/aircraft/${a.hex}`, {}, 5000);
    const x = d?.response?.aircraft;
    if (x) return { type: `${x.manufacturer || ''} ${x.type || ''}`.trim(), reg: x.registration, owner: x.registered_owner };
  } catch (e) {}
  return {};
}
function where(a) {
  if (a.lat === undefined || !rx) return '';
  const d = dist(rx.lat, rx.lon, a.lat, a.lon), b = bearing(rx.lat, rx.lon, a.lat, a.lon);
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} nm ${compass(b)}`;
}

async function send(alert) {
  const rec = { t: Date.now(), ...alert };
  alerts.push(rec);
  alerts = alerts.slice(-200);
  writeJson(ALERTS_FILE, alerts);
  log('alert', alert.kind, alert.tag, alert.title, '|', alert.message);
  if (!HA_WEBHOOK) return rec;
  try {
    const r = await fetchT(HA_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alert) }, 8000);
    rec.sent = r.ok;
    if (!r.ok) log('webhook HTTP', r.status);
  } catch (e) {
    rec.sent = false;
    log('webhook failed:', e.message);
  }
  writeJson(ALERTS_FILE, alerts);
  return rec;
}

async function aircraftAlert(kind, a) {
  const cs = callsign(a);
  const [info, route, image] = await Promise.all([describe(a), routeOf(a), photoOf(a.hex)]);
  const who = [cs || info.reg || a.hex.toUpperCase(), info.type, cs && info.reg && info.reg !== cs ? info.reg : ''].filter(Boolean).join(' · ');
  const op = kind === 'military' ? milOperator(a.hex, cs, info.owner, info.reg) : null;
  const what = kind === 'military' ? `${op ? op.code : 'Military'} ${isHeli(a) ? 'helicopter' : 'aircraft'}` : 'Helicopter';
  if (op && !info.owner) info.owner = op.name;
  return send({
    kind, hex: a.hex, callsign: cs, priority: 'normal', image,
    tag: `adsb-${kind}-${a.hex}`,
    title: `${kind === 'military' ? '🎖️' : '🚁'} ${what} nearby`,
    message: `${who}${info.owner && kind === 'military' ? ` (${info.owner})` : ''}\n${where(a)}, ${fmtAlt(a.alt_baro)}${a.gs ? `, ${Math.round(a.gs)} kt` : ''}${a.track !== undefined ? ` heading ${compass(a.track)}` : ''}${route ? ` · ${route}` : ''}`,
  });
}

async function checkAlerts(d) {
  const s = settings, quiet = inQuiet();
  for (const a of d.aircraft) {
    if (a.seen > 30) continue;
    const pos = a.lat !== undefined && a.seen_pos < 30 && rx;
    const dd = pos ? dist(rx.lat, rx.lon, a.lat, a.lon) : null;

    // Emergency squawks. dump1090 keeps the last squawk it decoded, so a single corrupted Mode S reply can sit there
    // as "7500" for minutes. Confirmed means: the matching ADS-B emergency status, or the same code held for 60 s
    // while 20+ more messages arrived (a real squawk keeps being repeated; a glitch gets overwritten).
    const code = SQUAWKS[a.squawk] ? a.squawk : a.emergency && a.emergency !== 'none' ? a.emergency : null;
    if (code) {
      let q = squawkSeen.get(a.hex);
      if (!q || q.code !== code) squawkSeen.set(a.hex, (q = { code, t: Date.now(), msgs: a.messages || 0 }));
      const adsb = a.emergency && a.emergency !== 'none' && (!SQUAWKS[code] || a.emergency === SQUAWK_EMERGENCY[code]);
      const held = Date.now() - q.t >= 60_000 && (a.messages || 0) - q.msgs >= 20 && a.seen < 10;
      if (s.squawk && (adsb || held) && !recentlyAlerted('squawk', a.hex, 2)) {
        const cs = callsign(a);
        const [info, route, image] = await Promise.all([describe(a), routeOf(a), photoOf(a.hex)]);
        const what = SQUAWKS[a.squawk] ? `Squawk ${a.squawk} · ${SQUAWKS[a.squawk]}` : `Emergency: ${code}`;
        send({
          kind: 'squawk', hex: a.hex, callsign: cs, priority: 'high', image,
          tag: `adsb-squawk-${a.hex}`,
          title: `🚨 ${what}`,
          message: `${[cs || a.hex.toUpperCase(), info.type, info.reg].filter(Boolean).join(' · ')}${route ? ` · ${route}` : ''}\n${pos ? `${where(a)}, ` : ''}${fmtAlt(a.alt_baro)}${a.gs ? `, ${Math.round(a.gs)} kt` : ''}`,
        });
      }
    } else squawkSeen.delete(a.hex);

    if (dd !== null && !quiet) {
      if (s.military && dd <= s.militaryRadius && isMilitary(a) && !recentlyAlerted('military', a.hex, s.cooldownHours)) await aircraftAlert('military', a);
      else if (s.heli && dd <= s.heliRadius && isHeli(a) && !isMilitary(a) && !recentlyAlerted('heli', a.hex, s.cooldownHours)) await aircraftAlert('heli', a);
    }
  }
  await checkWatched(d);
}

// Watched flights: "on approach" (within 20 nm of the airport, below 6,000 ft, not climbing), then "landed"
// (on the ground near it, or down to ~300 ft above it, or lost low and close after the approach alert).
async function checkWatched(d) {
  const s = settings, ap = s.airport;
  if (!ap) return;
  let changed = false;
  for (const w of [...s.watch]) {
    if (Date.now() - w.added > 36 * 3600_000) {
      s.watch = s.watch.filter((x) => x !== w);
      changed = true;
      continue;
    }
    const st = watchState.get(w.callsign) || {};
    watchState.set(w.callsign, st);
    const a = d.aircraft.find((x) => callsign(x) === w.callsign && x.lat !== undefined && x.seen_pos < 30);
    const tag = `adsb-watch-${w.callsign}`;
    if (a) {
      const da = dist(a.lat, a.lon, ap.lat, ap.lon);
      st.last = { t: Date.now(), alt: a.alt_baro, d: da, hex: a.hex };
      const alt = a.alt_baro;
      if (!st.approach && typeof alt === 'number' && da <= 20 && alt < 6000 && vrate(a) <= 0) {
        st.approach = Date.now();
        const mins = a.gs > 60 ? Math.max(1, Math.round((da / a.gs) * 60 + 1)) : null;
        const image = await photoOf(a.hex);
        send({
          kind: 'watch', hex: a.hex, callsign: w.callsign, priority: 'high', image, tag,
          title: `🛬 ${w.label} on approach to ${ap.iata || ap.icao}`,
          message: `${mins ? `Landing in about ${mins} min (≈${hhmm(Date.now() + mins * 60000)})` : 'Landing shortly'} · ${Math.round(da)} nm out, ${fmtAlt(alt)}`,
        });
      }
      const landed = (alt === 'ground' && da <= 5) || (st.approach && typeof alt === 'number' && alt <= ap.elev + 300 && da <= 4);
      if (landed) await landedAlert(w, st, a.hex, tag);
    } else if (st.approach && st.last && Date.now() - st.last.t > 90_000 && st.last.d <= 10 && (st.last.alt === 'ground' || st.last.alt < 3000)) {
      await landedAlert(w, st, st.last.hex, tag); // went below the receiver's horizon on short final
    }
  }
  if (changed) saveSettings();
}

async function landedAlert(w, st, hex, tag) {
  const ap = settings.airport;
  send({
    kind: 'watch', hex, callsign: w.callsign, priority: 'high', tag,
    title: `✅ ${w.label} has landed at ${ap.iata || ap.icao}`,
    message: `Landed at ${ap.name} at ${hhmm(st.last?.t || Date.now())}`,
  });
  settings.watch = settings.watch.filter((x) => x.callsign !== w.callsign);
  watchState.delete(w.callsign);
  saveSettings();
}

// ---- polling ---------------------------------------------------------------

let last = null; // {now, messages}
let current = []; // the latest aircraft.json list, for /api/classes
let lastOk = 0, lastErr = null, acCount = 0, polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!rx) {
      // LAT/LON in .env win; otherwise the position PiAware was set up with.
      const r = env('LAT') && env('LON') ? {} : await getJson(`${PIAWARE}${SKYAWARE}data/receiver.json`);
      rx = { lat: num('LAT', r.lat), lon: num('LON', r.lon) };
      if (!Number.isFinite(rx.lat) || !Number.isFinite(rx.lon)) {
        rx = null;
        throw new Error('receiver position unknown: set LAT and LON in .env');
      }
    }
    const d = await getJson(`${PIAWARE}${SKYAWARE}data/aircraft.json`);
    if (last && d.now <= last.now) return;
    recordCoverage(d, d.now * 1000);
    await checkAlerts(d);
    last = { now: d.now, messages: d.messages };
    lastOk = Date.now();
    lastErr = null;
    acCount = d.aircraft.length;
    current = d.aircraft;
  } catch (e) {
    lastErr = e.message;
  } finally {
    polling = false;
  }
}

// ---- HTTP -----------------------------------------------------------------

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

let piStatus = null, piStatusAt = 0;
async function piawareStatus() {
  if (Date.now() - piStatusAt > 25_000) {
    piStatusAt = Date.now();
    try {
      piStatus = await getJson(`${PIAWARE}/status.json`);
    } catch (e) {
      piStatus = null;
    }
  }
  return piStatus;
}

async function proxy(req, res, url) {
  try {
    const r = await fetchT(PIAWARE + url.pathname + url.search, {}, 8000);
    const h = { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    sendJson(res, { error: e.message }, 502);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === 'GET' && (p.startsWith(SKYAWARE) || p === '/status.json')) return proxy(req, res, url);
    if (p === '/api/status') {
      return sendJson(res, {
        ok: !lastErr && Date.now() - lastOk < 15_000, lastPoll: lastOk, error: lastErr, aircraft: acCount, rx,
        piaware: await piawareStatus(), webhook: !!HA_WEBHOOK, quiet: inQuiet(),
        db: { military: DB.mil.size, helicopters: DB.heli.size, loadedAt: DB.loadedAt, error: DB.error },
      });
    }
    if (p === '/api/coverage') {
      const { today: _t, ...c } = cov;
      return sendJson(res, { ...c, rx, buckets: BUCKETS, bands: BANDS.map(([b, lo, hi]) => ({ band: b, lo: Math.max(lo, 0), hi: hi > 1e8 ? null : hi })) });
    }
    if (p === '/api/settings' && req.method === 'GET') return sendJson(res, settings);
    if (p === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) return sendJson(res, await updateSettings(await body(req)));
    if (p === '/api/watch' && req.method === 'POST') {
      const b = await body(req);
      const cs = String(b.callsign || '').toUpperCase();
      const list = settings.watch.map((w) => w.callsign);
      return sendJson(res, await updateSettings({ watch: b.remove ? list.filter((x) => x !== cs) : [...list, cs] }));
    }
    if (p === '/api/alerts') return sendJson(res, alerts.slice(-100).reverse());
    // Military / helicopter flags for the aircraft in view (the card can't see the aircraft database itself).
    if (p === '/api/classes') {
      const out = {};
      for (const a of current) {
        const mil = isMilitary(a), heli = isHeli(a);
        if (!mil && !heli) continue;
        const rec = DB.mil.get(a.hex) || DB.heli.get(a.hex);
        const op = mil ? milOperator(a.hex, callsign(a), rec?.owner, rec?.reg) : null;
        out[a.hex] = { mil, heli, ...(rec ? { type: rec.type, desc: rec.desc, reg: rec.reg, owner: rec.owner } : {}), ...(op ? { op: op.code, opName: op.name } : {}) };
      }
      return sendJson(res, out);
    }
    if (p === '/api/test-alert' && req.method === 'POST') {
      const rec = await send({ kind: 'test', priority: 'normal', tag: 'adsb-test', title: '✈️ ADS-B alerts are working', message: `Test from adsb-monitor at ${hhmm(Date.now())}.`, image: '' });
      return sendJson(res, rec);
    }
    if (p === '/' || p === '/api') {
      return sendJson(res, { service: 'adsb-monitor', endpoints: ['/api/status', '/api/coverage', '/api/settings', '/api/watch', '/api/alerts', '/api/classes', '/api/test-alert', SKYAWARE, '/status.json'] });
    }
    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => log(`adsb-monitor on :${PORT}, PiAware ${PIAWARE}${SKYAWARE}, webhook ${HA_WEBHOOK ? 'set' : 'NOT set'}`));
setInterval(poll, POLL_MS);
poll();
setInterval(saveCoverage, SAVE_MS);
loadDb();
loadAirport();
setInterval(loadDb, 86400_000); // re-downloads when the file is a week old
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveCoverage();
    process.exit(0);
  });
}
