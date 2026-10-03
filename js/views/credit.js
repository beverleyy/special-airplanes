import { escapeHtml } from "../format.js";
import { externalLink, LIVERY_DATABASE_URL } from "../links.js";

const databaseLink = () => externalLink(LIVERY_DATABASE_URL, "Special Liveries Database by AirportWebcams.net");

function recordingDescription({ airport, recordedAt }) {
  const local = new Date((recordedAt + (airport.offset || 0)) * 1000);
  const day = local.toLocaleDateString("en-US",
    { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const time = local.toISOString().slice(11, 16);
  return `a recording of ${escapeHtml(airport.code)} from ${escapeHtml(day)} at ${time} ${escapeHtml(airport.tz || "")}`;
}

export function demoCreditHtml(recording) {
  if (!recording) {
    return `<b>Demo with sample data.</b> Run Livery Watch yourself for live flights at any airport, `
      + `with livery data from the ${databaseLink()}.`;
  }
  return `<b>Demo: ${recordingDescription(recording)}</b>, replayed from that moment. `
    + `Flight data from Flightradar24; livery data from the ${databaseLink()}. `
    + "Run Livery Watch yourself for live flights at any airport.";
}

export function liveCreditHtml(database) {
  const details = database?.count
    ? ` (${database.count.toLocaleString()} aircraft${database.updated ? `, last updated ${escapeHtml(database.updated)}` : ""})`
    : "";
  return `Live positions from ${externalLink("https://adsb.fi", "adsb.fi")}, routes from
    ${externalLink("https://www.adsbdb.com", "adsbdb")}, and livery data from the ${databaseLink()}${details}.`;
}

export function creditHtml(database, registrySize) {
  const details = database.count
    ? `, ${database.count.toLocaleString()} aircraft${database.updated ? `, last updated ${escapeHtml(database.updated)}` : ""}`
    : "";
  const running = database.state === "running";
  const warnings = [];
  if (!running && database.message) warnings.push(database.message);
  if (!running && !registrySize) warnings.push("Couldn't load the livery database. Check your connection, then restart Livery Watch.");
  return `Livery data from the ${databaseLink()}${details}.`
    + (running ? ` <span class="summary__note">Refreshing…</span>` : "")
    + warnings.map(w => `<span class="credit__warn">${escapeHtml(w)}</span>`).join("");
}
