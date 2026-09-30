import { nowSeconds } from "./clock.js";

const OFFSET = -7 * 3600;
const REGISTRY = [
  { reg: "N933AK", airline: "Alaska Airlines", type: "737 MAX 9", livery: "Seattle Kraken" },
  { reg: "N985AK", airline: "Alaska Airlines", type: "737 MAX 9", livery: "Seattle FIFA World Cup 26 host city" },
  { reg: "JA894A", airline: "ANA", type: "787-9", livery: "Pikachu Jet NH" },
  { reg: "N931WN", airline: "Southwest", type: "737-700", livery: "Lone Star One" },
  { reg: "N915NN", airline: "American", type: "737-800", livery: "TWA heritage" },
];
const SPECIAL = [
  ["arr", -42, "AS330", "Alaska Airlines", "AS", "SEA", "Seattle-Tacoma", "N933AK", "Boeing 737 MAX 9", "actual", 6],
  ["dep", 18, "AS1315", "Alaska Airlines", "AS", "PDX", "Portland", "N933AK", "Boeing 737 MAX 9", "estimated", 7],
  ["arr", 22, "NH7", "ANA", "NH", "NRT", "Tokyo Narita", "JA894A", "Boeing 787-9 Dreamliner", "estimated", 9],
  ["dep", 170, "NH8", "ANA", "NH", "NRT", "Tokyo Narita", "JA894A", "Boeing 787-9 Dreamliner", "estimated", 5],
  ["dep", -12, "AS1981", "Alaska Airlines", "AS", "SEA", "Seattle-Tacoma", "N985AK", "Boeing 737 MAX 9", "actual", 4],
  ["arr", 310, "WN2231", "Southwest Airlines", "WN", "LAS", "Las Vegas", "N931WN", "Boeing 737-700"],
  ["dep", 355, "WN2232", "Southwest Airlines", "WN", "LAS", "Las Vegas", "N931WN", "Boeing 737-700"],
  ["arr", 760, "AA2419", "American Airlines", "AA", "DFW", "Dallas/Fort Worth", "N915NN", "Boeing 737-800"],
];
const LIVE = {
  N933AK: { onGround: true, speed: 0, alt: 0, distKm: 0.8 },
  JA894A: { onGround: false, speed: 170, alt: 5200, distKm: 26 },
  N985AK: { onGround: true, speed: 14, alt: 0, distKm: 1.2 },
};

const localIso = ts => new Date((ts + OFFSET) * 1000).toISOString().slice(0, 16);

function flight(now, [dir, minutes, number, airlineName, airline, other, otherName, reg, model, kind = "scheduled", late = 0]) {
  const ts = now + minutes * 60;
  const schedTs = ts - late * 60;
  return {
    dir, ts, local: localIso(ts), schedTs, schedLocal: localIso(schedTs),
    estimated: kind === "estimated", actual: kind === "actual", diverted: false,
    number, airline, airlineName, other, otherName, reg, model,
  };
}

/** A made-up moment at SFO, in the same shape as a recording from `--snapshot`. */
export function sampleRecording() {
  const now = nowSeconds();
  const flights = SPECIAL.map(row => flight(now, row)).sort((a, b) => a.ts - b.ts);
  return {
    recordedAt: now,
    board: {
      airport: { code: "SFO", name: "San Francisco International", tz: "PDT", offset: OFFSET },
      fetchedAt: now,
      truncated: false,
      counts: { arr: 34, dep: 34, withTail: 59 },
      flights,
    },
    live: LIVE,
    tails: {},
    registry: REGISTRY,
  };
}
