import { sourceHeaders } from "./adsb.js";
import { cached } from "./cache.js";
import { ROUTE_API, ROUTE_BACKOFF_SECONDS, ROUTE_TTL_SECONDS } from "./config.js";
import { normReg } from "./registry.js";

const place = airport => airport && {
  code: airport.iata_code || airport.icao_code || "",
  icao: airport.icao_code || "",
  name: airport.name || "",
  lat: airport.latitude,
  lon: airport.longitude,
};

let pausedUntil = 0;

class RateLimited extends Error {}

/** adsbdb, through the proxy when one is set, so its per-address limit isn't shared with other Workers. */
export function routeUrl(env, callsign) {
  const direct = `${ROUTE_API}/${callsign}`;
  return env.PROXY ? `${env.PROXY.replace(/\/?$/, "/")}${direct}` : direct;
}

/**
 * A callsign's usual route from adsbdb, or null. Registrations used as callsigns have no route.
 * Answers are cached for 12 hours, and a rate limit pauses lookups for a minute rather than retrying.
 */
export async function lookupRoute(callsign, reg, env, fetchImpl = fetch) {
  const cs = (callsign || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cs || cs === normReg(reg) || !/\d/.test(cs)) return null;
  try {
    const route = await cached(`route:${cs}`, ROUTE_TTL_SECONDS, async () => {
      if (Date.now() < pausedUntil) throw new RateLimited();
      const response = await fetchImpl(routeUrl(env, cs), { headers: sourceHeaders(env) });
      if (response.status === 429) {
        pausedUntil = Date.now() + ROUTE_BACKOFF_SECONDS * 1000;
        throw new RateLimited();
      }
      if (response.status === 404) return { none: true };
      if (!response.ok) throw new Error(`adsbdb ${response.status}`);
      const found = (await response.json())?.response?.flightroute;
      if (!found?.origin || !found?.destination) return { none: true };
      return {
        callsign: cs,
        number: found.callsign_iata || cs,
        airline: found.airline?.name || "",
        origin: place(found.origin),
        dest: place(found.destination),
      };
    });
    return route.none ? null : route;
  } catch {
    return null;
  }
}

export function resetRouteBackoff() {
  pausedUntil = 0;
}
