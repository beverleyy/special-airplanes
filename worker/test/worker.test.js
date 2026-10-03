import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { chunkList, fetchFleet, parseAircraft, providerList, tidyModel } from "../src/adsb.js";
import { zoneInfo } from "../src/airports.js";
import { clearMemoryCache } from "../src/cache.js";
import worker from "../src/index.js";
import { classify } from "../src/live.js";
import { clearRegistryMemo } from "../src/registry.js";
import { lookupRoute, resetRouteBackoff } from "../src/routes.js";

const SFO = { code: "SFO", lat: 37.619, lon: -122.375 };
const NOW = 1_800_000_000;
const route = (origin, dest) => ({ origin: { code: origin }, dest: { code: dest } });
const plane = extra => ({ lat: 37.62, lon: -122.38, onGround: false, alt: 0, speed: 0, vrate: 0, track: NaN, ...extra });

test("chunkList keeps each list under the length limit", () => {
  const regs = Array.from({ length: 300 }, (_, i) => `N${String(i).padStart(4, "0")}A`);
  const chunks = chunkList(regs, 100);
  assert.equal(chunks.flat().length, 300);
  for (const chunk of chunks) assert.ok(chunk.join(",").length <= 100);
});

test("parseAircraft reads readsb fields", () => {
  const ac = parseAircraft({ r: "JA894A", flight: "ANA7    ", alt_baro: "ground", gs: 12, t: "B789", desc: "BOEING 787-9", lat: 1, lon: 2 });
  assert.deepEqual([ac.reg, ac.callsign, ac.onGround, ac.alt, ac.model], ["JA894A", "ANA7", true, 0, "Boeing 787-9"]);
  assert.equal(tidyModel("BOEING 737 MAX 9"), "Boeing 737 MAX 9");
  assert.equal(tidyModel("AIRBUS A350-900 XWB"), "Airbus A350-900 XWB");
});

test("classify describes what a spotter would see", () => {
  const at = (extra, r) => classify(plane(extra), SFO, r, NOW)?.phase;
  assert.equal(at({ onGround: true, speed: 15 }, route("SEA", "SFO")), "taxi-in");
  assert.equal(at({ onGround: true, speed: 0 }, route("SFO", "PDX")), "waiting");
  assert.equal(at({ onGround: true, speed: 140 }, route("SFO", "PDX")), "takeoff");
  assert.equal(at({ lat: 37.8, alt: 3000, speed: 160 }, route("NRT", "SFO")), "approach");
  assert.equal(at({ lat: 37.8, alt: 3000, speed: 180, vrate: 2000 }, null), "climbing");
  assert.equal(at({ onGround: true, lat: 37.7 }, route("SFO", "PDX")), undefined);
  const inbound = classify(plane({ lat: 45, lon: -122.4, alt: 37000, speed: 450 }), SFO, route("SEA", "SFO"), NOW);
  assert.equal(inbound.phase, "inbound");
  assert.equal(inbound.dir, "arr");
  assert.ok(inbound.etaTs > NOW + 3600 && inbound.etaTs < NOW + 3 * 3600);
});

test("zoneInfo gives offsets and short names", () => {
  const july = Date.UTC(2026, 6, 1);
  assert.equal(zoneInfo("America/Los_Angeles", july).offset, -7 * 3600);
  assert.equal(zoneInfo("America/Los_Angeles", july).abbr, "PDT");
  assert.equal(zoneInfo("Asia/Singapore", july).offset, 8 * 3600);
});

// Handler, with a fake network and storage

const REGISTRY = {
  updated: "15 September 2026",
  entries: [
    { reg: "N933AK", airline: "Alaska Airlines", type: "737 MAX 9", livery: "Seattle Kraken" },
    { reg: "JA894A", airline: "ANA", type: "787-9", livery: "Pikachu Jet NH" },
  ],
};
const env = {
  ACCESS_CODE: "secret",
  ALLOWED_ORIGINS: "https://beverleyy.github.io",
  PROVIDERS: "https://first.example/v2,https://second.example/v2",
  LIVERIES: { get: async () => REGISTRY },
};
const ROUTES = {
  AS1315: { origin: "SFO", dest: "PDX" },
  ANA8: { origin: "NRT", dest: "SFO" },
};
const airport = code => ({ iata_code: code, icao_code: `K${code}`, name: `${code} Airport`, latitude: 0, longitude: 0 });

