# Livery Watch

Which special-livery aircraft will be at an airport in the next 24 hours, and what's happening with them right now. Built for watching planespotting livestreams: open it next to an SFO stream and you know when the Pikachu Jet is about to show up on runway 28.

![Livery Watch showing special liveries at SFO](screenshot.png)

**[Try the demo](https://YOUR-USERNAME.github.io/livery-watch/)** (a recorded moment at SFO)

## What it does

- Reads an airport's arrivals and departures for the next 24 hours and picks out aircraft in special liveries: retro and heritage schemes, sports teams, Pokémon jets, alliance colors, and more.
- Pairs each aircraft's arrival with its next departure, so you can see how long it's on the ground.
- Splits results into **Now** (on the ground, moving, or due within 30 minutes) and **Later**.
- For aircraft moving around right now, shows a plain status: on approach, landing, taxiing to the gate, waiting to depart, taking off.
- Filters by arrivals or departures and by aircraft type.
- Looks up a special livery by tail number and shows that aircraft's recent and upcoming flights at every airport. Tails that aren't special liveries get quick links to Flightradar24 and FlightAware instead.

## Run it with live data

Needs Python 3.9 or newer. No packages to install.

```
python3 -m livery_watch
```

It opens `http://localhost:8024`. On startup it downloads the latest special livery database and saves it to `livery_watch_data.json`, which is git-ignored and stays on your machine.

| Option | What it does |
| --- | --- |
| `--host 0.0.0.0` | Listen on your network, e.g. to use it from your phone |
| `--port 9000` | Use a different port |
| `--no-browser` | Don't open a browser window |
| `--source URL` | Also import liveries from another page with a livery table (repeatable) |
| `--snapshot SFO` | Record `demo-data.json` for the demo, then exit |
| `--verbose` | Log every request |

### Use it from your phone

- **On your home Wi-Fi:** run `python3 -m livery_watch --host 0.0.0.0 --no-browser`, then open `http://<your-computer's-IP>:8024` on your phone.
- **From anywhere:** run it on an always-on machine (a Raspberry Pi works well) and install [Tailscale](https://tailscale.com) on it and your phone to reach it privately.

## The demo

GitHub Pages only serves static files, so the page first checks for a Livery Watch server. If there isn't one, it switches to demo mode and never contacts a flight or livery data source.

The demo replays a real moment recorded at an airport:

```
python3 -m livery_watch --snapshot SFO
```

This saves `demo-data.json` with only what the demo shows: the special-livery flights on that day's boards, the few livery entries that matched them, live positions for aircraft moving at that moment, those aircraft's schedules, and the board totals. Commit it with the rest of the site. The demo's clock starts at the recorded time, so countdowns and statuses read exactly as they did then. Record at a busy time of day. Without `demo-data.json`, the demo uses a small built-in sample.

To publish, push this repo to GitHub, then go to **Settings → Pages** and deploy from the `main` branch root.

## Project layout

```
index.html              Page markup
css/style.css           Styles
js/
  main.js               Controller: state, events, rendering
  api.js                Data from the Livery Watch server
  demo.js, sample.js    Data for the static demo
  flights.js            Visits, statuses, and filtering
  format.js, clock.js, links.js
  views/                HTML for each part of the page
livery_watch/           Python package
  cli.py                Command line
  server.py             Static files and JSON API
  service.py            Boards, live positions, tail lookups
  fr24.py               Flightradar24 client and parsing
  liveries.py           Livery database import
  store.py              Local data file
  snapshot.py           Demo recordings
tests/                  Python and JavaScript tests
```

## Tests

```
python3 -m unittest discover -s tests -t .
npm test
```

`npm test` only needs Node 20 or newer; there are no dependencies to install.

## Credits and data

- **Special livery data:** the [Special Liveries Database](https://airportwebcams.net/special-liveries/), compiled and maintained by AirportWebcams.net. Livery Watch keeps a local copy for personal use; don't republish it. The demo includes only the few entries that appear in its recording, with credit.
- **Flight schedules, tail assignments, and live positions:** Flightradar24, through the unofficial endpoints behind their website. These are undocumented, can change without notice, and Flightradar24's terms don't permit automated access, so keep it to light personal use. Livery Watch caches results and paces its requests.
