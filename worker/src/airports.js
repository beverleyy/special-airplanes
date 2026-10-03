import { AIRPORTS } from "./airports-data.js";

export function findAirport(code) {
  const row = AIRPORTS[(code || "").toUpperCase()];
  if (!row) return null;
  const [name, lat, lon, tz] = row;
  return { code: code.toUpperCase(), name, lat, lon, tz };
}

/** UTC offset in seconds and short zone name, e.g. { offset: -25200, abbr: "PDT" }. */
export function zoneInfo(tz, epochMs = Date.now()) {
  const date = new Date(Math.floor(epochMs / 1000) * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  const asUtc = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour") % 24, +get("minute"), +get("second"));
  return { offset: Math.round((asUtc - date.getTime()) / 60000) * 60, abbr: get("timeZoneName") || "" };
}

export function airportWithZone(code, epochMs = Date.now()) {
  const airport = findAirport(code);
  if (!airport) return null;
  const { offset, abbr } = zoneInfo(airport.tz, epochMs);
  return { ...airport, offset, tzName: airport.tz, tz: abbr };
}
