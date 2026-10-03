async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const query = params => new URLSearchParams(params).toString();

/** Data from a running Livery Watch server. */
export const serverSource = {
  kind: "scheduled",
  isDemo: false,
  summary: () => request("api/data"),
  importStatus: () => request("api/import-status"),
  board: (airport, { fresh = false } = {}) => request(`api/flights?${query({ airport, ...(fresh && { fresh: 1 }) })}`),
  live: (airport, regs) => request(`api/live?${query({ airport, regs: regs.join(",") })}`),
  tail: reg => request(`api/tail?${query({ reg })}`),
  savePrefs: prefs => request("api/prefs", prefs),
};
