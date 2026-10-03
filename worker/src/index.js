import { fetchFleet, fetchNearby, fetchOne, pointUrls, providerList, sourceHeaders } from "./adsb.js";
import { airportWithZone } from "./airports.js";
import { cached } from "./cache.js";
import {
  ALWAYS_CHECK_WITHIN_KM, FLEET_TTL_SECONDS, REQUEST_HEADERS, HEADING_TOLERANCE_DEG, INBOUND_MAX_KM,
  MAX_ROUTE_LOOKUPS, NEARBY_RADIUS_NM, NEARBY_TTL_SECONDS, NEAR_AIRPORT_KM,
} from "./config.js";
import { angleBetween, bearingDeg, distanceKm } from "./geo.js";
import { checkAccess, corsHeaders, HttpError, json } from "./http.js";
import { classify, describe, etaSeconds } from "./live.js";
import { loadRegistry, normReg } from "./registry.js";
import { lookupRoute, routeUrl } from "./routes.js";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function airportParam(url) {
  const code = (url.searchParams.get("airport") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(code)) throw new HttpError(400, "Enter a 3-letter IATA airport code, like SFO or HND.");
  const airport = airportWithZone(code);
  if (!airport) throw new HttpError(404, `Livery Watch doesn't know an airport with the code ${code}.`);
  return airport;
}

async function requireRegistry(env) {
  const registry = await loadRegistry(env);
  if (!registry.entries.length) {
    throw new HttpError(503, "The livery list hasn't been uploaded yet. Run the Update livery list action on GitHub.");
  }
  return registry;
}

const publicAirport = a => ({ code: a.code, name: a.name, tz: a.tz, offset: a.offset, lat: a.lat, lon: a.lon });

// Routes

/** Wakes a sleeping proxy (Render's free tier naps when idle) while the user picks an airport. */
function wakeProxy(env, ctx) {
  if (env.PROXY && ctx?.waitUntil) {
    ctx.waitUntil(fetch(env.PROXY, { headers: sourceHeaders(env) }).catch(() => {}));
  }
}

async function status(url, env, ctx) {
  wakeProxy(env, ctx);
  const registry = await loadRegistry(env);
  return {
    kind: "live",
    database: { state: "ok", message: "", count: registry.entries.length, updated: registry.updated },
    providers: providerList(env).map(p => p.name),
  };
}

/** Special liveries on the ground, landing, or taking off near the airport right now. */
async function nearby(url, env) {
  const airport = airportParam(url);
  const registry = await requireRegistry(env);
  const now = nowSeconds();
  const { aircraft, provider } = await cached(`nearby:${airport.code}`, NEARBY_TTL_SECONDS,
    () => fetchNearby(airport.lat, airport.lon, NEARBY_RADIUS_NM, env));

  const results = [];
  for (const ac of aircraft) {
    const entry = registry.byReg.get(normReg(ac.reg));
    if (!entry) continue;
    const route = await lookupRoute(ac.callsign, ac.reg, env);
    const situation = classify(ac, airport, route, now);
    if (situation) results.push(describe(ac, entry, route, situation));
  }
  return {
    kind: "live",
    airport: publicAirport(airport),
    fetchedAt: now,
    source: provider,
    counts: { nearby: aircraft.length },
    aircraft: results,
  };
}

/** The whole special-livery fleet that's being tracked anywhere, shared by every airport. */
function fleet(registry, env) {
  return cached("fleet", FLEET_TTL_SECONDS, () => fetchFleet(registry.entries, env));
}

function headedHere(ac, airport) {
  const dist = distanceKm(airport.lat, airport.lon, ac.lat, ac.lon);
  if (dist <= NEAR_AIRPORT_KM || dist > INBOUND_MAX_KM) return null;
  if (dist > ALWAYS_CHECK_WITHIN_KM && Number.isFinite(ac.track)
      && angleBetween(ac.track, bearingDeg(ac.lat, ac.lon, airport.lat, airport.lon)) > HEADING_TOLERANCE_DEG) {
    return null;
  }
  return dist;
}

