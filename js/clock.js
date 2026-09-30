let offsetMs = 0;

export const now = () => Date.now() + offsetMs;

export const nowSeconds = () => Math.floor(now() / 1000);

/** Run the app's clock from a past moment, e.g. when replaying a recording. */
export function startClockAt(epochSeconds) {
  offsetMs = epochSeconds * 1000 - Date.now();
}

export function airportTime(airport) {
  const local = new Date(now() + (airport?.offset || 0) * 1000);
  return local.toISOString().slice(11, 16) + (airport?.tz ? ` ${airport.tz}` : "");
}

export function airportToday(airport, epochSeconds = nowSeconds()) {
  return new Date((epochSeconds + (airport?.offset || 0)) * 1000).toISOString().slice(0, 10);
}
