import { airportToday } from "../clock.js";
import { countdown, situation } from "../flights.js";
import { escapeHtml, formatDuration, parseLocal, plural } from "../format.js";
import { externalLink, flightAwareUrl, fr24AircraftUrl, photosUrl } from "../links.js";
import { fact } from "./common.js";

const SCHEDULE_CHANGE_SECONDS = 300;

export function summaryHtml(board, shownCount) {
  const { airport, counts } = board;
  const zone = airport.tz ? ` (${escapeHtml(airport.tz)})` : "";
  return `<span class="sign sign--location">${escapeHtml(airport.code)}</span>
    <span class="sign sign--direction">${shownCount} special ${plural(shownCount, "livery", "liveries")}</span>
    <span>${counts.arr} arrivals and ${counts.dep} departures checked, ${counts.withTail} with a tail assigned.
      Times are ${escapeHtml(airport.name || airport.code)} local${zone}.</span>
    ${board.truncated ? `<span class="summary__note">Flightradar24's board ended before 24 hours, so some later flights may be missing.</span>` : ""}`;
}

export function emptyHtml(board, totalVisits) {
  if (totalVisits) {
    const them = plural(totalVisits, "it", "them");
    return `<div class="empty"><b>None match these filters.</b> ${totalVisits} special
      ${plural(totalVisits, "livery is", "liveries are")} due in total; choose Arrivals and departures and All to see ${them}.</div>`;
  }
  const { arr, dep, withTail } = board.counts;
  const hint = withTail < (arr + dep) / 2 ? " Many flights don't have a tail assigned yet, so check back later." : "";
  return `<div class="empty"><b>No special liveries due in the next 24 hours.</b>${hint}</div>`;
}

function legKind(flight) {
  if (flight.dir === "arr") return flight.actual ? "Arrived" : "Arrives";
  return flight.actual ? "Departed" : "Departs";
}

function legNotes(flight) {
  const notes = [flight.actual ? (flight.dir === "arr" ? "Landed" : "Departed") : flight.estimated ? "Expected" : "Scheduled"];
  if (flight.schedLocal && Math.abs(flight.ts - flight.schedTs) >= SCHEDULE_CHANGE_SECONDS) {
    notes.push(`sched ${parseLocal(flight.schedLocal).time}`);
  }
  if (flight.diverted) notes.push("diverted");
  return notes.join(", ");
}

function legRowHtml(flight, today) {
  const when = parseLocal(flight.local);
  const day = when.day !== today ? ` <small>${escapeHtml(when.weekday)}</small>` : "";
  const place = flight.otherName ? `${escapeHtml(flight.otherName)} (${escapeHtml(flight.other)})` : escapeHtml(flight.other);
  return `<div class="legs__kind">${legKind(flight)}</div>
    <div><div class="time">${when.time}${day}</div><div class="time-note">${escapeHtml(legNotes(flight))}</div></div>
    <div class="value legs__flight">${escapeHtml(flight.number)}</div>
    <div class="value legs__place">${place}</div>`;
}

function placeHeading(visit) {
  if (visit.arr && visit.dep) return "From / to";
  return visit.arr ? "From" : "To";
}

function cardHtml(visit, live, today) {
  const { entry, lead, arr, dep, reg } = visit;
  const when = parseLocal(lead.local);
  const status = situation(visit, live);
  const way = arr && dep ? "ARR + DEP" : arr ? "ARR" : "DEP";
  const groundTime = arr && dep ? fact("On the ground", formatDuration(Math.round((dep.ts - arr.ts) / 60))) : "";
  const now = status
    ? `<div class="card__now"><span class="card__now-label">${status.live ? "Live" : "Now"}</span>${escapeHtml(status.text)}</div>`
    : "";

  return `<article class="card">
    <div class="card__when">
      <div>
        <div class="card__time">${when.time}</div>
        <div class="card__date">${escapeHtml(when.date)}</div>
        <div class="card__countdown">${escapeHtml(countdown(lead))}</div>
        ${now}
      </div>
      <span class="card__way">${way}</span>
    </div>
    <div class="card__body">
      <h3 class="card__livery">${escapeHtml(entry.livery)}</h3>
      <div class="legs">
        <div class="label legs__head"></div><div class="label legs__head">Time</div>
        <div class="label legs__head">Flight</div><div class="label legs__head">${placeHeading(visit)}</div>
        ${arr ? legRowHtml(arr, today) : ""}${dep ? legRowHtml(dep, today) : ""}
      </div>
      <div class="facts">
        ${fact("Airline", escapeHtml(visit.airlineName || "–"))}
        ${visit.operatedBy ? fact("Operated by", escapeHtml(visit.operatedBy)) : ""}
        ${fact("Aircraft", escapeHtml(visit.model || entry.type || "–"))}
        ${fact("Tail", `<button class="link-button" type="button" data-tail="${escapeHtml(reg)}"
          title="Show this aircraft's schedule">${escapeHtml(reg)}</button>`)}
        ${groundTime}
        ${fact("More", [externalLink(fr24AircraftUrl(reg), "FR24"), externalLink(flightAwareUrl(reg), "FlightAware"),
          externalLink(photosUrl(reg), "Photos")].join(", "))}
      </div>
    </div>
  </article>`;
}

const sectionHtml = (title, visits, live, today) => (visits.length
  ? `<h2 class="section-title"><span class="sign sign--location">${title}</span></h2>`
    + visits.map(v => cardHtml(v, live, today)).join("")
  : "");

export function resultsHtml({ now, later }, board, live) {
  const today = airportToday(board.airport, board.fetchedAt);
  return sectionHtml("Now", now, live, today) + sectionHtml("Later", later, live, today);
}
