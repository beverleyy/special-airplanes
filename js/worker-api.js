const CODE_KEY = "livery-watch-access-code";
const PREFS_KEY = "livery-watch-prefs";
const DEFAULT_PREFS = { types: [], direction: "both" };

export class AccessCodeError extends Error {}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private browsing can block storage; settings just won't persist.
  }
}

export const saveAccessCode = code => writeStorage(CODE_KEY, code.trim());
export const forgetAccessCode = () => writeStorage(CODE_KEY, null);

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(readStorage(PREFS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Live data from your Cloudflare Worker, using only free sources. */
export function workerSource(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");

  async function request(path) {
    const code = readStorage(CODE_KEY);
    const response = await fetch(`${base}/${path}`, { headers: code ? { "X-Access-Code": code } : {} });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new AccessCodeError(data.error || "This Livery Watch needs an access code.");
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  const query = params => new URLSearchParams(params).toString();

  return {
    kind: "live",
    isDemo: false,
    async summary() {
      const status = await request("api/status");
      return { registry: [], prefs: loadPrefs(), database: status.database };
    },
    importStatus: async () => ({ state: "ok", message: "" }),
    nearby: airport => request(`api/live?${query({ airport })}`),
    inbound: airport => request(`api/inbound?${query({ airport })}`),
    tail: reg => request(`api/tail?${query({ reg })}`),
    savePrefs: async prefs => writeStorage(PREFS_KEY, JSON.stringify(prefs)),
  };
}
