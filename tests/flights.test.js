import assert from "node:assert/strict";
import { test } from "node:test";

import { startClockAt } from "../js/clock.js";
import { buildVisits, countdown, family, isGone, operatorNote, selectVisits, situation } from "../js/flights.js";
import { formatDuration, parseLocal } from "../js/format.js";

const NOW = 1_800_000_000;
startClockAt(NOW);

const flight = (dir, minutes, extra = {}) => ({
  dir, ts: NOW + minutes * 60, schedTs: NOW + minutes * 60, local: "", schedLocal: "",
  estimated: false, actual: false, reg: "JA894A", model: "Boeing 787-9", number: `${dir}${minutes}`, ...extra,
});
const registry = new Map([["JA894A", { reg: "JA894A", livery: "Pikachu Jet NH", type: "787-9" }]]);

test("family groups aircraft models", () => {
  assert.equal(family("Boeing 737 MAX 8"), "737 MAX");
  assert.equal(family("Boeing 737-8H4"), "737");
  assert.equal(family("Airbus A321-271NX"), "A321");
  assert.equal(family("Embraer E175LR"), "E-Jet");
  assert.equal(family(""), "Unknown");
});

test("buildVisits pairs an arrival with the next departure", () => {
  const visits = buildVisits([flight("arr", 10), flight("dep", 90), flight("arr", 600), flight("dep", 5, { reg: "N1" })], registry);
  assert.equal(visits.length, 2);
  assert.equal(visits[0].arr.ts, NOW + 600);
  assert.equal(visits[0].dep.ts, NOW + 90 * 60);
  assert.equal(visits[1].dep, null);
  assert.equal(visits[0].family, "787");
});

test("the livery database's airline name wins over Flightradar24's", () => {
  const fromDatabase = new Map([["JA894A", { reg: "JA894A", airline: "ANA", livery: "Pikachu Jet NH", type: "787-9" }]]);
  const [visit] = buildVisits([flight("arr", 10, { airlineName: "All Nippon Airways (Pikachu Jet)" })], fromDatabase);
  assert.equal(visit.airlineName, "ANA");
  const [fallback] = buildVisits([flight("arr", 10, { airlineName: "All Nippon Airways" })], registry);
  assert.equal(fallback.airlineName, "All Nippon Airways");
});

test("operatorNote shows the operator only when another airline flies the aircraft", () => {
  const regional = { airline: "AA", operator: "SkyWest Airlines", operatorCode: "OO" };
  assert.equal(operatorNote("American Airlines", regional), "SkyWest Airlines");
  assert.equal(operatorNote("ANA", { airline: "NH", operator: "All Nippon Airways", operatorCode: "NH" }), "");
  assert.equal(operatorNote("airBaltic", { airline: "LH", operator: "airBaltic", operatorCode: "BT" }), "");
  assert.equal(operatorNote("Alaska", { operator: "Alaska Airlines" }), "");
  assert.equal(operatorNote("Alaska", { operator: "Horizon Air" }), "Horizon Air");
  assert.equal(operatorNote("Alaska", {}), "");
});

test("situation uses live positions only for the visit happening now", () => {
  const [soon, later] = buildVisits([flight("arr", 15), flight("dep", 60), flight("dep", 600)], registry);
  const live = new Map([["JA894A", { onGround: false, speed: 160, alt: 4000, distKm: 20 }]]);
  assert.deepEqual(situation(soon, live), { text: "On approach", live: true });
  assert.equal(situation(later, live), null);
});

test("departed aircraft stay visible while still on the ground", () => {
  const [visit] = buildVisits([flight("dep", -20, { actual: true })], registry);
  const taxiing = new Map([["JA894A", { onGround: true, speed: 12, alt: 0, distKm: 1 }]]);
  const gone = new Map([["JA894A", { onGround: false, speed: 400, alt: 20000, distKm: 90 }]]);
  assert.equal(situation(visit, taxiing).text, "Taxiing to the runway");
  assert.equal(isGone(visit, taxiing), false);
  assert.equal(isGone(visit, gone), true);
});

test("selectVisits filters by direction and type", () => {
  const visits = buildVisits([flight("arr", 10), flight("dep", 90)], registry);
  assert.equal(selectVisits(visits, { direction: "dep", types: [] })[0].lead.dir, "dep");
  assert.equal(selectVisits(visits, { direction: "both", types: ["A380"] }).length, 0);
});

test("countdown and formatting", () => {
  assert.equal(countdown(flight("arr", 75)), "Lands in 1 h 15 min");
  assert.equal(countdown(flight("dep", -20, { actual: true })), "Departed 20 min ago");
  assert.equal(formatDuration(60), "1 h");
  assert.equal(parseLocal("2026-09-30T06:04").time, "06:04");
});
