export const DEFAULT_PROVIDERS = ["adsbfi|https://opendata.adsb.fi/api"];
export const ROUTE_API = "https://api.adsbdb.com/v0/callsign";

/** Identifies the Worker to data sources, which often reject requests that don't say who they are. */
export const REQUEST_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "LiveryWatch/1.0 (personal, non-commercial; +https://github.com/beverleyy/special-airplanes)",
};

export const PROVIDER_DELAY_MS = 1100;
export const REG_CHUNK_CHARS = 900;
export const NEARBY_RADIUS_NM = 40;

export const FLEET_TTL_SECONDS = 180;
export const NEARBY_TTL_SECONDS = 30;
export const ROUTE_TTL_SECONDS = 12 * 3600;
export const ROUTE_BACKOFF_SECONDS = 60;
export const REGISTRY_MEMO_MS = 10 * 60 * 1000;

export const MAX_ROUTE_LOOKUPS = 15;
export const INBOUND_MAX_KM = 16000;
export const HEADING_TOLERANCE_DEG = 60;
export const ALWAYS_CHECK_WITHIN_KM = 400;

export const ON_AIRPORT_KM = 6;
export const NEAR_AIRPORT_KM = 50;
export const LOW_ALTITUDE_FT = 10000;
export const TAXI_SPEED_KT = 3;
export const RUNWAY_SPEED_KT = 40;
export const CLIMB_DESCENT_FPM = 300;
export const MIN_ETA_SPEED_KT = 250;
export const APPROACH_ALLOWANCE_SECONDS = 10 * 60;
