# Technical Documentation

Live application: **https://mediacall-six.vercel.app**.

| Document | Scope |
| --- | --- |
| [Architecture](architecture.md) | Module boundaries, runtime modes, trust boundaries, data ownership |
| [Call Flow](call-flow.md) | Signaling, SDP negotiation, ICE, media, relay-only behavior, cleanup |
| [custom-turn](custom-turn.md) | Packet handling, authentication, allocation, address mapping, permissions, channels, expiry |
| [Deployment](deployment.md) | CLI, environment variables, Vercel, self-hosting, ports, troubleshooting |
| [Diagnostics](diagnostics.md) | Live stats definitions, selected relay endpoints, GeoIP, export and privacy |
| [API And Security](api-and-security.md) | HTTP and signaling contracts, credential handling, validation, limitations |
| [Testing](testing.md) | Unit, socket, browser, and real public deployment verification |

The public demo uses Metered Open Relay. It does not run the repository's `custom-turn` UDP server inside Vercel. Local startup can select either provider.