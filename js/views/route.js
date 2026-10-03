import { escapeHtml } from "../format.js";

const end = (label, place) => `<div class="route__end"><span class="label">${label}</span>`
  + `<div class="airport-code">${escapeHtml(place?.code || "–")}</div>`
  + (place?.name ? `<div class="airport-name">${escapeHtml(place.name)}</div>` : "")
  + "</div>";

/** From → To, with the flight number; or a note when the route is unknown. */
export function routeHtml({ origin, dest, number, callsign }) {
  const flight = `<div class="route__flight"><span class="label">Flight</span>`
    + `<div class="value">${escapeHtml(number || callsign || "–")}</div>`
    + (callsign && callsign !== number ? `<div class="time-note">${escapeHtml(callsign)}</div>` : "")
    + "</div>";
  if (!origin && !dest) {
    return `<div class="route">${flight}<p class="route__unknown">Route unknown for this callsign.</p></div>`;
  }
  return `<div class="route">${end("From", origin)}<span class="route__arrow" aria-hidden="true">→</span>${end("To", dest)}${flight}</div>`;
}
