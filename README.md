# MediaCall

One-to-one WebRTC video and audio calls with an integrated, from-scratch TURN server. 

## Run Locally

Requires Node.js **22.18+** and npm.

```sh
npm ci
npm run dev
```

Open **http://localhost:5180**. Enter your name, create a call, and open the invite in another tab or browser. The local TURN listener uses **3490 UDP/TCP** to avoid conflicts with standard TURN services. Both signaling and the web app use port 5180.

Localhost links and a localhost relay only work on the same machine. Calls between different devices require the deployment configuration below. Camera and microphone access require HTTPS outside localhost.

## Call Modes

- **Automatic:** `iceTransportPolicy: 'all'`. WebRTC can select a direct host/server-reflexive candidate or fall back to the custom TURN relay. ICE chooses the working candidate pair; direct routing is not assumed.
- **Force TURN:** `iceTransportPolicy: 'relay'` on **both** browsers. If either participant selects it, the room becomes relay-only before negotiation. There is no silent direct fallback when the relay is unavailable.
- **Audio call:** captures only the microphone. A negotiated video transceiver remains available for screen sharing without recapturing the camera.

Mute, camera toggle, device selection, screen sharing, fullscreen, leave/rejoin, automatic ICE-restart attempts, and live route/RTT/bitrate/loss statistics are included. Screen sharing replaces the video track; system audio sharing is not implemented.

The relay console shows allocations and traffic counters. **Test relay** verifies authenticated allocation and relay candidate gathering, not end-to-end reachability from a second network. The browser call tests verify actual two-way media.

## TURN Implementation

The server implements the RFC 5389/5766 wire format directly using Node's `dgram`, `net`, `tls`, and `crypto` primitives:

- STUN Binding and XOR-MAPPED-ADDRESS.
- Long-term MESSAGE-INTEGRITY authentication, signed address-bound nonces, and stale-nonce challenges.
- Short-lived TURN REST-style HMAC credentials with random session identifiers.
- Allocate and Refresh, including lifetime-zero deletion and allocation expiry.
- CreatePermission, IP-scoped permissions, ChannelBind, Send/Data indications, and ChannelData.
- UDP clients, TCP clients, and optional TLS clients; the relayed peer transport is UDP in all three cases.
- TCP/TLS stream framing and ChannelData padding, including fragmented/coalesced reads.
- Transaction response caching, allocation/per-IP quotas, permission/channel limits, bandwidth limits, and bounded request rate-limit state.
- A public-peer policy that blocks private, loopback, link-local, and multicast destinations by default in production.

Private peers are allowed by default only in development, for same-machine testing. Listener and relay bindings default to loopback when the advertised address is localhost; this keeps UDP response source addresses consistent.

Authentication uses the standard RFC 5766 HMAC-SHA1/MD5 key derivation, not a proprietary cipher. Expired credentials cannot create new allocations, but an already authenticated allocation can continue refreshing during a long call. New ICE restarts obtain fresh credentials.

Allocations live for at most 600 seconds between refreshes, permissions for 300 seconds, channels for 600 seconds, and cached transaction responses for 40 seconds. Closing a TCP/TLS client removes its allocation immediately. Abandoned UDP allocations expire on their timer; gathering a test candidate can temporarily consume an allocation.

## Deploy For Real Calls

Use a server with a reachable public IPv4 address. All environment variables are listed in [.env.example](.env.example). Build and run:

```sh
npm ci
npm run build
npm start
```

Set these environment values before starting production:

| Variable                     | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `TURN_PUBLIC_IP`           | The relay server's real public IPv4 address, not localhost                    |
| `TURN_BIND_IP`             | The local IPv4 interface, or `0.0.0.0` on a single-interface/NAT deployment |
| `TURN_RELAY_BIND_IP`       | The local IPv4 interface used for allocated UDP ports                         |
| `TURN_HOST`                | Optional DNS hostname resolving to the public IPv4 address                    |
| `TURN_PORT`                | Usually `3478` in production; development defaults to `3490`              |
| `TURN_SECRET`              | At least 32 cryptographically random characters                               |
| `APP_ACCESS_TOKEN`         | At least 24 random characters; entered in both browsers' call settings        |
| `APP_ORIGIN`               | The exact web origin, such as `https://call.example.com`                    |
| `TURN_ALLOW_PRIVATE_PEERS` | `false` for an Internet-facing relay                                        |

