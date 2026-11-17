# Deployment And Startup

Live demo: **https://mediacall-six.vercel.app**. Runtime requirement: Node.js **22.18+**, npm, and a browser supporting WebRTC. Non-localhost camera/microphone access requires HTTPS.

## Local custom-turn

```sh
npm ci
npm run dev -- --turn custom-turn
```

Defaults are HTTP `5180`, TURN UDP/TCP `3490`, loopback relay address, UDP allocation range `49160-49259`, and Automatic ICE. Open **http://localhost:5180**. Two browsers on that machine can test the custom relay. A localhost URL is not usable from a judge's remote device.

## Local Metered Open Relay

Put provider variables directly into an ignored `.env` file using your editor or a secret manager, never chat or command-line arguments:

```dotenv
METERED_REALTIME_KEY_ID=sk_id_your_new_key_id
METERED_REALTIME_SECRET=sk_secret_your_new_signing_secret
METERED_CHANNEL_PREFIX=mediacall/
```

Those are placeholders, not functional credentials. Then run:

```sh
npm run dev -- --turn metered
```

This mode uses the same managed signaling/hosted relay path as Vercel and does not open custom-turn listeners. Alternatively, `METERED_DOMAIN` plus `METERED_API_KEY` selects provider TURN REST credentials with local WebSocket signaling.

## CLI

```sh
npm run dev -- --help
npm run dev -- --configure
npm run dev -- --turn custom-turn --port 5190 --ice auto
npm run dev -- --turn custom-turn --turn-public-ip 192.168.1.50 --turn-bind-ip 0.0.0.0
npm run dev -- --turn custom-turn --turn-port 3500 --relay-min-port 50000 --relay-max-port 50050
npm run dev -- --turn metered --ice relay
```

Use the machine's actual LAN IP in the LAN example. Interactive setup asks only non-secret provider, HTTP port, initial ICE policy, and relevant custom-turn address/port settings. Empty answers retain the displayed defaults. Scripts/CI should pass flags; `--configure` requires a terminal. Flags override their corresponding environment variables. `TURN_PROVIDER` and `ICE_MODE` can set defaults without flags.

`--ice relay` changes the initial selection only. In all modes, the call's effective policy respects either participant requesting Force TURN. Hosted production config defaults to Automatic.

## Vercel

1. Create a free Metered account: **https://dashboard.metered.ca/signup?tool=turnserver**.
2. Under Realtime Messaging / API Keys, create a **Secret** key. Allow `mediacall/*`, `publish`, `subscribe`, and `presence`; enable automatic TURN injection. The adapter uses channel-scoped publishing, not unrestricted direct-send.
3. Set the following in the Vercel project's Production environment. Never use `VITE_` variables for secrets.

| Variable | Requirement |
| --- | --- |
| `CALL_BACKEND=hosted` | Select managed backend routing |
| `METERED_REALTIME_KEY_ID` | Provider key ID |
| `METERED_REALTIME_SECRET` | Sensitive provider signing secret |
| `METERED_CHANNEL_PREFIX` | Optional, `mediacall/` by default; must match key scope |
| `APP_ACCESS_TOKEN` | Optional shared call-entry gate |
| `APP_ORIGIN` | Optional exact frontend origin for POST checks; otherwise same-host validation |

```sh
npm ci
npm run build
npx vercel login
npx vercel --prod --scope williyam
npm run test:live
```

The project is `williyam/mediacall`; [vercel.json](../vercel.json) selects Vite output `dist/client` and the API entry [api/[...path].ts](../api/%5B...path%5D.ts). This profile needs no public VM, open router ports, Neon database, TURN REST app domain, local tunnel, or always-on laptop. Check current provider dashboard free quotas; the app does not provision paid plans or auto-upgrades.

Environment changes require redeployment. The GitHub remote is **https://github.com/williyam-m/mediacall**; CLI deployment is independent of whether Vercel's automatic GitHub integration is linked.

## Self-Hosted Production custom-turn

```sh
npm run build
npm start -- --turn custom-turn
```

