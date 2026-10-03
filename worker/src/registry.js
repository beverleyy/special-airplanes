import { REGISTRY_MEMO_MS } from "./config.js";

export const REGISTRY_KEY = "registry";
export const normReg = reg => (reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

let memo = null;

/** The livery list uploaded by the GitHub Action: { updated, importedAt, entries: [...] }. */
export async function loadRegistry(env) {
  if (memo && memo.expires > Date.now()) return memo.value;
  const stored = await env.LIVERIES.get(REGISTRY_KEY, "json");
  const entries = Array.isArray(stored?.entries) ? stored.entries : [];
  const value = {
    updated: stored?.updated || "",
    importedAt: stored?.importedAt || 0,
    entries,
    byReg: new Map(entries.map(e => [normReg(e.reg), e])),
  };
  memo = { value, expires: Date.now() + REGISTRY_MEMO_MS };
  return value;
}

export function clearRegistryMemo() {
  memo = null;
}
