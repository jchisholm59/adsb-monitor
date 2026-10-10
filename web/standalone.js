// Runs the SkyAware card without Home Assistant: the few things it takes from HA, provided here.
//   <ha-card>   a plain card frame        <ha-icon>   the Material Design icons it uses (icons.js)
//   HA's theme colours (light and dark, following the system setting)
//   hass.themes.darkMode (picks the map tiles); no hass.callWS, so the Cesium token is kept in this browser
// The page (index.html) loads this, then the card from /dist/, pointed at this adsb-monitor for everything.
import { ICONS } from "./icons.js";

const THEME = {
  light: {
    "--primary-color": "#03a9f4", "--text-primary-color": "#ffffff", "--primary-text-color": "#212121",
    "--secondary-text-color": "#727272", "--disabled-text-color": "#bdbdbd", "--divider-color": "rgba(0, 0, 0, 0.12)",
    "--card-background-color": "#ffffff", "--secondary-background-color": "#e5e5e5", "--error-color": "#db4437",
    "--warning-color": "#ffa600", "--success-color": "#43a047", "--ha-card-box-shadow": "0 2px 6px rgba(0, 0, 0, 0.12)",
    "--page-background": "#f2f2f2",
  },
  dark: {
    "--primary-color": "#03a9f4", "--text-primary-color": "#ffffff", "--primary-text-color": "#e1e1e1",
    "--secondary-text-color": "#9b9b9b", "--disabled-text-color": "#6f6f6f", "--divider-color": "rgba(225, 225, 225, 0.12)",
    "--card-background-color": "#1c1c1c", "--secondary-background-color": "#282828", "--error-color": "#ef5350",
    "--warning-color": "#ffa600", "--success-color": "#43a047", "--ha-card-box-shadow": "none",
    "--page-background": "#111111",
  },
};

const dark = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = THEME[dark.matches ? "dark" : "light"];
  for (const [k, v] of Object.entries(t)) document.documentElement.style.setProperty(k, v);
  document.documentElement.style.colorScheme = dark.matches ? "dark" : "light";
}
applyTheme();

customElements.define("ha-card", class extends HTMLElement {
  connectedCallback() {
    Object.assign(this.style, {
      display: "block", background: "var(--card-background-color)", color: "var(--primary-text-color)",
      borderRadius: "12px", boxShadow: "var(--ha-card-box-shadow)",
    });
  }
});

customElements.define("ha-icon", class extends HTMLElement {
  static get observedAttributes() { return ["icon"]; }
  connectedCallback() { this._draw(); }
  attributeChangedCallback() { this._draw(); }
  _draw() {
    const d = ICONS[this.getAttribute("icon")] || ICONS["mdi:help-circle-outline"] || "";
    Object.assign(this.style, { display: "inline-flex", verticalAlign: "middle", lineHeight: "0" });
    this.innerHTML = `<svg viewBox="0 0 24 24" style="width:var(--mdc-icon-size,24px);height:var(--mdc-icon-size,24px);fill:currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  }
});

// Mount the card. Settings: anything in the monitor's data/card.json overrides these (title, rings, markers...).
export async function mount(el) {
  // The monitor's base URL: the page's own folder, so it works at / and under HA ingress (/api/hassio_ingress/<token>/).
  const base = new URL(".", location.href).href.replace(/\/$/, "");
  let extra = {};
  try {
    const r = await fetch(base + "/card-config.json", { cache: "no-store" });
    if (r.ok) extra = await r.json();
  } catch (e) {}
  const v = new URL(import.meta.url).searchParams.get("v") || "";
  await import(`${base}/dist/skyaware-card.js${v ? "?v=" + v : ""}`);
  const card = document.createElement("skyaware-card");
  card.setConfig({ urls: [base], monitor: [base], ...extra });
  el.appendChild(card);
  const hass = () => ({ themes: { darkMode: dark.matches }, states: {} });
  card.hass = hass();
  dark.addEventListener("change", () => {
    applyTheme();
    card.hass = hass();
  });
  if (extra.title) document.title = extra.title;
}
