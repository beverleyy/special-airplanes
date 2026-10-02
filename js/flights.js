import { now } from "./clock.js";
import { formatAgo, formatDuration, normReg } from "./format.js";

const PAIR_WINDOW_SECONDS = 20 * 3600;
const ACTIVE_BEFORE_MIN = 50;
const ACTIVE_AFTER_MIN = 25;
const DEPARTED_ACTIVE_MIN = 45;
const LANDED_GONE_MIN = 60;
const DUE_NOW_MIN = 10;
const NOW_WINDOW_MIN = 30;
const MAX_LIVE_LOOKUPS = 8;
const ON_AIRPORT_KM = 6;
const NEAR_AIRPORT_KM = 40;
const LOW_ALTITUDE_FT = 10000;
const TAXI_SPEED_KT = 3;
const RUNWAY_SPEED_KT = 40;

// Aircraft type families

const FAMILY_RULES = [
  [/A220|CS[13]00|BCS[13]/, "A220"], [/A318/, "A318"], [/A319/, "A319"], [/A320/, "A320"], [/A321/, "A321"],
  [/A300/, "A300"], [/A310/, "A310"], [/A330/, "A330"], [/A340/, "A340"], [/A350/, "A350"], [/A380/, "A380"],
  [/737\s*-?\s*MAX|B3[89]M|B3XM/, "737 MAX"], [/737/, "737"], [/747/, "747"], [/757/, "757"], [/767/, "767"],
  [/777/, "777"], [/787/, "787"], [/717/, "717"],
  [/E-?1[79][05]|EMBRAER\s*(170|175|190|195)|ERJ-?1[79]/, "E-Jet"], [/ERJ|E1[34]5/, "ERJ"],
  [/CRJ/, "CRJ"], [/DASH\s*8|Q400|DHC-?8/, "Dash 8"], [/ATR/, "ATR"],
  [/MD-?11/, "MD-11"], [/MD-?[89]\d/, "MD-80/90"], [/DC-?10/, "DC-10"],
  [/C919/, "C919"], [/ARJ21|C909/, "C909"], [/SUPERJET|SSJ/, "Superjet"],
];
const FAMILY_ORDER = [...new Set(FAMILY_RULES.map(([, name]) => name)), "Other", "Unknown"];

export function family(model) {
  const text = (model || "").toUpperCase();
  const rule = FAMILY_RULES.find(([pattern]) => pattern.test(text));
  if (rule) return rule[1];
  return text ? "Other" : "Unknown";
}

export const familyRank = name => FAMILY_ORDER.indexOf(name);

// Visits

function pairFlights(flights) {
  const sorted = [...flights].sort((a, b) => a.ts - b.ts);
  const used = new Set();
  const pairs = [];
  for (const flight of sorted) {
    if (used.has(flight)) continue;
    used.add(flight);
    if (flight.dir === "dep") {
      pairs.push({ arr: null, dep: flight });
      continue;
    }
    const dep = sorted.find(d => d.dir === "dep" && !used.has(d) && d.ts > flight.ts
      && d.ts - flight.ts <= PAIR_WINDOW_SECONDS);
    if (dep) used.add(dep);
    pairs.push({ arr: flight, dep: dep || null });
  }
  return pairs;
}

/** Special-livery visits: each arrival paired with the same aircraft's next departure. */
export function buildVisits(flights, registry) {
  const byReg = new Map();
  for (const flight of flights) {
    const key = normReg(flight.reg);
    if (!flight.reg || !registry.has(key)) continue;
    if (!byReg.has(key)) byReg.set(key, []);
    byReg.get(key).push(flight);
  }
  return [...byReg].flatMap(([key, list]) => pairFlights(list).map(({ arr, dep }) => {
    const entry = registry.get(key);
    const model = arr?.model || dep?.model || "";
    return {
      key,
      arr,
      dep,
      entry,
      model,
      reg: (arr || dep).reg,
      family: family(model || entry.type),
      livery: arr?.liveryNote || dep?.liveryNote || entry.livery,
      airlineName: entry.airline || arr?.airlineName || dep?.airlineName || (arr || dep).airline || "",
      operatedBy: operatorNote(entry.airline || (arr || dep).airlineName, dep || arr),
    };
  }));
}

export const minutesFromNow = flight => Math.round((flight.ts * 1000 - now()) / 60000);

/** Which part of the visit is happening now: arriving, sitting on the ground, or departing. */
export function phase(visit) {
  if (visit.dep?.actual) return "dep";
  if (visit.arr && !visit.arr.actual) return "arr";
  return "ground";
}

export function nextLeg(visit) {
  if (visit.arr && !visit.arr.actual) return visit.arr;
  if (visit.dep && !visit.dep.actual) return visit.dep;
  return visit.dep || visit.arr;
}

