// Listen panel for skyaware-card / ships-card: a Pi-SDR receiver (github.com/jchisholm59/Pi-SDR) watching a few
// channels at once (the card's `sdr` option), with a light per channel, Scan, Lock and the squelch.
//   sdr: { url: "http://192.168.1.30:8073", channels: [{ name: "Tower", freq: 118.4 }, { name: "ATIS", freq: 121.0, scan: false }] }
// (`scan: false` = skipped by Scan to begin with; each channel's ⊘ changes that, remembered per browser)
// Pi-SDR's watch mode does the work (all the channels must fit its span, about 6 MHz): it reports which channels are
// active in every spectrum frame, follows the first active one while scanning (list order = priority; `scan: false`
// leaves a channel out, e.g. ATIS, which never stops), and puts the receiver back when listening stops or this page
// goes away. Audio: its WebSocket's 48 kHz PCM ([2][channels][3 bytes][int16...]) on scheduled Web Audio buffers.
// The panel is one element per card, moved between the views (map, cockpit / bridge) so listening carries on.
// A page served over https can't open the ws:// of a plain-http receiver (mixed content).

export class SdrListener {
  // store: a localStorage prefix for this browser's choices (which channels Scan skips)
  constructor(cfg, defMode = "am", store = "sdr") {
    this.url = String(cfg.url || "").replace(/\/+$/, "");
    this.mode = cfg.mode || defMode;
    this.channels = (cfg.channels || []).map((c) => ({
      name: String(c.name || c.freq), hz: Math.round(Number(c.freq) * (Number(c.freq) < 1e4 ? 1e6 : 1)), scan: c.scan !== false,
      area: Array.isArray(c.area) && c.area.length === 4 ? c.area.map(Number) : null,
    })).filter((c) => c.hz > 0);
    this._key = store + ":sdr-skip";
    for (const [hz, scan] of Object.entries(this._load())) {
      const c = this.channels.find((x) => x.hz === Number(hz));
      if (c) c.scan = scan;
    }
    this.on = false;
    this.scan = true;
    this.w = null; // Pi-SDR's watch state: {on, scan, locked, cur, ch: [{name, freq, active}]}
    this.err = "";
    this._subs = new Set();
  }
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  _emit(kind) {
    for (const fn of this._subs) fn(kind);
  }
  get cur() {
    return this.on && this.w?.on ? this.w.cur : -1;
  }
  get channel() {
    return this.channels[this.cur];
  }
  get scanning() {
    return this.on && !!this.w?.scan && !this.w?.locked;
  }
  active(i) {
    return this.on && !!this.w?.on && !!this.w.ch?.[i]?.active;
  }
  // start(i): listen, on channel i and locked to it if given, else scanning
  async start(i) {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume(); // inside the click, so the browser allows sound
    this.on = true;
    this.err = "";
    this.next = 0;
    this.w = null;
    this._first = i;
    // closing the tab (or leaving the page) acts like Stop
    this._onHide ??= () => this.on && this.stop();
    window.addEventListener("pagehide", this._onHide);
    this._connect();
    this._emit("state");
  }
  _connect() {
    let ws;
    try {
      ws = this.ws = new WebSocket(this.url.replace(/^http/, "ws") + "/ws");
    } catch (e) {
      return this._fail(location.protocol === "https:" && this.url.startsWith("http:") ? "an https page can't reach an http receiver" : e.message);
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const i = this._first;
      this._send({ cmd: "spectrum", on: false });
      this._send({ cmd: "audio", on: true });
      this._send({ cmd: "watchStart", mode: this.mode, scan: i == null && this.scan, start: i ?? 0,
        channels: this.channels.map((c) => ({ name: c.name, freq: c.hz, scan: c.scan })) });
      if (i != null) this._send({ cmd: "watchTune", i, lock: true });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return void (new Uint8Array(ev.data, 0, 1)[0] === 2 && this._play(ev.data));
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.type === "watch") {
        // ended by someone else (tuned away in Pi-SDR's own page, a search...): stop listening here too
        if (!m.on && this.w?.on) {
          this.err = m.reason === "taken" ? "another Listen panel (other channels) took the receiver" : "the receiver was retuned elsewhere";
          return void this.stop(false);
        }
        this.w = m;
        this._emit("watch");
      } else if (m.type === "status") {
        const open = m.sq == null || !!m.sqOpen; // no squelch: always open
        if (open !== this.sqOpen) (this.sqOpen = open), this._emit("status");
      } else if (m.type === "state") {
        this.radio = m.state;
        this._emit("state");
      } else if (m.type === "toast" && m.error) {
        this.err = m.msg;
        this._emit("state");
      }
    };
    ws.onerror = () => this._fail("can't reach the receiver at " + this.url);
    ws.onclose = () => {
      if (this.on && this.ws === ws) this._fail("the receiver closed the connection");
    };
  }
  _fail(msg) {
    this.err = msg;
    this.stop(false);
  }
  _send(o) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o));
  }
  // tune(i): that channel, locked (scanning stops on it); not listening yet: start there
  tune(i, lock = true) {
    if (!this.channels[i]) return;
    if (!this.on) return void this.start(i).catch((e) => this._fail(e.message));
    this._send({ cmd: "watchTune", i, lock });
  }
  setScan(on) {
    this.scan = !!on;
    this._send({ cmd: "watchScan", on: this.scan });
  }
  // A channel in or out of Scan (a continuous weather broadcast or ATIS would hold it forever); kept in this browser.
  setSkip(i, scan) {
    const c = this.channels[i];
    if (!c) return;
    c.scan = !!scan;
    const saved = this._load();
    saved[c.hz] = c.scan;
    try {
      localStorage.setItem(this._key, JSON.stringify(saved));
    } catch (e) {}
    this._send({ cmd: "watchSkip", i, scan: c.scan });
    this._emit("state");
  }
  _load() {
    try {
      return JSON.parse(localStorage.getItem(this._key) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  setLock(on) {
    this._send({ cmd: "watchLock", on: !!on });
  }
  // The squelch: Pi-SDR keeps it per mode (air and marine each have their own); also the lights' threshold. 0 = off.
  setSq(db) {
    this._send({ cmd: "set", sq: db > 0 ? db : null });
  }
  stop(release = true) {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (release && ws.readyState === 1) ws.send(JSON.stringify({ cmd: "watchStop" })); // the receiver goes back
      try {
        ws.close();
      } catch (e) {}
    }
    if (this._onHide) window.removeEventListener("pagehide", this._onHide);
    this.on = false;
    this.w = null;
    this.sqOpen = false;
    this._emit("state");
  }
  _play(buf) {
    if (!this.on || !this.ctx) return;
    const ch = new Uint8Array(buf, 1, 1)[0];
    const pcm = new Int16Array(buf.slice(5));
    const n = pcm.length / ch;
    const ab = this.ctx.createBuffer(ch, n, 48000);
    for (let c = 0; c < ch; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = pcm[i * ch + c] / 32768;
    }
    const now = this.ctx.currentTime;
    if (this.next < now + 0.03) this.next = now + 0.15; // underrun (or first): rebuild a small cushion
    if (this.next > now + 0.6) return; // too far ahead (clock drift): drop this chunk to catch up
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gain);
    src.start(this.next);
    this.next += ab.duration;
  }
  destroy() {
    if (this.on) this.stop();
    this._subs.clear();
    this.ctx?.close().catch(() => {});
  }
}

