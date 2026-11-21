# Security policy

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/kyawzin19997/aircast-lite/security/advisories/new). Include the affected version, impact, and a minimal description. Remove room invitations, connection details, and media from the report. Contact the repository maintainer privately if the reporting form is unavailable.

## Room access

Public rooms can be joined by anyone with the Room ID. Encrypted rooms use Web Crypto PBKDF2-HMAC-SHA-256 with 600,000 iterations and a random 128-bit salt. AES-256-GCM uses a fresh random 96-bit IV for each encryption. Authenticated metadata binds the ciphertext to its room ID and expiry. Passwords and derived AES keys stay in memory during encryption or decryption. The creator’s browser can retain an encrypted copy of its separate Studio signing credential for recovery. [OWASP PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

Camera contributors prove room membership before exchanging media descriptions or camera controls. The room password does not grant the Studio signing credential. An encrypted OBS link carries a viewing credential in its URL fragment. Anyone with the link can receive its assigned camera or Studio Program, including Program Multiview. The viewing credential cannot decrypt the room manifest or publish media. The OBS pairing QR carries the phone join link without the viewing credential. AirCast trusts the JavaScript served by its HTTPS origin. Shared ciphertext permits offline password guessing, so choose a strong passphrase and share it separately.

Encryption protects the room manifest. It does not grant server-side authorization or prevent arbitrary API requests, signaling disruption, administrative resource deletion, or access to public metadata such as a room locator or expiry. The optional storage endpoint has no overwrite or delete action. With storage, the server refuses future reads after expiry. A person who saved ciphertext and knows the password can still decrypt it independently. Connected participants can also record the streams they receive.

The browser requests camera and microphone access when the operator enables them. Closing or leaving the phone page releases capture. AirCast does not store camera recordings on the server. WebRTC connections may use a TURN relay. Any local clip recording is stored by the operator’s browser.
