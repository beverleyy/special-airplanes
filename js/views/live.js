import { nowSeconds } from "../clock.js";
import { escapeHtml, formatDuration, parseLocal, plural } from "../format.js";
import { externalLink, flightAwareUrl, fr24AircraftUrl, photosUrl } from "../links.js";
import { fact } from "./common.js";
import { routeHtml } from "./route.js";

const LIVE_ONLY_NOTE = "Live data only, so special liveries that haven't taken off yet won't appear until they do. "
  + "For the full 24 hours, run Livery Watch in a terminal.";

export const localTime = (ts, offset) => parseLocal(new Date((ts + (offset || 0)) * 1000).toISOString().slice(0, 16));

function inboundNote(state) {
  if (state === "loading") return "Still checking special liveries in the air worldwide…";
  if (state && state !== "done") return `Couldn't check special liveries in the air: ${state}`;
  return "";
}

export function liveSummaryHtml(nearby, inbound, shownCount, inboundState) {
  const { airport } = nearby;
  const flying = inbound ? `, plus ${inbound.counts.flying.toLocaleString()} special-livery aircraft in the air worldwide` : "";
  const notes = [inboundNote(inboundState), inbound?.note, LIVE_ONLY_NOTE].filter(Boolean).map(escapeHtml).join(" ");
  return `<span class="sign sign--location">${escapeHtml(airport.code)}</span>
    <span class="sign sign--direction">${shownCount} special ${plural(shownCount, "livery", "liveries")}</span>
    <span>${nearby.counts.nearby} aircraft near ${escapeHtml(airport.code)} checked${flying}.
      Times are ${escapeHtml(airport.name)} local${airport.tz ? ` (${escapeHtml(airport.tz)})` : ""}.</span>
    <span class="summary__note">${notes}</span>`;
}

export function liveEmptyHtml(nearby, total) {
  if (total) {
    return `<div class="empty"><b>None match these filters.</b> ${total} special
      ${plural(total, "livery is", "liveries are")} around right now; choose Arrivals and departures and All to see ${plural(total, "it", "them")}.</div>`;
  }
  return `<div class="empty"><b>No special liveries near ${escapeHtml(nearby.airport.code)} or on their way right now.</b>
    Check back later, or run Livery Watch in a terminal for the full 24 hours.</div>`;
}

function cardHtml(item, { airport, selectedTail }) {
  const { reg } = item;
  const eta = item.etaTs ? localTime(item.etaTs, airport.offset) : null;
  const minutes = item.etaTs ? Math.max(0, Math.round((item.etaTs - nowSeconds()) / 60)) : 0;
  const way = item.dir === "arr" ? "ARR" : item.dir === "dep" ? "DEP" : "LIVE";
  const selected = item.key === selectedTail;
  const scheduleButton = selected
    ? `<button class="card__schedule-link" type="button" data-action="show-schedule">Details below ↓</button>`
    : "";
  const distance = item.phase === "inbound" ? fact("Distance", `${item.distKm.toLocaleString()} km away`) : "";

  return `<article class="card${selected ? " card--selected" : ""}"${selected ? ` aria-current="true"` : ""}>
    <div class="card__when">
      <div>
        <div class="card__time">${eta ? `~${eta.time}` : "Now"}</div>
        <div class="card__date">${eta ? escapeHtml(eta.date) : "Live"}</div>
        ${eta ? `<div class="card__countdown">${minutes ? `Lands in about ${formatDuration(minutes)}` : "Landing soon"}</div>` : ""}
        <div class="card__now"><span class="card__now-label">Live</span>${escapeHtml(item.status)}</div>
      </div>
      <span class="card__way">${way}</span>
    </div>
    <div class="card__body">
      <div class="card__title-row">
        <h3 class="card__livery">${escapeHtml(item.livery)}</h3>
        ${scheduleButton}
      </div>
      ${routeHtml(item)}
      <div class="facts">
        ${fact("Airline", escapeHtml(item.airline || "–"))}
        ${fact("Aircraft", escapeHtml(item.model || item.type || "–"))}
        ${fact("Tail", `<button class="link-button" type="button" data-tail="${escapeHtml(reg)}"
          title="Show where this aircraft is">${escapeHtml(reg)}</button>`)}
        ${distance}
        ${fact("More", [externalLink(fr24AircraftUrl(reg), "FR24"), externalLink(flightAwareUrl(reg), "FlightAware"),
          externalLink(photosUrl(reg), "Photos")].join(", "))}
      </div>
    </div>
  </article>`;
}

const sectionHtml = (title, items, options) => (items.length
  ? `<h2 class="section-title"><span class="sign sign--location">${title}</span></h2>`
    + items.map(i => cardHtml(i, options)).join("")
  : "");

export function liveResultsHtml({ now, inbound }, airport, { selectedTail = "" } = {}) {
  const options = { airport, selectedTail };
  return sectionHtml("Now", now, options) + sectionHtml("Inbound", inbound, options);
}
