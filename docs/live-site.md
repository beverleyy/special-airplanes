# Setting up the live site

The live site runs on GitHub Pages and gets its data from a small Cloudflare Worker that uses only free sources: [Airplanes.live](https://airplanes.live) and [ADSB.lol](https://adsb.lol) for positions, and [adsbdb](https://www.adsbdb.com) for routes. The special livery list lives in the Worker's private storage and is refreshed daily by a GitHub Action, so it's never published.

You'll need [Node.js](https://nodejs.org) 20 or newer on your computer for the Cloudflare tool, Wrangler. Everything else runs on Cloudflare's and GitHub's free plans.

## 1. Sign in to Cloudflare from the terminal

From the repository folder:

```
cd worker
npm install
npx wrangler login
```

A browser window opens. Sign in with your Cloudflare account and allow access.

## 2. Create the Worker's storage

```
npx wrangler kv namespace create LIVERIES
```

It prints an `id`. Open `worker/wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with it. The id isn't a secret, so this can be committed.

## 3. Deploy the Worker

```
npx wrangler deploy
```

The first time, Wrangler may ask you to pick a `workers.dev` subdomain. When it finishes, it prints your Worker's address, like `https://livery-watch.yourname.workers.dev`. Keep it for step 6.

## 4. Set an access code

This keeps the Worker yours, since its traffic counts against the free data sources' limits. Pick any code you'll remember:

```
npx wrangler secret put ACCESS_CODE
```

## 5. Upload the livery list

The GitHub Action will do this daily from step 7 on. For the first upload, from the repository folder:

```
python3 -m livery_watch --export-registry registry.json
cd worker
npx wrangler kv key put registry --path ../registry.json --binding LIVERIES --remote
cd ..
rm registry.json
```

`registry.json` is git-ignored, so it can't be committed by accident.

Check that everything answers:

```
curl -H "X-Access-Code: YOUR_CODE" https://livery-watch.yourname.workers.dev/api/health
```

You should see the number of liveries and a status for each data source. A `200` next to a source means it works from Cloudflare. If one shows `403` or `429`, it's limiting Cloudflare's servers. Change the order of `PROVIDERS` in `wrangler.toml` so the working one comes first, then run `npx wrangler deploy` again.

## 6. Point the site at your Worker

Open `js/config.js` and set your Worker's address:

```js
export const WORKER_URL = "https://livery-watch.yourname.workers.dev";
```

Commit and push. Once GitHub Pages updates, open the site and enter your access code. Each browser remembers it, so you only enter it once per device. Anyone without the code can still see the demo through the "Or view the demo" link, or by adding `?demo` to the address.

If you use a custom domain for Pages, add it to `ALLOWED_ORIGINS` in `wrangler.toml` and deploy again.

## 7. Turn on the daily livery refresh

The workflow in `.github/workflows/update-liveries.yml` refreshes the list every day. It needs two repository secrets.

1. **Create a Cloudflare API token.** In the Cloudflare dashboard, go to **My Profile → API Tokens → Create Token** and use the **Edit Cloudflare Workers** template. It includes permission to edit Workers KV storage.
2. **Find your account ID.** It's shown by `npx wrangler whoami`, and in the dashboard sidebar under **Workers & Pages**.
3. **Add both to GitHub.** In the repository, go to **Settings → Secrets and variables → Actions** and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **Run it once to check.** Under **Actions → Update livery list → Run workflow**.

## Updating the Worker later

After changing anything in `worker/`, run `npx wrangler deploy` from the `worker` folder. To try changes locally first, put `ACCESS_CODE=anything` in `worker/.dev.vars` and run `npx wrangler dev`. Setting `WORKER_URL` to the local address it prints lets the site talk to your local Worker.

## What the live site can and can't show

- **Now:** special liveries near the airport that are on approach, landing, taxiing, waiting to depart, or just took off.
- **Inbound:** special liveries in the air anywhere that are flying to the airport, with an estimated arrival time based on distance and speed.
- **Tail lookup:** where a special-livery aircraft is right now and its current route.
- **Not shown:** flights that haven't taken off yet, and aircraft parked with their transponders off. For the full 24 hours, run `python3 -m livery_watch` in a terminal.

The first search after a few quiet minutes takes up to about 20 seconds for the Inbound section, because the Worker checks the whole special livery fleet a batch at a time within the data sources' rate limits. After that, results are cached for 3 minutes.
