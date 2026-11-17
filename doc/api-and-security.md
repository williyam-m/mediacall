# API, Signaling, And Security

## HTTP API

JSON API responses use `Cache-Control: no-store`. The frontend and APIs share an origin. Provider keys are server-side environment variables and are never included in the Vite bundle.

| Route | Method | Contract |
| --- | --- | --- |
| `/api/config` | GET | Access-token requirement, Automatic default, provider profile, available local listener URLs |
| `/api/health` | GET | Configuration/process readiness, not proof of a successful relay media path |
| `/api/ice` | GET | Authenticated ICE credentials or managed signaling descriptor |
| `/api/realtime` | POST | Managed room-scoped token mint; accepts roomId, name, mode, optional accessToken |
| `/api/relay` | GET | Custom server counters or explicit null provider-global metrics |
| `/api/network?ip=...` | GET | Validated literal-IP approximate location metadata |
| `/api/signal` | GET/POST | Alternate hosted HTTP room signaling; not used by recommended managed mode |
| `/signal` | WS upgrade | Local/external persistent WebSocket room signaling |

Protected GET routes accept `Authorization: Bearer <app-access-token>` when APP_ACCESS_TOKEN is configured. Managed token POSTs validate Origin against APP_ORIGIN or the request Host, require JSON content type, validate room/name/mode, enforce body limits, and gate on the access token when configured. Public token issuance remains a demo mode unless a real account authorization layer is added.

The metadata endpoint accepts an IP only, not a destination URL. Its upstream URL is fixed. The external-backend proxy permits only known API paths, does not follow redirects, strips arbitrary query parameters, and forwards only the IP parameter for network metadata.

## Client Signaling Contract

App-level messages are typed in [shared/types.ts](../src/shared/types.ts): join, description, ice, media, leave; server events include joined, peer-joined, peer-left, description, ice, media, and error.

Adapters preserve those semantics across transports. The managed adapter wraps messages in a room-scoped provider publish envelope with target peer ID; it ignores messages not from the selected peer or not addressed to the local peer. Names and mode are taken from provider-stamped metadata.

Managed two-party capacity is app/provider-roster enforcement, not a provider-level channel limit. It must not be advertised as a strict authorization boundary against modified clients. Local WebSocket rooms enforce a two-member server-side limit. Alternate SQL rooms enforce membership atomically using versioned compare-and-swap updates.

## Managed Token Boundary

The Vercel function sends the provider key pair to the fixed Metered token endpoint over HTTPS. Minted tokens are scoped to one `mediacall/<roomId>` channel, last one hour, and grant publish/subscribe/presence. The browser receives a token, not signing material. TURN credentials arrive over the authenticated provider welcome and remain browser ICE credentials as required by WebRTC.

Missing provider credentials, missing injected TURN, malformed provider responses, quota failures, or unreachable services produce actionable errors without echoing raw upstream responses, connection strings, or secrets. Do not copy production keys into tests; tests use explicit fixtures.

## Custom TURN Boundary

Custom credentials/nonces, integrity checks, permissions, channel mapping, quotas and expiry are detailed in [custom-turn](custom-turn.md). A shared access token is an application-entry gate, not individual identity verification or a billing system.

Custom auth uses the protocol's standard HMAC-SHA1/MD5 derivation. It should not be confused with a modern general-purpose password storage design. Nonces use HMAC-SHA256.

## Media And Identity

Browsers encrypt WebRTC media with DTLS-SRTP. A TURN server sees routing metadata, packet sizes, and timing, but does not decode media plaintext. Signaling infrastructure is trusted for SDP/fingerprint exchange. This app does not cryptographically verify that a named participant is a particular human.

Invite links are bearer capabilities with high-entropy room IDs. Display names are not account identities. Screensharing only captures content approved through the browser picker. Recording, moderation, persistent accounts, and multiparty calls are not implemented.

## Diagnostics Privacy

Only selected relay IPs are sent to the optional GeoIP provider. Related addresses remain client-side in stats and may appear in an explicit diagnostic download. Exports intentionally omit raw SDP, media, credentials, application tokens, and signing material. Review network diagnostic exports before sharing them.

GeoIP is approximate and cannot establish a person's physical location. Unknown/redacted fields remain unknown. No country/ASN/relay port is fabricated from a provider hostname.

## Operational Limits

Most HTTP rate buckets are process-local; they are bounded but are not a distributed abuse defense across all Vercel instances. For a public production product, add account-based authorization, distributed limits, hard provider spending controls, audit/fuzz/interoperability testing, and appropriate monitoring.

Revoke any secret shared in chat, logs, screenshots, or commits and replace it through the provider/dashboard. Ordinary rotation may preserve an old secret during a grace period; deletion/revocation is safer after disclosure. Never push `.env`, `.vercel` credentials, downloaded diagnostics, or browser traces containing runtime tokens.