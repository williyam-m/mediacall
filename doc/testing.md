# Testing And Verification

All tests live under `tests/`; production source contains no test modules.

```text
tests/
  unit/client/webrtc/       Pure selected-pair and stats calculations
  unit/server/config/      CLI defaults, validation, interactive and spawned startup
  unit/server/custom-turn/ Protocol vectors, auth, UDP/TCP/TLS socket lifecycle
  unit/server/hosted/       Provider adapters, HTTP APIs, proxy and SQL room behavior
  unit/server/network/      Relay location validation, caching and safe failures
  unit/server/signaling/    Local room membership and production HTTP startup
  e2e/                     Local reproducible browser/media regressions
  live/                    Actual deployed Vercel/provider smoke tests
```

## Commands

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:call
npm run test:live
```

Node 22.18+ runs erasable TypeScript directly. Unit tests use Node's test runner. OpenSSL is needed to generate ephemeral TLS fixtures, not to create a committed private key. PGlite runs PostgreSQL behavior in isolation for SQL signaling tests.

`npm run test:call` starts/reuses the local app and uses two independent Chromium contexts with synthetic camera/microphone devices. It does not require production credentials or a paid provider account. Unit tests and browser tests may be run independently.

## Coverage

- RFC 5769 STUN integrity and fingerprint vector, XOR address round trips, malformed lengths/padding.
- Credential expiry, signed/stale/forged nonces, access token comparison and quotas.
- Actual UDP, TCP, and TLS allocation/permission/channel/refresh/delete flows with real sockets.
- Forbidden peers, unsigned parameters, unsupported transport, unknown attributes, retransmission and quota behavior.
- Two-person membership, Force TURN strongest-wins policy, SQL compare-and-swap races and expiry.
- Server-side provider key handling, allowed domain checks, scoped token requests and sanitized failures.
- CLI/provider precedence, interactive non-secret configuration and real spawned Metered-mode startup.
- Stats selected-pair selection, byte deltas, missing fields, counter resets and media details.
- GeoIP fixed upstream, literal-IP validation, private-address skip, caching and unavailable responses.
- Browser direct video, forced UDP/TCP relay video, audio-only media, mute/camera/share/hangup, error recovery UI and responsive layouts.
- Managed SDK TURN injection, relay candidate proof, live sample updates, allocated endpoint metadata, credential-free JSON export, and long-dialog scrolling on mobile.

The direct-route fixture deliberately offers no TURN servers and disables mDNS host obfuscation in test Chromium to make local candidate discovery reproducible. Production Automatic ICE still offers all configured candidates and may legitimately choose TURN. Test-only browser flags are not shipped to users.

The native OS screen picker is not automated; screen track replacement is tested with canvas capture. Current automation is Chromium, not cross-browser certification.

## Public Deployment Tests

The live suite targets **https://mediacall-six.vercel.app** by default and has no local web-server dependency. It verifies:

1. Hosted Metered config and Automatic default.
2. Real provider authenticated relay allocation.
3. Two-browser calls in Automatic and explicit Force TURN modes, with decoded video and received audio samples.
4. `relay / relay` and relay-only policy for the forced case, plus nonzero bidirectional traffic.
5. Selected relay IP/port, approximate-location API, updating bitrate samples, mobile dialog layout and hangup.

```sh
LIVE_BASE_URL=https://your-deployment.example npm run test:live
```

The live suite consumes real provider connections, signaling messages and a small amount of relay bandwidth. Run it intentionally against the intended deployment. It does not log or export tokens/passwords as test evidence. Raw Playwright traces may capture network traffic and must remain ignored/private.

Screenshots, selected-pair proof JSON, and location responses are written under ignored `test-results/`. A successful local fixture test is not a substitute for a successful real provider call. Two contexts on one machine exercise the public relay but do not certify every NAT/firewall or two separate physical networks.