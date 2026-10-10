# adsb-monitor + SkyAware card

**A Home Assistant dashboard for your PiAware / ADS-B receiver, with phone alerts and coverage history.**

Two pieces that work together:

- **`skyaware-card`**: a Home Assistant Lovelace card with seven tabs. A live map with range rings and altitude-coloured
  trails, a sortable aircraft list, a flight page (route, progress, estimated arrival, photo, live data), a
  **cockpit view** (the selected aircraft's view over Google's photorealistic 3D world, banking with the aircraft;
  optional, needs a free Cesium ion token), a coverage polar chart, alert settings, and your original SkyAware page.
- **`adsb-monitor`**: a small always-on Node service (no dependencies) that watches your receiver 24/7. It records
  coverage, sends alerts to your phone through Home Assistant, and proxies SkyAware with CORS so the card also works
  away from home over a VPN.

> [!IMPORTANT]
> **The card alone** (installable from HACS) gives you the Map, Aircraft, Flight and SkyAware tabs, straight from
> your PiAware. **Coverage history, phone alerts, the PiAware status lights and access away from home** need
> **adsb-monitor**, a small background service you run yourself. It needs Node.js 22+ on any always-on Linux machine
> on your network (the PiAware Pi itself works), kept running with pm2 or systemd. HACS can't install it for you;
> see [Install → 1. The monitor](#1-the-monitor).

![Map tab: live aircraft with range rings, altitude-coloured trails and a selected flight](docs/map.png)

![Satellite view: a departure climbing out of Halifax for Ottawa, with the Swissair 111 landmark off the coast](docs/satellite.png)

![Cockpit tab: Delta 113, Rome to Boston, an A330-300 at 36,000 ft coming in over the Nova Scotia coast on Google's photorealistic 3D tiles, with JetBlue 2260 ahead and the HUD's heading tape, ground speed and altitude](docs/cockpit.jpg)

![Chase view: WestJet 668, Calgary to Halifax on a 737 MAX 8, at 2,625 ft and 151 kt on final, with Halifax Stanfield's runways on the horizon](docs/chase.jpg)

![HUD on final: Air Canada Rouge 2064, an A319 from Toronto, 4 nm out on runway 32 at Halifax Stanfield, with the flight path vector on the threshold, ILS-style glideslope and localizer diamonds (130 ft high, 0.14 nm right), speed and altitude tapes, the autopilot's selected altitude, baro setting and vertical speed](docs/hud.jpg)

| Map filter | Jump to aircraft (from the list's 📍) |
|---|---|
| ![Map filter: chosen classes and airlines only, with counts and logos](docs/map-filter.png) | ![The map centred and zoomed on an aircraft picked from the Aircraft list](docs/locate.png) |

| Flight status | Light theme |
|---|---|
| ![Flight tab: route, progress, estimated arrival and live data](docs/flight.png) | ![Map tab in Home Assistant's light theme](docs/map-light.png) |

| Coverage | Aircraft | Alerts |
|---|---|---|
| ![Coverage tab: polar range chart by altitude band](docs/coverage.png) | ![Aircraft tab: sortable list with routes and types](docs/aircraft.png) | ![Alerts tab: what to alert on, flights to watch, recent alerts](docs/alerts.png) |

## Features

### The card
- **Map**: aircraft drawn as jet / light aircraft / helicopter silhouettes, rotated to their track and coloured
  by altitude like SkyAware (MLAT positions outlined in blue). Range rings, callsign and altitude/speed labels, and
  trails pre-filled from SkyAware's history. Drag, wheel, pinch and double-click to zoom; follow a selected aircraft;
  draw its route as a great circle to its airports; overlay your 30-day coverage outline; switch between the plain map and **satellite** imagery. A **filter** button shows
  only chosen classes (e.g. just military and helicopters) and/or chosen airlines among the flights in view
  (Air Canada, WestJet, United…, with logos and counts); a pill at the top says how many are shown and clears it. Dark or light basemap
  follows your HA theme (Esri gray canvas, or Esri satellite imagery; no API key needed).
- **Aircraft**: summary tiles (count, msg/s, nearest, farthest, highest, fastest) and a table sortable by any
  column: flight, class, route, type, registration, squawk, altitude, vertical rate, speed, track, distance, RSSI,
  messages, last seen. Each aircraft gets a class tag, **Commercial, Military, Helicopter, Private, Unclassified or
  Unknown**, and chips with counts filter the list by class. The tag also shows in the map popup and on the Flight
  tab. Tap a row for its Flight page, or its 📍 pin to jump to it on the map (centred, zoomed in, selected).
  - Military comes from the monitor's database (or military address blocks and callsigns without it); helicopter
    from ADS-B category A7 or the database. Military aircraft are tagged with their **service and roundel** where
    it can be told (RCAF, RAF, USAF, USN, USMC, RAAF, GAF, FAF…): from the registered owner, the callsign (HUSK/CFC →
    RCAF, RCH → USAF, CNV → USN…), or the address block and serial format (US `92-3292` → USAF, `170018` → USN). The
    roundel also appears next to the callsign on the map, and phone alerts name the service ("RCAF aircraft nearby").
  - Private: the callsign is a registration (N123AB, CGABC…), or it's a light/small aircraft.
  - Commercial: an airline-style callsign (ACA612), or, with no callsign yet, an airline owner or a large/heavy jet.
- **Flight**: photo, callsign and IATA flight number, airline and logo, type, registration and owner. Origin →
  destination with a progress bar, distance flown and to go, **estimated arrival time**, and flight phase (climbing,
  cruising, descending, on approach). Live altitude, vertical rate, speed, track, distance and bearing from you,
  squawk, autopilot (selected altitude, heading, QNH, modes) and signal. Altitude and speed charts. Links to
  FlightAware, Flightradar24, ADS-B Exchange and Planespotters. A bell button: **Alert me when it lands**.
- **Cockpit**: sit in the selected aircraft. Its view out of the windscreen over Google's photorealistic 3D world
  (CesiumJS, loaded only when you open the tab), driven by your receiver's live data: the camera follows the reported
  track, climbs and descends with the flight path, and **banks in turns** (from the aircraft's reported roll when it
  sends one, else from the turn rate worked out from its changing track, so turns onto base and final bank smoothly). Between reports it flies on at the reported speed and eases onto each new fix,
  so the view never jumps. Other traffic shows as altitude-coloured points with callsign and altitude. A HUD with
  callsign, route, type and registration, a heading tape, ground speed, altitude and vertical speed. Drag to look
  around, wheel to zoom, **Chase view** to follow it from behind (the silhouette banks with it), ◀ ▶ to hop between aircraft. Needs a free
  [Cesium ion](https://ion.cesium.com/) token: paste it into the tab once (it's saved to your Home Assistant profile).
  Wants a decent GPU; fine on desktops and phones.
  A **HUD** style (on by default) draws it like an airliner's head-up display: horizon and pitch ladder rolling with
  the bank, a flight path vector, speed and altitude tapes, the heading, and the autopilot's selected altitude and
  heading, baro setting and modes when the aircraft sends them (most do).
  **Approach mode** switches on by itself when the aircraft is on final to a runway near you: the extended centreline
  and the 3° glidepath appear in the 3D view, and the HUD gets ILS-style glideslope and localizer diamonds (real ILS
  scaling) with the runway, distance to the threshold, and how far high or low and left or right it is. Runway data
  comes from [OurAirports](https://ourairports.com/data/) (free, fetched at most monthly). It's computed from the
  aircraft's reported position, not a real ILS signal.
- **Coverage**: polar chart of the farthest position heard in each 5° of bearing, for three altitude bands, over
  today / 7 days / 30 days / all time, with records and per-day charts.
- **Alerts**: everything below, as switches, plus a test button and the alert log.
- **SkyAware**: your original SkyAware page, embedded.
- Emergency squawks (7500 / 7600 / 7700) show as a red pill in the header and a red ring on the map once confirmed;
  amber with a "?" until then.

### The monitor
- **Phone alerts** (as sticky notifications through Home Assistant):
  - **Emergency squawks**: 7700, 7600 or 7500, or an ADS-B emergency status, at any distance. A squawk must be
    confirmed: either by the matching ADS-B emergency status, or by holding for 60 s while 20+ more messages arrive.
    A single corrupted Mode S reply often decodes as 7500, and dump1090 keeps showing it until a clean one replaces
    it. The card shows unconfirmed ones in amber with a "?" instead of red.
  - **Military aircraft nearby**: uses the military flag in
    [wiedehopf/tar1090-db](https://github.com/wiedehopf/tar1090-db) (downloaded weekly), plus known military ICAO
    address blocks and callsign prefixes.
  - **Helicopters nearby**: ADS-B category A7, or an aircraft type whose ICAO class is a helicopter.
  - **A watched flight landing at your airport**: first "on approach" (within 20 nm, below 6,000 ft, descending)
    with an estimated landing time, then "landed", which replaces it on the phone. Type a ticket-style flight
    number (AC612) or a callsign (ACA612), or tap the bell on the Flight tab. If your receiver loses the plane low
    on short final, which is common, it counts as landed 90 s later.
  - **Every arrival** (off by default; a switch in the Alerts tab): each flight as it **lines up on final** to one of
    your airport's runways, "🛬 BMA801 on final RWY 32 · YHZ" with type, registration, route, distance, altitude and
    estimated landing time, then **"landed"**, which replaces it on the phone. "On final" uses the airport's real
    runways (OurAirports, cached monthly): within 12 nm (adjustable) of a threshold and short of it, tracking within
    20° of the runway, within 1.5 nm of the extended centreline, below 5,000 ft above it and not climbing, so it fires
    when the aircraft has rolled out on final, not while it's still manoeuvring. Watched flights are left to their
    own alerts. Busy airports make a lot of these, so they respect quiet hours.
  - **Overhead**: a military aircraft or helicopter passing within 3 nm alerts again ("RCAF helicopter overhead"),
    even if it already alerted when it was farther out, at most once an hour per aircraft. Not when its first alert
    was already from that close.
  - Alerts include a photo (Planespotters) and route when available. You can set a per-aircraft cooldown (2 h by
    default) and quiet hours; quiet hours (which also cover arrivals) never hold back emergencies or watched flights.
- **Coverage history**: the farthest position per 5° bearing and altitude band, per day (kept 60 days) and all
  time, with the flight that set each record. A position only counts if it agrees with the aircraft's previous one,
  so CPR decoding glitches and MLAT jumps don't inflate your range.
- **Proxy**: `/skyaware/*` and PiAware's `/status.json` with CORS headers, for the card's status lights and for
  use away from home.

## How it fits together

```mermaid
flowchart LR
  P[PiAware / SkyAware<br>aircraft.json] -->|every 2 s| M[adsb-monitor<br>Node, pm2]
  P -->|LAN| C[skyaware-card<br>in Home Assistant]
  M -->|coverage, settings,<br>alert log, proxy| C
  M -->|webhook| H[HA automation<br>ADS-B alerts]
  H -->|sticky notification| Phone
```

## Requirements
- A PiAware feeder, or any **dump1090-fa** with **SkyAware** (it serves `data/aircraft.json` with
  `Access-Control-Allow-Origin: *`). Tested with PiAware / SkyAware 11.1.
- **Home Assistant**, for the card and for notifications (the companion app on your phone).
- For the monitor: **Node.js 22+** on any always-on Linux box (the PiAware Pi itself works), kept running by pm2
  or systemd. Raspberry Pi OS's own `nodejs` package is often older; install 22 from
  [NodeSource](https://github.com/nodesource/distributions) or with nvm. It uses ~150 MB of RAM and little CPU.
- HA served over plain `http` on your LAN. If your HA is `https`, the card can't call `http` addresses (mixed
  content), so put the monitor behind https too.

## Install

### 1. The monitor
```bash
git clone https://github.com/jchisholm59/adsb-monitor.git
cd adsb-monitor
cp .env.example .env
nano .env                         # PIAWARE, AIRPORT, HA_WEBHOOK (see below)
npm i -g pm2                      # if you don't have it
pm2 start ecosystem.config.js && pm2 save
curl http://localhost:7100/api/status
```
It must keep running (it's what records coverage and sends alerts), so use pm2 as above, or a systemd service:
```ini
# /etc/systemd/system/adsb-monitor.service
[Unit]
Description=adsb-monitor
After=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/adsb-monitor
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now adsb-monitor`. Data lives in `data/`. That's settings, coverage and the alert log, plus the
downloaded aircraft database (~8 MB, refreshed weekly) and your airport.

### 2. The card
**With HACS:** HACS → ⋮ → Custom repositories → add `https://github.com/jchisholm59/adsb-monitor`, type
*Dashboard*, then download **SkyAware Card**. HACS adds the resource for you.

**By hand:**
1. Copy `dist/skyaware-card.js` and `dist/skyaware-cockpit.js` to `/config/www/` on Home Assistant (the cockpit file
   is loaded by the card when its Cockpit tab opens; it isn't a resource of its own).
2. Settings → Dashboards → ⋮ → Resources → Add: `/local/skyaware-card.js`, type *JavaScript module*.
   (After updating the file, change it to `/local/skyaware-card.js?v=2`, `?v=3`… so browsers reload it.)

**Then** add a view (a *Panel* view gives the map the whole screen) with:
   ```yaml
   type: custom:skyaware-card
   urls:                              # your PiAware; first that answers is used
     - http://192.168.1.50
     - http://100.64.0.10:7100        # optional: the monitor's proxy over Tailscale/VPN, for away from home
   monitor:                           # adsb-monitor (optional, for Coverage / Alerts)
     - http://192.168.1.20:7100
     - http://100.64.0.10:7100
   cesium_token: eyJ...               # optional: or just paste the token into the Cockpit tab (saved to your HA profile)
   ```
   For the Cockpit tab, create the token with only the `assets:read` scope and restrict its *Allowed URLs* to your
   Home Assistant addresses: anyone who can open the dashboard can read it. CesiumJS (several MB) comes from Cesium's
   CDN and only loads when you open the tab.

### 3. Phone alerts
1. In Home Assistant, create an automation from [`ha-automation.yaml`](ha-automation.yaml). Pick a long random
   webhook ID and put in your phone's notify action (`notify.mobile_app_<your_phone>`).
2. In the monitor's `.env`: `HA_WEBHOOK=http://<your-ha>:8123/api/webhook/<that id>`, then
   `pm2 restart adsb-monitor --update-env`.
3. Optionally add [`alert-dismiss.yaml`](alert-dismiss.yaml) too. The example makes alerts **persistent** on the phone
   (they stay until you tap **Dismiss**; **Open** goes to the dashboard) and sends a plain copy to a Wear OS watch, since
   Android doesn't pass persistent notifications on to the watch. Without that automation the Dismiss button does
   nothing, so drop `persistent` if you don't want it.
4. In the card's **Alerts** tab press **Send a test**.

The webhook is `local_only`, so the monitor must be on the same network as HA. It needs no HA token.

## Configuration

### `.env` (monitor)
| Variable | Default | |
|---|---|---|
| `PIAWARE` | `http://piaware.local` | Your PiAware / dump1090-fa box |
| `SKYAWARE_PATH` | `/skyaware/` | Where SkyAware is served on it |
| `LAT`, `LON` | from PiAware | Receiver position, only if you want to override PiAware's |
| `AIRPORT` | none | ICAO code of your airport for landing alerts, e.g. `KBOS`, `EGLL`. Looked up in [OurAirports](https://ourairports.com/data/) |
| `AIRPORT_NAME`, `AIRPORT_IATA`, `AIRPORT_LAT`, `AIRPORT_LON`, `AIRPORT_ELEV` | from OurAirports | Overrides (e.g. a shorter name for notifications) |
| `HA_WEBHOOK` | none | HA webhook URL. Empty: alerts are only logged |
| `PORT` | `7100` | API / proxy port |
| `MILITARY_RADIUS`, `HELI_RADIUS` | `30`, `10` | Starting alert distances (nm); then set in the card |
| `COOLDOWN_HOURS` | `2` | Starting per-aircraft cooldown; then set in the card |
| `OVERHEAD_RADIUS` | `3` | Starting overhead distance (nm); then set in the card |

### Card options
| Option | Default | |
|---|---|---|
| `urls` | the `monitor` URLs | PiAware base URLs, tried in order |
| `monitor` | none | adsb-monitor base URLs, tried in order |
| `title` | `Planes` | |
| `path` | `/skyaware/` | SkyAware path on PiAware |
| `rings` | `[50, 100, 150, 200]` | Range rings, nm |
| `markers` | `true` | Landmarks on the map (built in: the **Swissair 111** crash site off Peggy's Cove; tap for its story). `false` hides them; a list adds your own: `- {name: ..., lat: ..., lon: ..., sub: ..., note: ...}` |
| `refresh` | `2` | Seconds between polls |
| `trail_minutes` | `30` | |
| `map_height` | fills the screen | px |
| `lat`, `lon` | from PiAware | Receiver position override |
| `lookups` | `true` | `false` turns off the internet lookups (routes, aircraft details, photos) |

## Data sources
All free, keyless and CORS-enabled. Lookups are cached.
- Routes: [adsb.im](https://adsb.im) `routeset`, which checks each route against the aircraft's position. That
  matters: the bigger free route databases are often years out of date.
- Airline, IATA flight number, aircraft type, registration and owner: [adsbdb.com](https://www.adsbdb.com).
- Photos: adsbdb and [Planespotters.net](https://www.planespotters.net) (with photographer credit).
- Military flags and helicopter types: [tar1090-db](https://github.com/wiedehopf/tar1090-db) and SkyAware's own
  ICAO type table.
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Basemap: Esri World Gray Canvas and World Imagery (Esri, Maxar, Earthstar Geographics, HERE, Garmin, © OpenStreetMap contributors).
- Airline logos: FlightAware's public logo images.

**Privacy:** your receiver's position never leaves your network. The card and monitor send only aircraft
identifiers (hex, callsign) and, for route checks, aircraft positions to the services above.

## Notes
- **Arrival times are estimates**: distance to go divided by current ground speed. Approach and holding add a few
  minutes. Scheduled and actual times would need a paid API such as FlightAware AeroAPI.
- The monitor has no web page of its own, only a JSON API:
  | | |
  |---|---|
  | `GET /api/status` | health, receiver position, PiAware status, webhook set, database counts |
  | `GET /api/coverage` | per-day and all-time farthest range per 5° and altitude band |
  | `GET / PUT /api/settings` | alert settings (partial updates) |
  | `POST /api/watch` | `{"callsign": "ACA612"}` to watch, add `"remove": true` to stop |
  | `GET /api/alerts` | last 100 alerts |
  | `GET /api/classes` | military / helicopter flags (and type, registration) for the aircraft in view |
  | `POST /api/test-alert` | send a test notification |
- Anyone who can reach the monitor's port can change its alert settings. Keep it on your LAN or VPN.

## License
MIT