Generate independent secrets locally, for example with `openssl rand -hex 32`. Do not reuse the example placeholder strings as secrets. Access tokens stay in browser memory, are not included in invite links, and are required for both credential issuance and room joins when configured.

Put the HTTP server behind an HTTPS reverse proxy that preserves `Host` and forwards WebSocket upgrades for `/signal`. For example, Caddy can terminate the web application's HTTPS:

```caddyfile
call.example.com {
    reverse_proxy 127.0.0.1:5180
}
```

Web HTTPS and TURN TLS are separate listeners. To enable native TURN-over-TLS, set `TURN_TLS_CERT`, `TURN_TLS_KEY`, and optionally `TURN_TLS_PORT` (default 5349). Use a trusted PEM certificate matching `TURN_HOST`; self-signed browser certificates are not a production solution.

Open/map these ports:

| Port                                | Protocol    | Purpose                  |
| ----------------------------------- | ----------- | ------------------------ |
| `443`                             | TCP         | HTTPS/WSS reverse proxy  |
| `3478` or configured TURN port    | UDP and TCP | TURN/STUN listener       |
| `5349` or configured TLS port     | TCP         | Optional native TURN TLS |
| `49160-49259` or configured range | UDP         | Allocated relay sockets  |

If the server is behind NAT, preserve every allocated relay port in the public-to-private mapping. `TURN_PUBLIC_IP` is the externally advertised address, not necessarily a local bind address. UDP cannot be carried by a normal HTTP reverse proxy or a TCP-only SSH forward. On a multi-interface machine, explicitly select the listener interface to avoid mismatched UDP source addresses.

Production refuses a missing public address, a short/missing TURN secret, or unprotected credential issuance. `ALLOW_ANONYMOUS=true` is an explicit opt-in for an anonymous deployment, **not recommended on the public Internet**. The shared access token is a basic deployment gate, not a complete account, billing, or abuse-prevention system.

## Verify

```sh
npm test
npm run build
npx playwright install chromium
npm run test:call
```

The server suite uses real UDP, TCP, and TLS sockets, the RFC 5769 integrity/fingerprint vector, forged-auth/unsigned-attribute cases, permission enforcement, quota checks, two-member room policy, and authenticated production APIs. OpenSSL is required to generate the ephemeral self-signed TLS test fixture; no test private key is committed.

Playwright uses two independent Chromium contexts with synthetic camera/microphone devices. It checks direct video, UDP-only forced TURN video, TCP-only forced TURN video, decoded audio without camera capture, relay enforcement when the guest chooses it, media controls, track replacement, hangup, permission errors, and fixed desktop/mobile/narrow viewports. Selected ICE pairs and media screenshots are attached to the test results. Screen-share replacement is tested with a canvas capture stream, not the operating system's native share picker.

## Limits And Comparison

The improvements here are an integrated call workflow, a one-command app/relay setup, a visible relay-only control, short-lived credentials, and an operational UI. There is **no claim of better throughput, latency, security, or protocol coverage than coturn**.

Not implemented: IPv6/RFC 6156, TCP peer allocations/RFC 6062, even-port reservations, mobility, MESSAGE-INTEGRITY-SHA256/USERHASH, OAuth, multi-region routing, persistent account authentication, horizontal signaling scale, recording, and multi-party calls. Media is DTLS-SRTP-encrypted between browsers; TURN forwards opaque packets. The signaling server is trusted for SDP/fingerprint exchange, and participants are not cryptographically identity-verified.

Before replacing coturn in a public deployment, add independent interoperability/security review, parser fuzzing, NAT/firewall testing across real networks and browsers, abuse controls, and comparative sustained-load measurements. Current browser verification is Chromium on localhost, not certification across Safari/Firefox or hostile networks.

## Code

- [src/server/turn/protocol.ts](src/server/turn/protocol.ts): STUN framing, XOR addresses, integrity, fingerprints.
- [src/server/turn/server.ts](src/server/turn/server.ts): allocation ownership and relay data path.
- [src/server/turn/auth.ts](src/server/turn/auth.ts): credentials and nonce signatures.
- [src/server/signaling.ts](src/server/signaling.ts): bounded two-person rooms and room-wide relay policy.
- [src/server/index.ts](src/server/index.ts): listeners, APIs, production gates, static serving.
- [src/client/useCall.ts](src/client/useCall.ts): WebRTC negotiation, devices, media, stats, ICE restart.
- [src/client/App.tsx](src/client/App.tsx): the call workspace and relay console.
