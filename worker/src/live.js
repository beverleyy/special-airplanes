import {
  APPROACH_ALLOWANCE_SECONDS, CLIMB_DESCENT_FPM, LOW_ALTITUDE_FT, MIN_ETA_SPEED_KT,
  NEAR_AIRPORT_KM, ON_AIRPORT_KM, RUNWAY_SPEED_KT, TAXI_SPEED_KT,
} from "./config.js";
import { distanceKm } from "./geo.js";

const ARRIVING = new Set(["inbound", "approach", "landing", "taxi-in", "landed"]);
const DEPARTING = new Set(["waiting", "taxi-out", "takeoff", "climbing"]);

export const STATUS_TEXT = {
  inbound: "Inbound",
  approach: "On approach",
  landing: "Landing",
  "taxi-in": "Landed, taxiing to the gate",
  landed: "Landed",
  waiting: "Waiting to depart",
  "taxi-out": "Taxiing to the runway",
  takeoff: "Taking off",
  climbing: "Just took off",
  runway: "On the runway",
  taxiing: "Taxiing",
  ground: "On the ground",
  nearby: "Flying nearby",
};

function phaseFor(ac, distKm, toHere, fromHere) {
  if (ac.onGround) {
    if (distKm > ON_AIRPORT_KM) return null;
    if (ac.speed >= RUNWAY_SPEED_KT) return fromHere ? "takeoff" : toHere ? "landing" : "runway";
    if (ac.speed >= TAXI_SPEED_KT) return fromHere ? "taxi-out" : toHere ? "taxi-in" : "taxiing";
    return fromHere ? "waiting" : toHere ? "landed" : "ground";
  }
  if (distKm <= NEAR_AIRPORT_KM && ac.alt < LOW_ALTITUDE_FT) {
    if (toHere || (!fromHere && ac.vrate < -CLIMB_DESCENT_FPM)) return "approach";
    if (fromHere || ac.vrate > CLIMB_DESCENT_FPM) return "climbing";
    return "nearby";
  }
  return toHere ? "inbound" : null;
}

export function etaSeconds(ac, distKm) {
  const speedKmh = Math.max(ac.speed, MIN_ETA_SPEED_KT) * 1.852;
  return Math.round((distKm / speedKmh) * 3600) + (distKm > 100 ? APPROACH_ALLOWANCE_SECONDS : 0);
}

/** What one special-livery aircraft is doing relative to the airport, or null if it isn't relevant. */
export function classify(ac, airport, route, nowSeconds) {
  if (ac.lat == null || ac.lon == null) return null;
  const distKm = distanceKm(airport.lat, airport.lon, ac.lat, ac.lon);
  const toHere = route?.dest?.code === airport.code;
  const fromHere = route?.origin?.code === airport.code;
  const phase = phaseFor(ac, distKm, toHere, fromHere);
  if (!phase) return null;
  const eta = phase === "inbound" || phase === "approach" ? nowSeconds + etaSeconds(ac, distKm) : null;
  return {
    phase,
    status: STATUS_TEXT[phase],
    dir: ARRIVING.has(phase) ? "arr" : DEPARTING.has(phase) ? "dep" : "",
    distKm: Math.round(distKm),
    etaTs: eta && Math.round(eta / 60) * 60,
  };
}

/** The card data sent to the page for one aircraft. */
export function describe(ac, entry, route, situation) {
  return {
    reg: entry.reg,
    livery: entry.livery,
    airline: entry.airline || route?.airline || ac.owner || "",
    type: entry.type || "",
    model: ac.model || entry.type || "",
    callsign: ac.callsign,
    number: route?.number || ac.callsign,
    origin: route?.origin ? { code: route.origin.code, name: route.origin.name } : null,
    dest: route?.dest ? { code: route.dest.code, name: route.dest.name } : null,
    ...situation,
  };
}
