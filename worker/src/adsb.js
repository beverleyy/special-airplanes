import { DEFAULT_PROVIDERS, PROVIDER_DELAY_MS, REG_CHUNK_CHARS, REQUEST_HEADERS } from "./config.js";
import { normReg } from "./registry.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** How each kind of source spells its endpoints. */
const KINDS = {
  // adsb.fi open data: looks aircraft up by hex code
  adsbfi: {
    point: (lat, lon, nm) => `/v3/lat/${lat}/lon/${lon}/dist/${nm}`,
    many: list => `/v2/icao/${list}`,
    key: entry => (entry.hex || "").toLowerCase(),
  },
  // Airplanes.live, ADSB.lol, and other readsb-style APIs: look aircraft up by registration
  readsb: {
    point: (lat, lon, nm) => `/point/${lat}/${lon}/${nm}`,
    many: list => `/reg/${list}`,
    key: entry => entry.reg || "",
  },
};

/** Sources from PROVIDERS ("kind|base url", comma separated), each routed through PROXY when set. */
export function providerList(env) {
  const specs = (env.PROVIDERS || "").split(",").map(s => s.trim()).filter(Boolean);
  const proxy = (env.PROXY || "").trim();
  return (specs.length ? specs : DEFAULT_PROVIDERS).map(spec => {
    const [kind, rawBase] = spec.includes("|") ? spec.split("|") : ["readsb", spec];
    const base = rawBase.trim().replace(/\/$/, "");
    return {
      kind: KINDS[kind.trim()] ? kind.trim() : "readsb",
      name: new URL(base).hostname,
      url: proxy ? `${proxy.replace(/\/?$/, "/")}${base}` : base,
    };
  });
}

/** Headers for source requests. A CORS Anywhere proxy needs an allowed Origin and X-Requested-With. */
export function sourceHeaders(env) {
  if (!env.PROXY) return REQUEST_HEADERS;
  return { ...REQUEST_HEADERS, "Origin": env.PROXY_ORIGIN || "", "X-Requested-With": "XMLHttpRequest" };
}

/** "BOEING 787-9 DREAMLINER" -> "Boeing 787-9 Dreamliner"; codes like MAX, ER, and A350-900 stay as they are. */
export function tidyModel(text) {
  return (text || "").split(/\s+/).filter(Boolean)
    .map(word => (/^[A-Z]{4,}$/.test(word) ? word[0] + word.slice(1).toLowerCase() : word))
    .join(" ");
}

/** One aircraft from a readsb-style feed (all supported sources use this shape). */
export function parseAircraft(ac) {
  const onGround = ac.alt_baro === "ground";
  return {
    hex: (ac.hex || "").toLowerCase(),
    reg: (ac.r || "").trim(),
    callsign: (ac.flight || "").trim(),
    type: ac.t || "",
    model: tidyModel(ac.desc) || ac.t || "",
    owner: ac.ownOp || "",
    lat: ac.lat ?? ac.lastPosition?.lat ?? null,
    lon: ac.lon ?? ac.lastPosition?.lon ?? null,
    onGround,
    alt: onGround ? 0 : Number(ac.alt_baro ?? ac.alt_geom ?? 0) || 0,
    speed: Number(ac.gs ?? 0) || 0,
    track: Number(ac.track ?? ac.true_heading ?? NaN),
    vrate: Number(ac.baro_rate ?? ac.geom_rate ?? 0) || 0,
  };
}

/** Split identifiers into comma lists that fit in a request path. */
export function chunkList(items, maxChars = REG_CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    const added = current.length ? item.length + 1 : item.length;
    if (current.length && length + added > maxChars) {
      chunks.push(current);
      current = [item];
      length = item.length;
    } else {
      current.push(item);
      length += added;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

class SourceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getAircraft(provider, path, env, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${provider.url}${path}`, { headers: sourceHeaders(env) });
  } catch {
    throw new SourceError(`${provider.name} unreachable`, 0);
  }
  if (!response.ok) throw new SourceError(`${provider.name} ${response.status}`, response.status);
  const data = await response.json().catch(() => null);
  const list = data?.ac ?? data?.aircraft;
  if (!Array.isArray(list)) throw new SourceError(`${provider.name} sent no aircraft list`, response.status);
  return list.map(parseAircraft);
}

/** The first source that answers. Sources that can't make this request (say, no hex code) are skipped. */
async function firstAnswer(env, buildPath, fetchImpl) {
  const failures = [];
  let tried = 0;
  for (const provider of providerList(env)) {
    const path = buildPath(provider);
    if (!path) continue;
    tried++;
    try {
      return { aircraft: await getAircraft(provider, path, env, fetchImpl), provider: provider.name };
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (!tried) return { aircraft: [], provider: "" };
  throw new Error(`No live data source answered (${failures.join(", ")}).`);
}

export function fetchNearby(lat, lon, radiusNm, env, fetchImpl = fetch) {
  return firstAnswer(env, p => KINDS[p.kind].point(lat.toFixed(4), lon.toFixed(4), radiusNm), fetchImpl);
}

/** One special-livery aircraft, wherever it is. */
export function fetchOne(entry, env, fetchImpl = fetch) {
  return firstAnswer(env, p => {
    const key = KINDS[p.kind].key(entry);
    return key ? KINDS[p.kind].many(encodeURIComponent(key)) : null;
  }, fetchImpl);
}

/**
 * Every listed aircraft that's being tracked anywhere. Each source looks up the aircraft it can
 * (by hex code or registration) a chunk at a time within its rate limit. A source that refuses
 * is dropped, and whatever it didn't cover goes to the next source.
 */
export async function fetchFleet(entries, env, { fetchImpl = fetch, delayMs = PROVIDER_DELAY_MS } = {}) {
  const found = {};
  const errors = [];
  const covered = new Set();
  let requests = 0;
  for (const provider of providerList(env)) {
    const kind = KINDS[provider.kind];
    const todo = entries.filter(e => !covered.has(normReg(e.reg)) && kind.key(e));
    const regByKey = new Map(todo.map(e => [kind.key(e), normReg(e.reg)]));
    for (const chunk of chunkList([...regByKey.keys()])) {
      if (requests++) await sleep(delayMs);
      try {
        const aircraft = await getAircraft(provider, kind.many(chunk.map(encodeURIComponent).join(",")), env, fetchImpl);
        for (const ac of aircraft) if (ac.reg) found[normReg(ac.reg)] = ac;
        for (const key of chunk) covered.add(regByKey.get(key));
      } catch (error) {
        errors.push(error.message);
        break;
      }
    }
    if (covered.size === entries.length) break;
  }
  return { aircraft: found, missed: entries.length - covered.size, error: errors[0] || "" };
}

/** Radius-search URLs for each source, for the health check. */
export function pointUrls(env, lat, lon, nm) {
  return providerList(env).map(p => ({ name: p.name, url: `${p.url}${KINDS[p.kind].point(lat, lon, nm)}` }));
}
