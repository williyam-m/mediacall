# Relay And WebRTC Diagnostics

The live stats view is visible below the media controls during a call. Relay console provides a larger view, selected endpoint details, connection states, location estimates, and JSON export. Values come from browser `getStats()` or the selected relay implementation; unsupported fields are shown as unavailable.

## Sampling And Pair Selection

Sampling occurs once per second while a peer connection exists and is not closed. A sampling guard avoids overlapping getStats calls. The transport's `selectedCandidatePairId` is authoritative; when unavailable, a succeeded nominated pair is used as a fallback. Merely gathering a relay candidate does not change the displayed selected route.

Samples reset when a peer is disposed/replaced. Rate calculations reset if the selected pair changes or counters decrease. This avoids attributing an old call's traffic to a new one or displaying negative throughput.

## Metrics

| Metric | Source / meaning |
| --- | --- |
| Route | Selected local/remote candidate type; relay when either selected candidate is relay |
| Inbound RTP kbps | Delta of inbound-rtp bytesReceived times 8 divided by elapsed milliseconds |
| Outbound RTP kbps | Delta of outbound-rtp bytesSent times 8 divided by elapsed milliseconds |
| Round trip ms | Selected pair currentRoundTripTime times 1000 |
| Jitter ms | Maximum reported inbound RTP jitter times 1000 across media streams |
| Packet loss % | Nonnegative cumulative packetsLost / (packetsReceived + packetsLost) times 100 |
| Video FPS | Browser framesPerSecond, or decoded-frame delta / elapsed seconds |
| Video resolution | Inbound frameWidth x frameHeight when exposed |
| Codecs | MIME codec names referenced by inbound RTP reports |
| Decoded/dropped frames | Cumulative browser video counters |
| Session sent/received | Selected ICE pair cumulative byte counters |
| Available send bandwidth | Browser estimated availableOutgoingBitrate / 1000; not a purchased relay bandwidth quota |
| Connection states | Peer connection, ICE connection, ICE gathering, signaling, DTLS |
| Quality limit | Outbound video qualityLimitationReason when exposed |

The chart retains the latest 60 samples, approximately one minute at normal sampling cadence. It plots inbound/outbound RTP rates. Gaps/unavailable values are not invented as zero. The first rate needs a second sample. Zero traffic after two valid samples is distinct from unavailable data.

Packet loss is cumulative, not a loss measurement for only the previous second. Candidate-pair byte counters and RTP payload counters differ because they measure different layers; the UI labels them separately.

## Selected Endpoints

For local and remote candidates the console shows type, browser-exposed IP, allocated relay port, ICE protocol, client-to-TURN transport, TURN listener URL, related address/port, network/TCP type, and GeoIP metadata when available.

An allocated relay port is not the TURN listener port. For example, a browser may connect to `turn:provider:443?transport=tcp` while its media candidate is a public relay IP on an allocated UDP port. The client-to-TURN connection is TCP; the selected peer-facing candidate protocol can still be UDP.

The configured provider host is also not proof of the selected relay's IP. Inspect the selected candidate, not the config label. Browser privacy rules may omit addresses, listener URLs, or remote transport metadata; those values are explicitly not inferred.

## Location

`GET /api/network?ip=<literal-IP>` validates the literal address and uses a fixed HTTPS `ipwho.is` endpoint. It never follows a caller-supplied URL or resolves an arbitrary hostname. Private, loopback, shared, documentation, multicast, link-local, and selected reserved ranges are identified locally and not sent to the provider.

Successful lookups are cached for six hours, failures for 30 seconds; cache size and lookup request rate are bounded. Concurrent lookups for the same address share one request. The upstream call has a 3.5-second timeout and does not follow redirects. Failures do not interrupt a call.

Location is **approximate GeoIP**, not the physical location of a person or proof of a server's exact rack. The response includes source, city/region/country, timezone, organization and ASN when available. Anycast, VPNs, cloud routing, and provider databases can make it inaccurate.

Only selected **relay** IPs are looked up automatically. Exported stats can still contain browser-exposed candidate and related addresses; treat downloaded diagnostics as network information, not something to post publicly without review.

## JSON Export

The download button exports current stats, their capture timestamp, and the retained history. It does not export media, SDP, raw signaling messages, application access tokens, TURN passwords, or provider signing keys.

## Proving A Force TURN Demo

1. Select Force TURN before starting the call.
2. Join with a second browser/device and confirm media flows both directions.
3. Verify relay-only policy and `relay / relay` selected candidates on both peers.
4. Verify nonzero and increasing sent/received byte counters, RTP rates and decoded frames.
5. Inspect actual allocated IPs/ports and, optionally, GeoIP organization/location.

Test relay only checks authenticated allocation/candidate gathering. It does not replace the two-peer media proof.