const PANEL_STYLE = `
  .sdrp { position: absolute; z-index: 3; display: flex; flex-direction: column; gap: 5px; width: 172px; font-size: 12.5px;
    color: #fff; font-variant-numeric: tabular-nums; pointer-events: auto; }
  .sdrp[data-where="map"] { top: 10px; right: 54px; }
  .sdrp[data-where="view"] { top: 54px; right: 92px; }
  .sdrp button { font: inherit; color: inherit; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.35);
    border-radius: 8px; padding: 5px 8px; cursor: pointer; text-align: left; }
  .sdrp button:hover { background: rgba(40,40,40,.75); }
  .sdrp button.on { background: var(--primary-color, #03a9f4); border-color: transparent; }
  .sdrp button.ch.parked { box-shadow: inset 0 0 0 1.5px var(--primary-color, #03a9f4); border-color: transparent; }
  .sdrp .scan.waiting { animation: sdrp-wait 1.8s ease-in-out infinite; }
  @keyframes sdrp-wait { 50% { opacity: .55; } }
  .sdrp .row { display: flex; gap: 5px; }
  .sdrp .row button { flex: 1; text-align: center; }
  .sdrp .listen { font-weight: 600; text-align: center; }
  .sdrp .sql { display: flex; align-items: center; gap: 5px; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.35);
    border-radius: 8px; padding: 3px 7px; }
  .sdrp .sql input { flex: 1; min-width: 0; margin: 0; }
  .sdrp .sql b { font-weight: normal; min-width: 3.1em; text-align: right; }
  .sdrp .sql span { font-size: 11px; opacity: .85; }
  .sdrp i.dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,.25); }
  .sdrp i.dot.lit { background: #7CFC9A; box-shadow: 0 0 6px #7CFC9A; }
  .sdrp .ch { display: flex; align-items: center; gap: 7px; }
  .sdrp .ch span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sdrp .ch small { opacity: .75; }
  .sdrp .ch .skip { flex: none; margin: -3px -4px -3px 0; padding: 1px 4px; border-radius: 6px; opacity: .45; font-size: 12px; }
  .sdrp .ch .skip:hover { opacity: 1; background: rgba(255,255,255,.15); }
  .sdrp .ch.noscan .skip { opacity: 1; color: #ffb74d; }
  .sdrp .ch.noscan span { font-style: italic; opacity: .7; }
  .sdrp .ch.noscan i.dot:not(.lit) { background: transparent; box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.35); }
  .sdrp .ch.off { opacity: .8; }
  .sdrp .err { background: rgba(120,0,0,.7); border-radius: 8px; padding: 4px 7px; font-size: 11px; }
  .sdrp .hint { background: rgba(0,0,0,.7); border: 1px solid rgba(255,255,255,.35); border-radius: 8px; padding: 6px 8px;
    font-size: 11px; line-height: 1.4; }
  .sdrp .hint code { font-size: 10.5px; word-break: break-all; color: #ffd27a; }
  .sdrp .listen:disabled { opacity: .55; cursor: default; }
  .sdrp [hidden] { display: none !important; }
  @media (max-width: 500px) { .sdrp { width: 124px; font-size: 11.5px; } .sdrp .ch small { display: none; } }
`;

