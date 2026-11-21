# Security policy

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/kyawzin19997/aircast-lite/security/advisories/new). Include the affected version, impact, and a minimal description. Remove room invitations, connection details, and media from the report. Contact the repository maintainer privately if the reporting form is unavailable.

## Room access

Public rooms can be joined by anyone with the Room ID. Managed rooms use a room authority and separate host, contributor, and viewer credentials. Creators can require a password or set an expiration. The authority validates scope and expiry on entry. WebRTC peers prove possession of a session-specific key before sharing media or accepting controls.

The authority stores salted, derived password hashes and hashes of invitation and session secrets. Camera pairing QR codes identify the room and slot. Studio’s copied managed OBS URLs carry a viewer credential and should be treated like passwords. A live managed client rechecks access periodically and disconnects when the authority rejects it or becomes unreachable. The room authority uses shared PeerJS signaling for routing.

The browser requests camera and microphone access when the operator enables them. Closing or leaving the phone page releases capture. AirCast does not store camera recordings on the server. WebRTC connections may use a TURN relay. Any local clip recording is stored by the operator’s browser.
