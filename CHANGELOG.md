# Changelog

## 2.2.1

- Restored the pairing QR on protected OBS feeds. Camera contributors enter the room password on their phones.
- Added scoped OBS viewing credentials for protected Program and individual camera links.

## 2.2.0

- Added client-side room encryption and authenticated WebRTC pairing without a Durable Object.
- Added portable encrypted links and optional R2 storage for short links, Room ID lookup, and server-enforced expiry of future downloads.
- Matched Studio’s Program Multiview to the OBS Program source and preserved OBS camera feeds when changing columns.

## 2.1.0

- Opened AirCast on a room home page. Rooms are created on demand with optional passwords and expiration.
- Added direct camera-slot pairing for open rooms and a password prompt after scanning a protected room’s QR.
- Added a Studio control to switch the single OBS Program source between the selected camera and Multiview.
- Added a live camera hide control that pauses outgoing video and microphone audio while keeping local preview and pairing.

## 2.0.1

- Preserved transparency around live video when the Output Manager selects a transparent background.

## 2.0.0

- Added Create Room, Join Room, and Direct Camera entry points, plus separate public-room settings and up to 24 camera slots.
- Added optional private rooms with host, contributor, and viewer invitations, peer verification, revocation, and Cloudflare TURN credential support.
- Added the OBS Output Manager, Multiview output, clean output options, and connection diagnostics.
- Kept existing direct camera and Program URLs, including legacy aliases. Staged individual camera handoffs and bounded OBS first-frame waits.
- Split the app into browser scripts and styles, bundled QR rendering locally, and added automated compatibility tests and GitHub Actions.
