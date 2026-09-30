import { familyRank, matchesDirection } from "../flights.js";
import { chip, chipRowLabel } from "./common.js";

const DIRECTIONS = [
  ["both", "Arrivals and departures"],
  ["arr", "Arrivals"],
  ["dep", "Departures"],
];

export function directionFilterHtml(visits, direction) {
  return chipRowLabel("Show") + DIRECTIONS.map(([value, label]) => chip({
    label,
    name: "direction",
    value,
    pressed: direction === value,
    count: visits.filter(v => matchesDirection(v, value)).length,
  })).join("");
}

export function typeFilterHtml(visits, { direction, types }) {
  const counts = new Map(types.map(t => [t, 0]));
  for (const visit of visits.filter(v => matchesDirection(v, direction))) {
    counts.set(visit.family, (counts.get(visit.family) || 0) + 1);
  }
  if (!counts.size) return "";
  const families = [...counts.keys()].sort((a, b) => familyRank(a) - familyRank(b));
  return chipRowLabel("Aircraft type")
    + chip({ label: "All", name: "type", value: "", pressed: !types.length })
    + families.map(t => chip({ label: t, name: "type", value: t, pressed: types.includes(t), count: counts.get(t) })).join("");
}
