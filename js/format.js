const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => HTML_ESCAPES[c]);

export const normReg = reg => (reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export const plural = (count, one, many) => (count === 1 ? one : many);

/** Split an airport-local "YYYY-MM-DDTHH:MM" into display parts without time zone conversion. */
export function parseLocal(iso) {
  const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return { day: "", date: "", weekday: "", time: "--:--" };
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const opts = { timeZone: "UTC" };
  return {
    day: `${m[1]}-${m[2]}-${m[3]}`,
    date: date.toLocaleDateString(undefined, { ...opts, weekday: "short", month: "short", day: "numeric" }),
    weekday: date.toLocaleDateString(undefined, { ...opts, weekday: "short" }),
    time: `${m[4]}:${m[5]}`,
  };
}

export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const formatAgo = minutes => (minutes < 1 ? "just now" : `${formatDuration(minutes)} ago`);