let calls;
function fakeNetwork({ firstStatus = 200 } = {}) {
  calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    if (url.includes("adsbdb")) {
      const cs = url.split("/").pop();
      const r = ROUTES[cs];
      if (!r) return new Response("{}", { status: 404 });
      return Response.json({ response: { flightroute: {
        callsign_iata: cs.replace("ANA", "NH"), airline: { name: "Airline" }, origin: airport(r.origin), destination: airport(r.dest) } } });
    }
    if (url.startsWith("https://first.example") && firstStatus !== 200) return new Response("", { status: firstStatus });
    if (url.includes("/point/")) {
      return Response.json({ ac: [
        { r: "N933AK", flight: "AS1315", alt_baro: "ground", gs: 0, lat: 37.62, lon: -122.38, desc: "BOEING 737 MAX 9" },
        { r: "N12345", flight: "UAL1", alt_baro: "ground", gs: 0, lat: 37.62, lon: -122.38 },
      ] });
    }
    if (url.includes("/reg/")) {
      return Response.json({ ac: [
        { r: "JA894A", flight: "ANA8", alt_baro: 38000, gs: 480, track: 60, lat: 33, lon: -150, desc: "BOEING 787-9" },
      ] });
    }
    return new Response("", { status: 500 });
  };
}

const call = (path, headers = { "X-Access-Code": "secret", Origin: "https://beverleyy.github.io" }) =>
  worker.fetch(new Request(`https://worker.example${path}`, { headers }), env);

beforeEach(() => {
  clearMemoryCache();
  clearRegistryMemo();
  resetRouteBackoff();
  fakeNetwork();
});

test("requests need the access code, and allowed sites get CORS headers", async () => {
  const denied = await call("/api/status", { Origin: "https://beverleyy.github.io" });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), "https://beverleyy.github.io");
  const other = await call("/api/status", { "X-Access-Code": "secret", Origin: "https://evil.example" });
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  const status = await (await call("/api/status")).json();
  assert.equal(status.database.count, 2);
});

test("shared access codes work alongside your own, and can be removed", async () => {
  const shared = { ...env, ACCESS_CODES: "united-2026, ana-2026" };
  const as = (code, e) => worker.fetch(new Request("https://worker.example/api/status", { headers: { "X-Access-Code": code } }), e);
  assert.equal((await as("secret", shared)).status, 200);
  assert.equal((await as("ana-2026", shared)).status, 200);
  assert.equal((await as("united-2026", { ...shared, ACCESS_CODES: "ana-2026" })).status, 401);
  assert.equal((await as("", shared)).status, 401);
});

test("/api/live returns only special liveries near the airport", async () => {
  const body = await (await call("/api/live?airport=SFO")).json();
  assert.equal(body.airport.code, "SFO");
  assert.equal(body.counts.nearby, 2);
  assert.deepEqual(body.aircraft.map(a => [a.reg, a.livery, a.phase, a.dir]),
    [["N933AK", "Seattle Kraken", "waiting", "dep"]]);
});

test("/api/inbound finds special liveries flying to the airport", async () => {
  const body = await (await call("/api/inbound?airport=SFO")).json();
  assert.deepEqual(body.aircraft.map(a => [a.reg, a.phase, a.number, a.origin.code]), [["JA894A", "inbound", "NH8", "NRT"]]);
  assert.ok(body.aircraft[0].etaTs > body.fetchedAt);
});

test("a failing data source falls back to the next one", async () => {
  fakeNetwork({ firstStatus: 403 });
  const body = await (await call("/api/live?airport=SFO")).json();
  assert.equal(body.source, "second.example");
});

test("/api/tail reports where a special aircraft is, and rejects others", async () => {
  const special = await (await call("/api/tail?reg=ja-894a")).json();
  assert.equal(special.special, true);
  assert.equal(special.live.dest.code, "SFO");
  const other = await (await call("/api/tail?reg=N12345")).json();
  assert.deepEqual(other, { special: false, reg: "N12345" });
});

test("outbound requests identify the Worker", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers?.["User-Agent"] || "");
    return Response.json({ ac: [] });
  };
  await call("/api/live?airport=SFO");
  assert.ok(seen.length && seen.every(ua => ua.startsWith("LiveryWatch/")));
});

test("the health check shows what a refusing source says", async () => {
  globalThis.fetch = async url => (url.includes("first.example")
    ? new Response("<html>Access denied: contact us for API access</html>", { status: 403, headers: { server: "cloudflare" } })
    : Response.json({ ac: [] }));
  const body = await (await call("/api/health")).json();
  const first = body.sources.find(s => s.source === "first.example");
  assert.equal(first.status, 403);
  assert.match(first.says, /contact us/);
  assert.equal(first.server, "cloudflare");
});