// The panel: Listen, then (while listening) Scan / Lock and the squelch, then a button per channel that lights up
// while that channel is active and is highlighted while it's the one playing. Tapping a channel tunes it and locks.
export class SdrPanel {
  constructor(listener) {
    const s = (this.s = listener);
    const el = (this.el = document.createElement("div"));
    el.className = "sdrp";
    el.dataset.where = "map";
    const fmt = (hz) => (hz / 1e6).toFixed(hz % 1e5 ? 3 : 1);
    // A receiver but no channels (e.g. the add-on's sdr_url without sdr_channels): say how to add them.
    if (!s.channels.length) {
      const ex = s.mode === "am" ? "Tower:118.4;Ground:121.9;ATIS:121.0:noscan" : "Ch 16:156.8;Ch 12:156.6";
      el.innerHTML = `<style>${PANEL_STYLE}</style><button class="listen" disabled>🎧 Listen</button>
        <div class="hint">No channels to listen to yet. Add them as <b>sdr_channels</b> in the add-on's Configuration (or
        <b>SDR_CHANNELS</b> in the monitor's .env, or <b>channels</b> in the card's <b>sdr</b> option), name:MHz, e.g.
        <code>${ex}</code></div>`;
      for (const t of ["click", "pointerdown", "pointerup", "wheel", "dblclick"]) el.addEventListener(t, (e) => e.stopPropagation());
      return;
    }
    el.innerHTML = `<style>${PANEL_STYLE}</style>
      <button class="listen" title="Listen on the Pi-SDR receiver (${s.url})"></button>
      <div class="row live"><button class="scan" title="Scan: follow whichever channel is active (top of the list first)">Scan</button>
        <button class="lock" title="Lock: stay on this channel">Lock</button></div>
      <label class="sql live" title="Squelch: how far above the noise a signal must be to be heard and to light its channel (0 = off). The light shows it open. Saved in Pi-SDR for this mode"><i class="dot"></i><span>SQL</span><input type="range" min="0" max="40" step="1"><b></b></label>
      <div class="err" hidden></div>
      ${s.channels.map((c, i) => `<button class="ch" data-i="${i}" title="${c.name} ${fmt(c.hz)} MHz"><i class="dot"></i><span>${c.name}</span><small>${fmt(c.hz)}</small><b class="skip" data-skip="${i}" title="Scan skips this channel when crossed out (tap to change)">⊘</b></button>`).join("")}`;
    const q = (x) => el.querySelector(x);
    this.$ = { listen: q(".listen"), scan: q(".scan"), lock: q(".lock"), sql: q(".sql"), sqIn: q(".sql input"), sqVal: q(".sql b"), err: q(".err"),
      live: el.querySelectorAll(".live"), ch: [...el.querySelectorAll(".ch")] };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      e.stopPropagation(); // not a click on the map underneath
      const sk = e.target.closest("[data-skip]");
      if (sk) return void s.setSkip(Number(sk.dataset.skip), !s.channels[Number(sk.dataset.skip)].scan);
      if (b === this.$.listen) s.on ? s.stop() : s.start().catch((err) => s._fail(err.message));
      else if (b === this.$.scan) s.setScan(!s.scanning);
      else if (b === this.$.lock) s.setLock(!s.w?.locked);
      else if (b.dataset.i != null) s.tune(Number(b.dataset.i));
    });
    for (const t of ["pointerdown", "pointerup", "wheel", "dblclick"]) el.addEventListener(t, (e) => e.stopPropagation()); // no map drag / zoom
    // the slider: shown live while dragging, sent at most 4 times a second and on release
    let last = 0, timer = null;
    const send = () => (clearTimeout(timer), (timer = null), (last = performance.now()), s.setSq(Number(this.$.sqIn.value)));
    this.$.sqIn.addEventListener("input", () => {
      this._drag = true;
      this._sq(Number(this.$.sqIn.value));
      if (performance.now() - last > 250) send();
      else timer ??= setTimeout(send, 250);
    });
    this.$.sqIn.addEventListener("change", () => {
      send();
      this._drag = false;
    });
    this._unsub = s.subscribe((k) => this.render(k));
    this.render();
  }
  _sq(v) {
    this.$.sqIn.value = v;
    this.$.sqVal.textContent = v ? v + " dB" : "off";
  }
  // where: "map" (beside the map's buttons) or "view" (the cockpit / bridge view, clear of its right-hand box)
  mount(parent, where) {
    this.el.dataset.where = where;
    if (this.el.parentNode !== parent) parent.appendChild(this.el);
  }
  render(kind) {
    const s = this.s, $ = this.$;
    $.sql.querySelector(".dot").classList.toggle("lit", s.on && !!s.sqOpen);
    if (kind === "status") return;
    $.listen.textContent = s.on ? "■ Stop" : "🎧 Listen";
    $.listen.classList.toggle("on", s.on);
    for (const x of $.live) x.hidden = !s.on;
    // Scanning with nothing on the air: the Scan button pulses and the channel it's parked on is only outlined
    // (Pi-SDR watches every channel at once, so there's nothing to step through); solid = playing a call, or locked.
    const quiet = s.scanning && !s.channels.some((c, i) => c.scan && s.active(i));
    $.scan.classList.toggle("on", s.scanning);
    $.scan.classList.toggle("waiting", quiet);
    $.scan.title = quiet ? "Scanning: listening to every channel at once, waiting for a call" : "Scan: follow whichever channel is active (top of the list first)";
    $.lock.classList.toggle("on", s.on && !!s.w?.locked);
    $.err.hidden = !s.err;
    $.err.textContent = s.err;
    if (!this._drag && s.radio) this._sq(s.radio.sq ?? 0);
    $.ch.forEach((b, i) => {
      const parked = s.cur === i && s.scanning && !s.active(i);
      b.classList.toggle("on", s.cur === i && !parked);
      b.classList.toggle("parked", parked);
      b.querySelector(".dot").classList.toggle("lit", s.active(i));
      b.classList.toggle("noscan", !s.channels[i].scan);
    });
  }
  destroy() {
    this._unsub?.();
    this.el.remove();
  }
}
