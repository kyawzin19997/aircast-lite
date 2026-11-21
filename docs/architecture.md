# AirCast architecture

| Component | Responsibility |
| --- | --- |
| `public/index.html` and `aircast.css` | Page structure and styles |
| `aircast-rooms.js` | URL compatibility, private entry, and peer verification |
| `aircast-core.js` | Shared monitor, signaling, WebRTC media, and Program transitions |
| `aircast-studio.js`, `aircast-phone.js`, `aircast-output.js` | Host, camera, and OBS workflows |
| `aircast-diagnostics.js` | On-demand connection statistics |
| `infra/room-authority.mjs` and `functions/api/rooms.js` | Optional room authority and Pages entry point |

The browser loads classic scripts to support both a static deployment and local file-based OBS setup. The service worker caches only the app shell. Private room requests and temporary TURN credentials use uncached API responses.

## Media ownership

An individual phone feed can use the phone directly. When Studio is available and has presented a matching source, an individual output prefers the Studio path so duplicate viewers do not need separate phone uploads. Studio sends layout changes to the Program receiver over its existing connection. The receiver renders muted Studio-only feeds in Multiview and preserves Program audio. Older standalone Multiview URLs still use their original pinned slot list.

PeerJS brokers WebRTC connections. A bounded JSON control channel handles health, media negotiation, pause state, and Program transitions. `MediaPipe` carries media over a separate peer connection. Program stages the next feed before retiring the previous one. Direct camera subscribers retain the current feed until the Studio replacement is presented.

## Public and private rooms

Public routes and legacy public OBS URLs use their original signaling namespace. Managed rooms have a separate namespace. The authority admits contributors and viewers according to the room’s password policy, then assigns a role and camera scope. Host credentials stay separate. Existing invitation-based rooms retain their original access rules.

The authority binds each admitted session’s public key and assigned peer ID. Peers sign a fresh challenge tied to the peer IDs and DTLS fingerprints for each link. A viewer may access only its assigned slot or the room output scope. Peers periodically recheck authorization. New rooms expire at the time chosen by the creator, if any. Browser storage keeps per-room configuration and camera framing. Live streams remain browser-owned.

## Vendored libraries

| Artifact | Version | License |
| --- | --- | --- |
| `public/aircast-peer.min.js` | PeerJS 1.5.5 | MIT. Bundled dependency notices are in the file header. |
| `public/aircast-qr.min.js` | qrcodejs 1.0.0 | MIT. Notice is in the file header. |

To update a vendor artifact, download a pinned package from its registry, verify its published integrity, preserve its notices, and rerun the connection and QR tests. Bump the service-worker shell version together with the asset change.