// Sources by hex code, through a proxy

const proxied = {
  PROXY: "https://proxy.example/",
  PROXY_ORIGIN: "https://beverleyy.github.io",
  PROVIDERS: "adsbfi|https://hex.example/api,readsb|https://reg.example/v2",
};

test("providerList routes sources through the proxy", () => {
  const [fi, lol] = providerList(proxied);
  assert.deepEqual([fi.kind, fi.name, fi.url], ["adsbfi", "hex.example", "https://proxy.example/https://hex.example/api"]);
  assert.equal(lol.kind, "readsb");
});

test("fetchFleet looks up by hex where it can, and sends the rest to the next source", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, origin: init.headers.Origin, xrw: init.headers["X-Requested-With"] });
    if (url.includes("/v2/icao/")) return Response.json({ ac: [{ hex: "86ef06", r: "JA894A", alt_baro: 38000, lat: 1, lon: 2 }] });
    return Response.json({ ac: [{ r: "N933AK", alt_baro: "ground", lat: 3, lon: 4 }] });
  };
  const entries = [{ reg: "JA894A", hex: "86EF06" }, { reg: "N933AK" }];
  const result = await fetchFleet(entries, proxied, { fetchImpl: fakeFetch, delayMs: 0 });
  assert.deepEqual(Object.keys(result.aircraft).sort(), ["JA894A", "N933AK"]);
  assert.equal(result.missed, 0);
  assert.match(seen[0].url, /^https:\/\/proxy\.example\/https:\/\/hex\.example\/api\/v2\/icao\/86ef06$/);
  assert.match(seen[1].url, /reg\.example\/v2\/reg\/N933AK$/);
  assert.ok(seen.every(s => s.origin === "https://beverleyy.github.io" && s.xrw === "XMLHttpRequest"));
});

test("fetchFleet moves on when a source refuses, without retrying it", async () => {
  let hexCalls = 0;
  const fakeFetch = async url => {
    if (url.includes("/v2/icao/")) {
      hexCalls++;
      return new Response("", { status: 429 });
    }
    return Response.json({ ac: [{ r: "JA894A", alt_baro: 38000, lat: 1, lon: 2 }] });
  };
  const entries = [{ reg: "JA894A", hex: "86ef06" }];
  const result = await fetchFleet(entries, proxied, { fetchImpl: fakeFetch, delayMs: 0 });
  assert.equal(hexCalls, 1);
  assert.deepEqual(Object.keys(result.aircraft), ["JA894A"]);
  assert.match(result.error, /429/);
});

test("aircraft no source can look up are skipped quietly", async () => {
  const fiOnly = { ...proxied, PROVIDERS: "adsbfi|https://hex.example/api" };
  const fakeFetch = async () => Response.json({ ac: [] });
  const result = await fetchFleet([{ reg: "JA894A", hex: "86ef06" }, { reg: "NEW123" }], fiOnly, { fetchImpl: fakeFetch, delayMs: 0 });
  assert.equal(result.missed, 1);
  assert.equal(result.error, "");
});

test("route lookups go through the proxy and pause after a rate limit", async () => {
  const calls = [];
  const limited = async (url, init) => {
    calls.push({ url, origin: init.headers.Origin });
    return new Response("rate limited for 60 seconds", { status: 429 });
  };
  assert.equal(await lookupRoute("UAL837", "N12345", proxied, limited), null);
  assert.equal(await lookupRoute("UAL1", "N12346", proxied, limited), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.example/https://api.adsbdb.com/v0/callsign/UAL837");
  assert.equal(calls[0].origin, "https://beverleyy.github.io");
});

test("opening the site wakes the proxy in the background", async () => {
  const woken = [];
  globalThis.fetch = async url => {
    woken.push(url);
    return new Response("ok");
  };
  const ctx = { waitUntil: promise => woken.push("waitUntil") && promise };
  const request = new Request("https://worker.example/api/status", { headers: { "X-Access-Code": "secret" } });
  await worker.fetch(request, { ...env, ...proxied }, ctx);
  assert.ok(woken.includes("https://proxy.example/"));
  assert.ok(woken.includes("waitUntil"));
});

test("unknown airports get a clear error", async () => {
  const response = await call("/api/live?airport=ZZZ");
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /ZZZ/);
});
