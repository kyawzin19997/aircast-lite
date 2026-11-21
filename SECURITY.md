# Security policy

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/kyawzin19997/aircast-lite/security/advisories/new). Include the affected version, impact, and a minimal description. Remove room invitations, connection details, and media from the report. Contact the repository maintainer privately if the reporting form is unavailable.

## Room access

Public rooms have no application-level access control. A Room ID is a locator. Share public room IDs only with people you want to connect. Private rooms use a room authority and separate host, contributor, and viewer credentials. The authority validates the scope and expiry on entry. WebRTC peers prove possession of a session-specific key before sharing media or accepting controls.

The authority stores hashes of invitation and session secrets. Viewer URLs are bearer capabilities and need to be handled like passwords. The host can revoke an invitation from the room menu. A live private client rechecks access periodically and disconnects when the authority rejects it or becomes unreachable. The room authority uses shared PeerJS signaling for routing, so signaling availability and ID collisions remain deployment considerations.

The browser requests camera and microphone access when the operator enables them. Closing or leaving the phone page releases capture. AirCast does not store camera recordings on the server. WebRTC connections may use a TURN relay. Any local clip recording is stored by the operator’s browser.
