# Setting up the live site

The live site runs on GitHub Pages and gets its data from a small Cloudflare Worker that uses only free sources: [adsb.fi](https://adsb.fi) for positions, and [adsbdb](https://www.adsbdb.com) for routes. The position sources refuse requests from Cloudflare's own servers, so the Worker reaches them through a [CORS Anywhere](https://github.com/Rob--W/cors-anywhere) proxy hosted elsewhere (set by `PROXY` in `worker/wrangler.toml`). The special livery list lives in the Worker's private storage and is refreshed daily by a GitHub Action, so it's never published.

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

It prints an `id`. Keep it: it goes into a GitHub repository secret in step 7, so it never needs to be committed. For deploying from your own computer before then, paste it in place of `REPLACE_WITH_KV_NAMESPACE_ID` in `worker/wrangler.toml`, but change it back before committing.

## 3. Deploy the Worker

```
npx wrangler deploy
```

The first time, Wrangler may ask you to pick a `workers.dev` subdomain. When it finishes, it prints your Worker's address, like `https://livery-watch.yourname.workers.dev`. Keep it for step 6.

## 4. Set the Worker's secrets

These are stored in Cloudflare, not in the repository, and they're kept across deploys.

```
npx wrangler secret put ACCESS_CODE
npx wrangler secret put PROXY
```

- `ACCESS_CODE` keeps the Worker yours, since its traffic counts against the free data sources' limits. Pick any code you'll remember.
- `PROXY` is your CORS Anywhere proxy's address, ending in `/`. It's a secret because anyone who knows the address could use your proxy.

If Wrangler says a binding name is already in use, the deployed Worker still has that name as a plain setting from an older `wrangler.toml`. Deploy once with the current `wrangler.toml`, then set the secret.

## 5. Upload the livery list

The GitHub Action will do this daily from step 7 on. For the first upload, from the repository folder:

```
python3 -m livery_watch --export-registry registry.json
cd worker
npx wrangler kv key put registry --path ../registry.json --namespace-id YOUR_KV_ID --remote
cd ..
rm registry.json
```

`registry.json` is git-ignored, so it can't be committed by accident.

Check that everything answers:

```
curl -H "X-Access-Code: YOUR_CODE" https://livery-watch.yourname.workers.dev/api/health
```

You should see:
- `registry`: the number of liveries.
- `withHex`: how many of them have a hex code, which adsb.fi needs. It should be close to `registry`.
- `proxy`: the proxy's host name.
- `sources`: a status for each data source. A `200` means it works through the proxy.

If a source shows `403` or `429`, it's refusing or limiting the proxy's server. Change the order of `PROVIDERS` in `wrangler.toml` so a working one comes first, then run `npx wrangler deploy` again. If the very first check takes a long time, the proxy was asleep. Render's free tier naps when idle, and opening the site wakes it in the background.

## 6. Point the site at your Worker

Open `js/config.js` and set your Worker's address:

```js
export const WORKER_URL = "https://livery-watch.yourname.workers.dev";
```

Commit and push. Once GitHub Pages updates, open the site and enter your access code. Each browser remembers it, so you only enter it once per device. Anyone without the code can still see the demo through the "Or view the demo" link, or by adding `?demo` to the address.

If you use a custom domain for Pages, add it to `ALLOWED_ORIGINS` in `wrangler.toml` and deploy again.

## 7. Turn on the GitHub Actions

Two workflows use these secrets:
- **Update livery list** (`.github/workflows/update-liveries.yml`) refreshes the list every day.
- **Deploy Worker** (`.github/workflows/deploy-worker.yml`) runs the Worker's tests and deploys it whenever `worker/` changes on `main`. It fills in the KV namespace ID from a secret, so the ID stays out of the repository.

1. **Create a Cloudflare API token.** In the Cloudflare dashboard, go to **My Profile → API Tokens → Create Token** and use the **Edit Cloudflare Workers** template. It includes permission to edit Workers KV storage.
2. **Find your account ID.** It's shown by `npx wrangler whoami`, and in the dashboard sidebar under **Workers & Pages**.
3. **Add three secrets to GitHub.** In the repository, go to **Settings → Secrets and variables → Actions** and add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `KV_NAMESPACE_ID` (the ID from step 2).
4. **Run both once to check.** Under **Actions**, open each workflow and choose **Run workflow**.

## Sharing the live site

To let someone see the live site, such as a recruiter, give them an access link with its own code:

```
https://<your-username>.github.io/special-airplanes/?code=<ACCESS_CODE_HERE>
```

The page saves the code, removes it from the address bar, and opens straight to the live data. Shared codes are kept separately from your own, in a secret called `ACCESS_CODES`, as a comma-separated list:

```
cd worker
npx wrangler secret put ACCESS_CODES
```

When it asks for the value, enter every shared code you want active, for example `united-2026,delta-2026`. Setting the secret again replaces the whole list, so to turn a link off, enter the list without that code. Changes apply within a few seconds, with no deploy needed. One code per recipient or application lets you turn off each link separately. Codes are visible to anyone with the link, so use names you don't mind them seeing.

## Updating the Worker later

Push changes in `worker/` to `main`, and the Deploy Worker action deploys them. To deploy from your own computer instead, paste the KV namespace ID into `wrangler.toml` first, and change it back before committing. To try changes locally first, put `ACCESS_CODE=anything` in `worker/.dev.vars` and run `npx wrangler dev`. Setting `WORKER_URL` to the local address it prints lets the site talk to your local Worker.

## What the live site can and can't show

- **Now:** special liveries near the airport that are on approach, landing, taxiing, waiting to depart, or just took off.
- **Inbound:** special liveries in the air anywhere that are flying to the airport, with an estimated arrival time based on distance and speed.
- **Tail lookup:** where a special-livery aircraft is right now and its current route.
- **Not shown:** flights that haven't taken off yet, and aircraft parked with their transponders off. For the full 24 hours, run `python3 -m livery_watch` in a terminal.

The first search after a few quiet minutes takes up to about 20 seconds for the Inbound section, because the Worker checks the whole special livery fleet a batch at a time within the data sources' rate limits. After that, results are cached for 3 minutes.
