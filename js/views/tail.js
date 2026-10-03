import { nowSeconds } from "../clock.js";
import { operatorNote } from "../flights.js";
import { escapeHtml, formatDuration, parseLocal } from "../format.js";
import { externalLink, flightAwareUrl, fr24AircraftUrl, photosUrl } from "../links.js";
import { fact } from "./common.js";
import { localTime } from "./live.js";
import { routeHtml } from "./route.js";

const SCHEDULE_CHANGE_SECONDS = 300;
const KIND_LABELS = { actual: "Actual", estimated: "Expected", scheduled: "Scheduled" };
const STATE_MODIFIERS = {
  "Expected": "expected", "Delayed": "delayed", "Canceled": "canceled", "Diverted": "diverted",
  "In the air": "in-air", "Landed": "landed", "Departed": "departed",
};

const closeButton = `<button class="btn btn--small btn--inverse" type="button" data-action="close-tail">Close</button>`;

function headHtml(reg, title) {
  return `<div class="tail-card__head">
    <div><div class="tail-card__reg">Tail ${escapeHtml(reg)}</div><h2 class="tail-card__livery">${escapeHtml(title)}</h2></div>
    ${closeButton}
  </div>`;
}

function timeCell(time) {
  if (!time?.ts) return `<span class="muted">–</span>`;
  const notes = [KIND_LABELS[time.kind]];
  if (time.schedLocal && Math.abs(time.ts - time.schedTs) >= SCHEDULE_CHANGE_SECONDS) {
    notes.push(`sched ${parseLocal(time.schedLocal).time}`);
  }
  const zone = time.tz ? ` <small>${escapeHtml(time.tz)}</small>` : "";
  return `<div class="time">${parseLocal(time.local).time}${zone}</div>`
    + `<div class="time-note">${escapeHtml(notes.filter(Boolean).join(", "))}</div>`;
}

const placeCell = place => `<div class="airport-code">${escapeHtml(place.code || "–")}</div>`
  + (place.name ? `<div class="airport-name">${escapeHtml(place.name)}</div>` : "");

function rowHtml(flight, airportCode) {
  const date = parseLocal((flight.dep?.ts ? flight.dep : flight.arr).local).date;
  const here = airportCode && (flight.origin.code === airportCode || flight.dest.code === airportCode);
  const modifier = STATE_MODIFIERS[flight.state];
  return `<tr${here ? ` class="schedule__row--here"` : ""}>
    <td data-label="Date"><div class="value">${escapeHtml(date)}</div></td>
    <td data-label="Flight"><div class="value">${escapeHtml(flight.number || "–")}</div></td>
    <td data-label="From">${placeCell(flight.origin)}</td>
    <td data-label="To">${placeCell(flight.dest)}</td>
    <td data-label="Departs">${timeCell(flight.dep)}</td>
    <td data-label="Arrives">${timeCell(flight.arr)}</td>
    <td data-label="Status"><span class="state${modifier ? ` state--${modifier}` : ""}">${escapeHtml(flight.state)}</span></td>
  </tr>`;
}

function notSpecialHtml(reg, isDemo) {
  const message = isDemo
    ? `The demo only knows the special liveries in its recording, and ${escapeHtml(reg)} isn't one of them. `
      + "Run Livery Watch yourself to check the full database, or look it up here:"
    : `${escapeHtml(reg)} isn't in the special livery database, so Livery Watch doesn't track it. You can still look it up here:`;
  return `<section class="tail-card">
    ${headHtml(reg, isDemo ? "Not in this demo" : "Not a special livery")}
    <div class="tail-card__body">
      <p class="tail-card__message">${message}</p>
      <div class="tail-card__actions">
        ${externalLink(fr24AircraftUrl(reg), "Search Flightradar24", "btn btn--small")}
        ${externalLink(flightAwareUrl(reg), "Search FlightAware", "btn btn--small")}
      </div>
    </div>
  </section>`;
}

