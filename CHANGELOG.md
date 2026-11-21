# Changelog

## 2.0.0

- Added Create Room, Join Room, and Direct Camera entry points, plus separate public-room settings and up to 24 camera slots.
- Added optional private rooms with host, contributor, and viewer invitations, peer verification, revocation, and Cloudflare TURN credential support.
- Added the OBS Output Manager, Multiview output, clean output options, and connection diagnostics.
- Kept existing direct camera and Program URLs, including legacy aliases. Staged individual camera handoffs and bounded OBS first-frame waits.
- Split the app into browser scripts and styles, bundled QR rendering locally, and added automated compatibility tests and GitHub Actions.