Set a public relay IPv4, a local bind interface, `TURN_SECRET` with at least 32 random characters, and `APP_ACCESS_TOKEN` with at least 24 characters. Production rejects missing unsafe values unless anonymous credential issuance is explicitly opted into with `ALLOW_ANONYMOUS=true`; that opt-in is not recommended on an open Internet relay.

Terminate web HTTPS with a reverse proxy preserving Host and WebSocket upgrades for `/signal`. Native TURN TLS is a separate listener requiring a trusted matching certificate. A reverse proxy's HTTPS certificate does not automatically configure TURN TLS.

| Port | Protocol | Purpose |
| --- | --- | --- |
| 443 | TCP | Web HTTPS/WSS reverse proxy |
| 3478 or TURN_PORT | UDP and TCP | Production STUN/TURN listener |
| 5349 or TURN_TLS_PORT | TCP | Optional native TURN TLS |
| TURN_MIN_PORT..TURN_MAX_PORT | UDP | Per-allocation relay sockets |

If behind NAT, map every allocated UDP port consistently to the server. `TURN_PUBLIC_IP` is an advertisement, not an automatic port-forward configuration. Mobile hotspots/carrier-grade NAT may prevent inbound UDP. An ngrok/Cloudflare HTTPS tunnel exposes web/signaling, not custom-turn's UDP allocations.

## Environment Reference

| Variable | Default / purpose |
| --- | --- |
| PORT, HOST | 5180, 0.0.0.0 web binding |
| TURN_PROVIDER, ICE_MODE | custom-turn, auto local defaults |
| TURN_PUBLIC_IP | 127.0.0.1 in local custom mode |
| TURN_BIND_IP | loopback for localhost; otherwise 0.0.0.0 |
| TURN_RELAY_BIND_IP | local allocation interface; listener binding by default |
| TURN_HOST | hostname advertised in ICE URLs; public relay IP by default |
| TURN_PORT | 3490 development, 3478 production |
| TURN_REALM | mediacall |
| TURN_MIN_PORT, TURN_MAX_PORT | 49160, 49259 |
| TURN_MAX_ALLOCATIONS | 128, additionally clamped to port-range capacity |
| TURN_MAX_ALLOCATIONS_PER_IP | 8 |
| TURN_BYTES_PER_SECOND | 2000000 shared allocation bucket |
| TURN_CREDENTIAL_TTL | 3600, allowed 60..86400 seconds |
| TURN_ALLOW_PRIVATE_PEERS | true development; false production unless explicitly set |
| TURN_SECRET | ephemeral development secret; explicit production secret |
| TURN_TLS_CERT, TURN_TLS_KEY | PEM file paths; configure both or neither |
| TURN_TLS_PORT | 5349 |
| APP_ACCESS_TOKEN | optional local/hosted gate; production custom mode requires it unless anonymous opt-in |
| APP_ORIGIN | exact allowed frontend origin, optional |
| ALLOW_ANONYMOUS | production custom credential-issuance opt-in |
| METERED_REALTIME_KEY_ID, METERED_REALTIME_SECRET | recommended hosted signaling credentials |
| METERED_CHANNEL_PREFIX | mediacall/ |
| METERED_DOMAIN, METERED_API_KEY | alternate Metered TURN REST configuration |
| DATABASE_URL or POSTGRES_URL | alternate hosted HTTP/SQL signaling; not needed by managed SDK mode |
| BACKEND_URL | alternate fixed external HTTPS backend origin |
| LIVE_BASE_URL | optional public test target override |

## Troubleshooting

- Missing-key error: check server-side Production variable names and redeploy; never inspect/log raw values to debug.
- No relay candidate: verify TURN injection, account quotas, allowed provider key channel/actions, and UDP/TCP/TLS network reachability.
- Allocated but no media: check both selected candidates and actual byte/frame counters, not just the allocation probe.
- Address/URL unavailable: browsers may redact them; this is not proof the relay is down.
- Location unavailable: GeoIP failure is nonfatal. The actual candidate IP/port remains visible.
- Local port busy: select another HTTP/TURN port; do not kill an unrelated process or SSH forward.
- Permission denied: check browser camera/microphone permissions and HTTPS; try audio-only when no camera exists.
- One-hour managed call disconnect: rejoin to obtain a new provider token.