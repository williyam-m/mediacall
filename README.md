# MediaCall

**Live application: https://mediacall-six.vercel.app**

**Source: https://github.com/williyam-m/mediacall**

A one-to-one WebRTC audio/video application with explicit ICE policy controls, a from-scratch IPv4 TURN implementation named **custom-turn**, a Metered Open Relay hosted deployment, and real-time connection diagnostics.

**Automatic ICE is the default.** Force TURN is an explicit selection. If either participant requests Force TURN, both use `iceTransportPolicy: 'relay'` before media negotiation. The public Vercel deployment uses Metered Open Relay, not the repository's custom UDP server.

## Features

| Area | Implemented behavior |
| --- | --- |
| Calls | One-to-one video or microphone-only calls, random room IDs, copyable same-origin invites, waiting/connecting/reconnecting/ended states |
| ICE | Automatic (`all`) by default, explicit Force TURN (`relay`), either participant can enforce relay-only negotiation, selected route shown from getStats |
| Media controls | Mute/unmute, camera off/on, camera/microphone selection, device refresh, preview, fullscreen, browser screen-share video, restore camera on share stop |
| Media safety | Browser permissions, HTTPS requirement outside localhost, no camera capture for audio-only calls, track cleanup on leave/unmount, audio autoplay recovery action |
| Recovery | Polite/impolite negotiation roles, queued trickle ICE, bounded ICE restart attempts, manual reconnect action, actionable permission/provider errors |
| Hosted backend | Vercel UI/API plus official Metered signaling SDK, short-lived room-scoped tokens, automatically injected hosted TURN, no always-on laptop or database required |
| Local startup | `--turn custom-turn` or `--turn metered`, optional `--configure`, HTTP/TURN/relay-range flags, `--ice auto|relay`, validated environment overrides |
| custom-turn | STUN Binding; authenticated Allocate/Refresh; CreatePermission; ChannelBind; Send/Data indications; ChannelData; UDP/TCP/optional TLS client transports; UDP relay sockets |
| Relay controls | Temporary credentials, signed IP-bound nonces, integrity/fingerprint validation, replayed transaction responses, allocation/permission/channel expiry, quotas and byte limits |
| Relay console | Actual selected local/remote candidate IP and allocated port, ICE and client-to-TURN protocols, listener URL, related endpoints, candidate pair, nomination and connection states |
| Relay location | Approximate city/region/country, ASN and organization via bounded cached HTTPS GeoIP; local/reserved addresses stay local; missing data is labelled, not invented |
| Live stats | One-second inbound/outbound RTP bitrate, RTT, jitter, cumulative loss, FPS, codecs, resolution, packet/frame counts, bandwidth estimate, session bytes, 60-sample chart |
| Export | JSON snapshot of stats/history and network metadata, without SDP/media/TURN credentials/signing secrets |
| UI | Responsive desktop/mobile workspace, scrollable relay console with persistent close control, tooltips, real microphone activity |
| Alternate infrastructure | Persistent local WebSocket rooms, alternate hosted HTTP/PostgreSQL rooms, fixed external-backend proxy |
| Tests | Separate unit, socket, local browser and public live suites; synthetic media and credential-safe test fixtures |

## Quick Start

Requires **Node.js 22.18+** and npm.

```sh
npm ci
npm run dev -- --turn custom-turn
```

Open **http://localhost:5180** in two browsers. Local defaults: TURN `3490` UDP/TCP, relay IP `127.0.0.1`, allocation range `49160-49259`, and Automatic ICE. A localhost relay is reachable only from the same machine.

```sh
npm run dev -- --configure
npm run dev -- --help
npm run dev -- --turn custom-turn --port 5190 --ice relay
npm run dev -- --turn metered
```

Metered mode requires provider credentials in the ignored `.env` file. No credential is accepted through CLI flags. The preferred pair is `METERED_REALTIME_KEY_ID` and `METERED_REALTIME_SECRET`; enable TURN injection and channel-scoped publish/subscribe/presence on `mediacall/*`. See [Deployment](doc/deployment.md) for all flags, configuration, safe credential setup, LAN/public networking and alternate modes.

## Architecture

```text
src/client/
  components/       Media, session, dialogs, relay console, live stats, UI primitives
  hooks/            Call lifecycle, workspace workflow, audio, stats, relay locations
  signaling/        Local WebSocket, hosted HTTP, official Metered SDK adapters
  media/            Media error normalization
  services/         Call API and invitation boundaries
  webrtc/           Pure stats collector and relay probe
  styles/           Ordered modular CSS
src/server/
  config/           CLI/environment parsing and validation
  custom-turn/      Wire protocol, authentication, allocation and relay sockets
  hosted/           Managed token API, TURN REST, SQL signaling, external proxy
  http/             Request handlers, response/auth helpers, headers, assets, limits
  network/          Relay IP location metadata
  providers/        Local relay construction/shutdown
  signaling/        Persistent local two-party WebSocket rooms
src/shared/         Client/server contracts
api/                Vercel function entry
tests/unit/         Unit/socket/integration tests, outside production source
tests/e2e/          Reproducible local browser regressions
tests/live/         Actual Vercel/provider smoke tests
doc/                Technical architecture, protocols, deployment and diagnostics
```

