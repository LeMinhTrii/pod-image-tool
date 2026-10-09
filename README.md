# POD Image Extractor V3

Two modes: normal storefront HTML parsing (existing `lib/extract.js` unchanged) and Viralstyle Playwright Chromium network/DOM extraction. No Docker or Browserless required.

## Mac (Node 22+)

```bash
npm install
npm run dev
```

Open http://localhost:3000 and select Viralstyle. **Google Chrome must be installed on your Mac.** If Chrome is not found, create `.env.local` containing:

```
CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

Try one URL first: `https://viralstyle.com/atdh/nyl665`.

## Vercel

Push this project to GitHub and import into Vercel as Next.js. Set Node.js 22.x (or supported newer runtime) in project settings. `@sparticuz/chromium` supplies the serverless Chromium binary; no Docker, Browserless or websocket endpoint is required. `export const maxDuration = 60` requests a 60-second function duration, **but actual availability and resource limits depend on your Vercel plan**. If deployment exceeds bundle, memory or execution limits, move browser work to a separate worker or managed browser service. Do not use the `CHROME_EXECUTABLE_PATH` Mac path on Vercel.

## Important limits

- The Viralstyle extractor collects URLs observed in browser requests, DOM, performance entries and embedded page data, and attempts up to 12 variant-control interactions. It does not guarantee all styles; website DOM can change.
- It filters campaign IDs, preferring the ID of a hero/product image. A different campaign on the same page can be mistakenly selected if the main image is not recognizable.
- Only 3 Viralstyle URLs per API call (10 normal URLs). Running Chromium repeatedly is expensive and can time out.
- URLs with `application/octet-stream` are retained if observed; browsers may download them when opened directly.
- The server must be hardened for a public multi-user deployment (rate limiting, authentication or quotas, and outbound network restrictions). Only Viralstyle hosts are accepted in browser mode.
- **Not live-tested against Viralstyle or deployed to Vercel in this environment.** Validate on Mac first and report the resulting count/errors.