function scheduleHtml(result, airportCode, isDemo) {
  const { entry, flights } = result;
  if (!flights.length) {
    return `<p class="tail-card__message">No recent or upcoming flights found for ${escapeHtml(entry.reg)}.
      Airlines often assign aircraft to flights only about a day ahead.</p>`;
  }
  const note = isDemo && result.partial
    ? `<p class="tail-card__message summary__note">In the demo, this only includes flights at ${escapeHtml(airportCode)} from the recording.</p>`
    : "";
  return `<table class="schedule">
      <thead><tr><th>Date</th><th>Flight</th><th>From</th><th>To</th><th>Departs</th><th>Arrives</th><th>Status</th></tr></thead>
      <tbody>${flights.map(f => rowHtml(f, airportCode)).join("")}</tbody>
    </table>${note}`;
}

function liveNowHtml(entry, live) {
  if (!live) {
    return `<p class="tail-card__message">${escapeHtml(entry.reg)} isn't being tracked right now. It may be parked with
      its transponder off, or outside receiver coverage.</p>`;
  }
  let arrival = "";
  if (live.etaTs && live.destZone) {
    const at = localTime(live.etaTs, live.destZone.offset);
    const minutes = Math.max(0, Math.round((live.etaTs - nowSeconds()) / 60));
    arrival = fact("Lands", `about ${at.time} ${escapeHtml(live.destZone.tz)}${minutes ? ` (in ${formatDuration(minutes)})` : ""}`);
  }
  return `${routeHtml(live)}
    <div class="facts">
      ${fact("Right now", live.onGround ? "On the ground" : "In the air")}
      ${arrival}
      ${live.distToDestKm != null && !live.onGround ? fact("To go", `${live.distToDestKm.toLocaleString()} km`) : ""}
    </div>`;
}

function liveTailHtml(result) {
  const { entry, live } = result;
  const links = [
    externalLink(fr24AircraftUrl(entry.reg), "FR24"),
    externalLink(flightAwareUrl(entry.reg), "FlightAware"),
    externalLink(photosUrl(entry.reg), "Photos"),
  ].join(", ");
  return `<section class="tail-card">
    ${headHtml(entry.reg, entry.livery)}
    <div class="tail-card__body">
      <div class="facts">
        ${fact("Airline", escapeHtml(entry.airline || live?.airline || "–"))}
        ${fact("Aircraft", escapeHtml(live?.model || entry.type || "–"))}
        ${fact("More", links)}
      </div>
      ${liveNowHtml(entry, live)}
      <p class="tail-card__message summary__note">The live site shows where this aircraft is right now. For its upcoming
        flights, run Livery Watch in a terminal.</p>
    </div>
  </section>`;
}

export function tailHtml(result, { airportCode, isDemo }) {
  if (!result.special) return notSpecialHtml(result.reg, isDemo);
  if ("live" in result) return liveTailHtml(result);
  const { entry, flights } = result;
  const model = flights.find(f => f.model)?.model || entry.type;
  const airline = entry.airline || flights.find(f => f.airlineName)?.airlineName;
  const operatedBy = operatorNote(airline, flights.find(f => f.operator));
  const links = [
    externalLink(fr24AircraftUrl(entry.reg), "FR24"),
    externalLink(flightAwareUrl(entry.reg), "FlightAware"),
    externalLink(photosUrl(entry.reg), "Photos"),
  ].join(", ");
  return `<section class="tail-card">
    ${headHtml(entry.reg, flights.find(f => f.liveryNote)?.liveryNote || entry.livery)}
    <div class="tail-card__body">
      <div class="facts">
        ${fact("Airline", escapeHtml(airline || "–"))}
        ${operatedBy ? fact("Operated by", escapeHtml(operatedBy)) : ""}
        ${fact("Aircraft", escapeHtml(model || "–"))}
        ${fact("More", links)}
      </div>
      ${scheduleHtml(result, airportCode, isDemo)}
    </div>
  </section>`;
}