See [Architecture](doc/architecture.md) and [Call Flow](doc/call-flow.md) for sequence diagrams, module ownership and trust boundaries.

## Hosted And Custom Modes

| Mode | Signaling | Relay |
| --- | --- | --- |
| Public Vercel | Metered managed WSS, tokens minted by Vercel | Metered Open Relay |
| Local `--turn metered` | Same managed SDK path, or local WSS with TURN REST config | Metered Open Relay |
| Local/self-hosted `--turn custom-turn` | Local persistent WebSocket process | Repository custom-turn |

Vercel cannot expose the custom server's raw UDP allocation ports. Switching to hosted mode does not turn the custom implementation into a hosted service; the UI names the actual provider.

### Vercel Setup

Set these Production environment variables directly in Vercel, not chat or source control:

| Variable | Value |
| --- | --- |
| `CALL_BACKEND` | `hosted` |
| `METERED_REALTIME_KEY_ID` | Your provider key ID |
| `METERED_REALTIME_SECRET` | Sensitive signing secret |
| `METERED_CHANNEL_PREFIX` | Optional; defaults to `mediacall/` |
| `APP_ACCESS_TOKEN` | Optional shared call-entry gate |

```sh
npm run build
npx vercel --prod --scope williyam
npm run test:live
```

Check current free-provider quotas in the dashboard. The app does not enable paid plans or automatic upgrades. A health response means configured, not verified media reachability. Shared secrets disclosed anywhere should be revoked and replaced; ordinary rotation may preserve a grace period.

### Self-Hosted custom-turn

```sh
npm run build
npm start -- --turn custom-turn
```

Production requires an actual public relay IPv4, a strong TURN_SECRET, web HTTPS, correct interface binding, access-token protection or explicit anonymous opt-in, and open TURN listener/UDP allocation ports. An HTTP tunnel alone does not publish TURN allocations. See [Deployment](doc/deployment.md).

## Verify The Demo

1. Open the live application in two devices/browsers and create/join a room.
2. Leave Automatic selected to allow normal ICE path selection, or choose Force TURN before entering to require the relay.
3. Confirm received audio/video in both directions.
4. Open Relay console. In forced mode, verify Relay only, `relay / relay`, actual allocated endpoints, and increasing byte/frame counters.
5. View live bitrate/latency/loss samples and optionally download a diagnostics snapshot.

The allocation probe is useful but does not replace the two-peer media test. Approximate GeoIP refers to a relay address, not the person's physical location. Browser-redacted metadata remains unavailable.

## Tests

```sh
npm test
npm run build
npx playwright install chromium
npm run test:call
npm run test:live
```

Unit/socket tests include RFC vectors, UDP/TCP/TLS relay lifecycles, authentication, validation, quotas, CLI startup, signaling races, stats calculations, and safe location lookup. Browser tests cover direct and forced-relay media, microphone-only calls, controls, screen-track replacement, managed signaling, diagnostics, exports, and responsive layouts. The live suite exercises the deployed provider without a local server. It consumes small amounts of real provider quota.

OpenSSL generates ephemeral TLS test certificates. PGlite supplies isolated PostgreSQL behavior. Browser tests use synthetic media; native OS share pickers and every NAT/browser combination are not certified. Test artifacts are ignored and may contain private runtime network information.

## Technical Docs

- [Documentation Index](doc/README.md)
- [custom-turn Allocation, Mapping, Permissions And Channels](doc/custom-turn.md)
- [Architecture](doc/architecture.md)
- [Call Flow](doc/call-flow.md)
- [Deployment And Environment Reference](doc/deployment.md)
- [Live Diagnostics Definitions](doc/diagnostics.md)
- [API And Security](doc/api-and-security.md)
- [Testing](doc/testing.md)

## Scope And Limits

The app implements one-to-one calls, not multiparty conferencing, recording, persistent user accounts or cryptographically verified participant identities. Managed room capacity is enforced by the app's presence roster, not a provider-level channel subscriber cap. Managed connection tokens last one hour; rejoin after signaling/token closure. Rate buckets are bounded but mostly process-local, not a complete distributed abuse-control system.

custom-turn currently supports IPv4 UDP peer allocations and UDP/TCP/TLS clients. IPv6 allocations, TCP peer allocations, mobility, even-port reservations, OAuth and SHA-256 STUN integrity are not implemented. It has not been independently security-audited, interoperability-certified, or shown to outperform coturn. The [custom-turn technical document](doc/custom-turn.md) details exact behavior and limits.