/** Special liveries in the air anywhere that are flying to the airport, with estimated arrival times. */
async function inbound(url, env) {
  const airport = airportParam(url);
  const registry = await requireRegistry(env);
  const now = nowSeconds();
  const snapshot = await fleet(registry, env);

  const candidates = Object.values(snapshot.aircraft)
    .filter(ac => !ac.onGround && ac.lat != null && ac.callsign)
    .map(ac => ({ ac, dist: headedHere(ac, airport) }))
    .filter(c => c.dist != null)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_ROUTE_LOOKUPS);

  const results = [];
  for (const { ac } of candidates) {
    const route = await lookupRoute(ac.callsign, ac.reg, env);
    if (route?.dest?.code !== airport.code) continue;
    const situation = classify(ac, airport, route, now);
    const entry = registry.byReg.get(normReg(ac.reg));
    if (situation && entry) results.push(describe(ac, entry, route, situation));
  }
  results.sort((a, b) => (a.etaTs || 0) - (b.etaTs || 0));
  return {
    kind: "live",
    airport: publicAirport(airport),
    fetchedAt: now,
    counts: { flying: Object.values(snapshot.aircraft).filter(ac => !ac.onGround).length, checked: candidates.length },
    partial: Boolean(snapshot.error),
    note: snapshot.error ? `Couldn't check ${snapshot.missed} special-livery aircraft (${snapshot.error}).` : "",
    aircraft: results,
  };
}

/** Where one special-livery aircraft is right now. */
async function tail(url, env) {
  const raw = (url.searchParams.get("reg") || "").trim().toUpperCase();
  const reg = raw.replace(/[^A-Z0-9-]/g, "");
  if (!reg) throw new HttpError(400, "Enter a tail number, like JA894A or N933AK.");
  const registry = await requireRegistry(env);
  const entry = registry.byReg.get(normReg(reg));
  if (!entry) return { special: false, reg };

  const { aircraft } = await fetchOne(entry, env);
  const ac = aircraft.find(a => normReg(a.reg) === normReg(entry.reg));
  if (!ac || ac.lat == null) return { special: true, reg: entry.reg, entry, live: null };

  const route = await lookupRoute(ac.callsign, ac.reg, env);
  const dest = route?.dest;
  const toDest = dest?.lat != null ? distanceKm(ac.lat, ac.lon, dest.lat, dest.lon) : null;
  const now = nowSeconds();
  const etaTs = !ac.onGround && toDest != null ? Math.round((now + etaSeconds(ac, toDest)) / 60) * 60 : null;
  const destZone = dest?.code ? airportWithZone(dest.code) : null;
  return {
    special: true,
    reg: entry.reg,
    entry,
    live: {
      onGround: ac.onGround,
      model: ac.model,
      callsign: ac.callsign,
      number: route?.number || ac.callsign,
      airline: route?.airline || ac.owner || "",
      origin: route?.origin ? { code: route.origin.code, name: route.origin.name } : null,
      dest: dest ? { code: dest.code, name: dest.name } : null,
      distToDestKm: toDest != null ? Math.round(toDest) : null,
      etaTs,
      destZone: destZone ? { tz: destZone.tz, offset: destZone.offset } : null,
    },
  };
}

function aircraftCount(body) {
  try {
    const data = JSON.parse(body);
    const list = data.ac ?? data.aircraft ?? data.states;
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

async function probe(url, headers = REQUEST_HEADERS, name = new URL(url).hostname) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers });
    const body = await response.text();
    return {
      source: name,
      status: response.status,
      ms: Date.now() - started,
      server: response.headers.get("server") || "",
      ...(response.ok
        ? { aircraft: aircraftCount(body) }
        : { says: body.replace(/\s+/g, " ").trim().slice(0, 200) }),
    };
  } catch (error) {
    return { source: name, status: "unreachable", ms: Date.now() - started, says: String(error.message || error) };
  }
}

/** Which data sources answer from Cloudflare right now, and what they say when they refuse. */
async function health(env) {
  const checks = [];
  for (const { name, url } of pointUrls(env, "37.6189", "-122.375", 5)) {
    checks.push(await probe(url, sourceHeaders(env), name));
  }
  checks.push(await probe(routeUrl(env, "UAL837"), sourceHeaders(env), "api.adsbdb.com"));
  const registry = await loadRegistry(env);
  return {
    registry: registry.entries.length,
    withHex: registry.entries.filter(e => e.hex).length,
    proxy: env.PROXY ? new URL(env.PROXY).hostname : "",
    sources: checks,
  };
}

const ROUTES = {
  "/api/status": status,
  "/api/live": nearby,
  "/api/inbound": inbound,
  "/api/tail": tail,
  "/api/health": (url, env) => health(env),
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];
    if (!route) return json({ error: "Not found." }, request, env, 404);
    try {
      checkAccess(request, env);
      return json(await route(url, env, ctx), request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, request, env, error.status);
      console.error(error);
      return json({ error: error.message || "Something went wrong." }, request, env, 502);
    }
  },
};
