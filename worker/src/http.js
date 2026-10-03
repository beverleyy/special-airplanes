export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return allowed.includes(origin) || isLocal ? origin : "";
}

export function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-Access-Code",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(payload, request, env, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(request, env) },
  });
}

/** Your own ACCESS_CODE plus any shared ones in ACCESS_CODES (comma separated). */
export function accessCodes(env) {
  return [env.ACCESS_CODE, ...(env.ACCESS_CODES || "").split(",")].map(c => (c || "").trim()).filter(Boolean);
}

/** Requests must carry one of the access codes when any are configured. */
export function checkAccess(request, env) {
  const codes = accessCodes(env);
  if (!codes.length) return;
  if (!codes.includes(request.headers.get("X-Access-Code") || "")) {
    throw new HttpError(401, "This Livery Watch needs an access code.");
  }
}
