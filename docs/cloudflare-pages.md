# Deploy AirCast Lite with Cloudflare Pages

This repo keeps the deployable app in [`public/`](../public/) and the illustrated usage guide in the [README](../README.md). Cloudflare Pages can publish the static files directly from GitHub.

## Connect the GitHub repository

1. Sign in to Cloudflare. In **Workers & Pages**, choose **Create application**, then **Pages**, then **Connect to Git** or **Import an existing Git repository**.
2. Authorize Cloudflare’s GitHub integration for `kyawzin19997/aircast-lite`, select that repository, and begin setup.
3. Use these build settings, then select **Save and Deploy**.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `exit 0` |
| Build output directory | `public` |
| Root directory | Leave at the repository root |
| Environment variables | Leave empty for standard deployment |

Cloudflare’s documentation shows the current [Git integration flow](https://developers.cloudflare.com/pages/get-started/git-integration/) and the recommended [static HTML build settings](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/).

## Test your deployment

1. Open the HTTPS `*.pages.dev` address shown by Pages. Use that same address on the computer, in OBS, and on the phone.
2. In AirCast, copy the Program URL or an individual camera URL. Paste it into an OBS Browser Source. Scan the pairing QR and tap **Go live** on the phone.
3. If you connect a custom domain, copy fresh links from the app at that domain. In the Pages project, use **Custom domains** and follow the prompts. [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

![AirCast Studio with Program and two camera sources](images/studio.png)

## Publish updates

Push changes to `main`. Cloudflare Pages builds the new production deployment automatically. Refresh the Studio, phone page, and OBS Browser Source after a deployment. Keep the service worker and the other assets together in `public/`.

If you are working locally from a clone:

```sh
git clone https://github.com/kyawzin19997/aircast-lite.git
cd aircast-lite
```

After editing the app, run the local smoke test described in the [README](../README.md#local-development), commit the changed files, and push `main`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Pages reports 404 | Verify the output directory is `public` and the deployed folder includes `index.html`. |
| The repo is missing from the Cloudflare picker | Check that Cloudflare’s GitHub app has permission for this repo. [GitHub integration settings](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/) |
| OBS shows a QR but the phone does not connect | Open both devices on the deployed HTTPS site, confirm the room and camera slot, and try the same Wi-Fi network. Keep Studio open for Program, USB, and MJPEG. Individual phone camera links can connect with Studio closed. |
| Camera or microphone permission is blocked | Grant the site permission in the browser and reopen Camera settings. Local testing can use `localhost`. |
| Restricted networks block video | An optional same-origin TURN credential endpoint can be configured with the `aircast-ice-endpoint` meta tag. It must return an `iceServers` array with short-lived, authorized credentials. Keep provider credentials on the server. |
| An older interface keeps appearing | Confirm the new commit is the production deployment, then use OBS Browser Source’s cache refresh and reopen AirCast on the phone. |
