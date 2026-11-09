# Tricount Viewer

A static page that shows a Tricount's expenses, balances and settle-up payments from its share link
(`https://tricount.com/<id>`). It runs on GitHub Pages; a small Cloudflare Worker relays requests to
Tricount's API, which doesn't allow calls from other websites (no CORS).

Open the page, paste a share link or ID, or link straight to `https://<you>.github.io/tricount-viewer/#<id>`.

> Tricount's API is unofficial (it's what the app uses) and may change without notice.

## How it fits together

- `src/index.html`: the viewer. `node build.mjs` writes `dist/index.html` with the relay URL filled in.
- `worker/`: the relay. It answers `GET /registry?id=<id>` only for the origins in `ALLOWED_ORIGINS`,
  limits each IP to 30 requests a minute, caches each tricount for 60 seconds (unknown ids for 10 minutes)
  and removes contact details and card ids from the response.
- `.github/workflows/pages.yml`: builds the page with the `RELAY_URL` repository variable and deploys it to Pages.

Forks don't inherit repository variables, so a fork's page has no relay until you set up your own.
The original relay only accepts requests from the original site.

## Run your own copy

1. **Deploy the relay.** Edit `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your Pages origin
   (for example `https://<you>.github.io`), then:
   ```sh
   cd worker
   npx wrangler login
   npx wrangler deploy
   ```
   Note the `https://tricount-relay.<subdomain>.workers.dev` URL it prints.
2. **Set the variable.** In your repository: Settings → Secrets and variables → Actions → Variables →
   New repository variable `RELAY_URL` with the Worker URL. Or: `gh variable set RELAY_URL --body <url>`.
3. **Enable Pages.** Settings → Pages → Source: GitHub Actions. Enable Actions on your fork if needed.
4. Push to `main` (or run the workflow by hand). The page appears at `https://<you>.github.io/tricount-viewer/`.

## Local development

```sh
cp .env.example .env        # set RELAY_URL to your relay
node build.mjs
python3 -m http.server 8000 --directory dist
```

`http://localhost:8000` must be in the relay's `ALLOWED_ORIGINS` for this to work.
