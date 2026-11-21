# AirCast architecture

| Component | Responsibility |
| --- | --- |
| `public/index.html` and `aircast.css` | Page structure and styles |
| `aircast-rooms.js` and `aircast-sealed.js` | URL compatibility, room encryption, and peer authentication |
| `aircast-core.js` | Shared monitor, signaling, WebRTC media, and Program transitions |
| `aircast-studio.js`, `aircast-phone.js`, `aircast-output.js` | Host, camera, and OBS workflows |
| `aircast-diagnostics.js` | On-demand connection statistics |
| `functions/api/rooms.js` | Optional R2-backed room manifest storage |

The browser loads classic scripts for static deployment and local file-based public OBS setup. Encrypted rooms use HTTPS or localhost. The service worker caches only the app shell. Room manifests and temporary TURN credentials use uncached API responses.

## Media ownership

An individual phone feed can use the phone directly. When Studio is available and has presented a matching source, an individual output prefers the Studio path so duplicate viewers do not need separate phone uploads. Studio renders Program Multiview from its local camera streams and sends the same slot layout to the Program receiver. OBS reuses its muted Studio-only feeds as the columns or slot list changes, preserving Program audio. Older standalone Multiview URLs still use their pinned slot list.

PeerJS brokers WebRTC connections. A bounded JSON control channel handles health, media negotiation, pause state, and Program transitions. `MediaPipe` carries media over a separate peer connection. Program stages the next feed before retiring the previous one. Direct camera subscribers retain the current feed until the Studio replacement is presented.

## Public and encrypted rooms

Public routes and legacy public OBS URLs use their original signaling namespace. An encrypted manifest holds a random membership secret and the Studio signing public key. Browsers derive a routing namespace from the membership secret and authenticate peers using fresh challenges bound to peer IDs, role, slot, and DTLS fingerprints. Copied OBS URLs carry a scoped viewing credential and publisher verification keys. Studio and direct camera publishers authenticate with their signing keys. The same-origin OBS Multiview frames reuse the Program viewing context and connect only to Studio.

The optional Pages Function accepts immutable room records. Studio’s encrypted recovery credential and camera framing remain in the browser. Only the shared encrypted manifest is uploaded. Live streams remain browser-owned and are encrypted by WebRTC. See [Security](../SECURITY.md) for the trust model and expiry limits.

## Vendored libraries

| Artifact | Version | License |
| --- | --- | --- |
| `public/aircast-peer.min.js` | PeerJS 1.5.5 | MIT. Bundled dependency notices are in the file header. |
| `public/aircast-qr.min.js` | qrcodejs 1.0.0 | MIT. Notice is in the file header. |

To update a vendor artifact, download a pinned package from its registry, verify its published integrity, preserve its notices, and rerun the connection and QR tests. Bump the service-worker shell version together with the asset change.
