# Contributing to AirCast Lite

Use Node.js 22 or later. From the repository root:

```sh
npm ci
npx playwright install chromium
npm test
npm run test:browser
```

`npm start` serves the static app on `http://127.0.0.1:4173`. The browser tests start their own local server with an in-memory room authority and simulated signaling. Set `AIRCAST_LIVE_SIGNALING=1` to test with the configured PeerJS service. `AIRCAST_BROWSER` selects an installed Chromium executable when needed.

Keep existing OBS links and settings working. Add a regression test for changes to routing, admission, media handoff, or reconnect. Update the relevant guide with any new settings. The deployment folder is `public/`, so changes to its scripts or styles also need a fresh shell version in `aircast-sw.js`.

The release check includes OBS Browser Source with the same URL on portrait and landscape scenes, one USB or MJPEG feed, a direct phone feed without Studio, a delayed Program cut, and a private viewer revocation. Repeat the phone checks on Android and iOS. Verify a configured TURN relay on a different network before advertising relay support for a deployment.