export function isActive(visit) {
  const flight = visit.dep?.actual ? visit.dep : nextLeg(visit);
  const minutes = minutesFromNow(flight);
  return visit.dep?.actual
    ? -minutes <= DEPARTED_ACTIVE_MIN
    : minutes >= -ACTIVE_BEFORE_MIN && minutes <= ACTIVE_AFTER_MIN;
}

/** Registrations worth a live position lookup, closest to now first. */
export function activeRegs(visits) {
  return visits
    .filter(isActive)
    .map(v => ({ reg: v.reg, distance: Math.abs(minutesFromNow(v.dep?.actual ? v.dep : nextLeg(v))) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_LIVE_LOOKUPS)
    .map(x => x.reg);
}

// Operator

const GENERIC_NAME_WORDS = /\b(the|air ?lines?|airways|aviation|group|inc|ltd|co)\b/g;
const simplifyName = name => (name || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
  .replace(GENERIC_NAME_WORDS, " ").replace(/\s+/g, " ").trim();

function sameAirline(a, b) {
  const x = simplifyName(a);
  const y = simplifyName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** The operator's name when another airline flies the aircraft, e.g. SkyWest for American Eagle; else "". */
export function operatorNote(airlineName, flight) {
  if (!flight?.operator) return "";
  if (flight.operatorCode && flight.airline && flight.operatorCode === flight.airline) return "";
  return sameAirline(flight.operator, airlineName) ? "" : flight.operator;
}

// Status

function liveSituation(visit, position) {
  const current = phase(visit);
  const speed = position.speed || 0;
  const here = position.distKm == null ? null : position.distKm < ON_AIRPORT_KM;

  if (position.onGround) {
    if (here === false) return current === "dep" ? { text: "Departed", gone: true } : null;
    if (speed >= RUNWAY_SPEED_KT) return { text: current === "arr" ? "Landing" : "Taking off", live: true };
    if (speed >= TAXI_SPEED_KT) {
      const text = { dep: "Taxiing to the runway", arr: "Landed, taxiing to the gate", ground: "Taxiing" }[current];
      return { text, live: true };
    }
    return { text: { dep: "Waiting to depart", arr: "Landed", ground: "At the gate" }[current], live: true };
  }

  const near = position.distKm != null && position.distKm < NEAR_AIRPORT_KM && (position.alt || 0) < LOW_ALTITUDE_FT;
  if (current === "arr") return { text: near ? "On approach" : "En route", live: true };
  return near ? { text: "Just took off", live: true } : { text: "Departed", gone: true };
}

/** What a spotter would see right now, or null when nothing is happening yet. */
export function situation(visit, live) {
  const position = isActive(visit) ? live.get(visit.key) : null;
  if (position) return liveSituation(visit, position);
  const current = phase(visit);
  if (current === "ground" && visit.arr?.actual) return { text: "On the ground" };
  if (current === "dep") return { text: "Departed, may still be taxiing" };
  return null;
}

export function isGone(visit, live) {
  if (situation(visit, live)?.gone) return true;
  if (isActive(visit) && live.has(visit.key)) return false;
  if (visit.dep?.actual && -minutesFromNow(visit.dep) > DEPARTED_ACTIVE_MIN) return true;
  return !visit.dep && !!visit.arr?.actual && -minutesFromNow(visit.arr) > LANDED_GONE_MIN;
}

export function countdown(flight) {
  const minutes = minutesFromNow(flight);
  if (flight.actual) return `${flight.dir === "arr" ? "Landed" : "Departed"} ${formatAgo(-minutes)}`;
  if (minutes > 0) return `${flight.dir === "arr" ? "Lands" : "Departs"} in ${formatDuration(minutes)}`;
  if (minutes > -DUE_NOW_MIN) return flight.dir === "arr" ? "Due to land now" : "Due to depart now";
  return "Running late, no update yet";
}

// Selection

export const matchesDirection = (visit, direction) =>
  direction === "both" || (direction === "arr" ? !!visit.arr : !!visit.dep);

function leadFlight(visit, direction) {
  if (direction === "arr") return visit.arr;
  if (direction === "dep") return visit.dep;
  return nextLeg(visit);
}

/** Visits that pass the filters, each with the flight that leads its card, soonest first. */
export function selectVisits(visits, { direction, types }) {
  return visits
    .filter(v => matchesDirection(v, direction) && (!types.length || types.includes(v.family)))
    .map(v => ({ ...v, lead: leadFlight(v, direction) }))
    .sort((a, b) => a.lead.ts - b.lead.ts);
}

export function splitNowAndLater(shown, live) {
  const isNow = v => !!situation(v, live) || Math.abs(minutesFromNow(v.lead)) <= NOW_WINDOW_MIN;
  return { now: shown.filter(isNow), later: shown.filter(v => !isNow(v)) };
}
