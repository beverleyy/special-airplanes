import { family, matchesDirection } from "./flights.js";
import { normReg } from "./format.js";

/** Nearby and inbound aircraft as one list, each counted once, ready for the filters. */
export function mergeLive(nearby, inbound) {
  const seen = new Set();
  const items = [];
  for (const aircraft of [...(nearby?.aircraft || []), ...(inbound?.aircraft || [])]) {
    const key = normReg(aircraft.reg);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      ...aircraft,
      key,
      family: family(aircraft.model || aircraft.type),
      arr: aircraft.dir !== "dep" ? true : null,
      dep: aircraft.dir !== "arr" ? true : null,
    });
  }
  return items;
}

export const filterLive = (items, { direction, types }) =>
  items.filter(i => matchesDirection(i, direction) && (!types.length || types.includes(i.family)));

export function splitLive(items) {
  const inbound = items.filter(i => i.phase === "inbound").sort((a, b) => (a.etaTs || 0) - (b.etaTs || 0));
  return { now: items.filter(i => i.phase !== "inbound"), inbound };
}
