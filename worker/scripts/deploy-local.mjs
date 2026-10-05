// Deploys from your own computer: fills KV_NAMESPACE_ID into a git-ignored copy of wrangler.toml,
// then runs wrangler deploy with it. Works the same on Windows, macOS, and Linux.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const id = (process.env.KV_NAMESPACE_ID || "").trim();
if (!id) {
  console.error("Set KV_NAMESPACE_ID to your KV namespace ID first.");
  console.error('  macOS / Linux:      export KV_NAMESPACE_ID=<your-id>');
  console.error('  Windows PowerShell: $env:KV_NAMESPACE_ID = "<your-id>"');
  process.exit(1);
}

const config = readFileSync("wrangler.toml", "utf8");
if (!config.includes("REPLACE_WITH_KV_NAMESPACE_ID")) {
  console.error("wrangler.toml no longer contains REPLACE_WITH_KV_NAMESPACE_ID, so there's nothing to fill in.");
  process.exit(1);
}
writeFileSync("wrangler.local.toml", config.replace("REPLACE_WITH_KV_NAMESPACE_ID", id));

const result = spawnSync("npx", ["wrangler", "deploy", "--config", "wrangler.local.toml", ...process.argv.slice(2)],
  { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
