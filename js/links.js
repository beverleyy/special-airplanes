import { escapeHtml, normReg } from "./format.js";

export const fr24AircraftUrl = reg => `https://www.flightradar24.com/data/aircraft/${encodeURIComponent(reg.toLowerCase())}`;
export const flightAwareUrl = reg => `https://www.flightaware.com/live/flight/${encodeURIComponent(normReg(reg))}`;
export const photosUrl = reg => `https://www.planespotters.net/search?q=${encodeURIComponent(reg)}`;
export const LIVERY_DATABASE_URL = "https://airportwebcams.net/special-liveries/";

export function externalLink(href, text, className = "") {
  const cls = className ? ` class="${className}"` : "";
  return `<a${cls} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}
