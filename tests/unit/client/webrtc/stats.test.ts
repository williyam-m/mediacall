import assert from 'node:assert/strict';
import test from 'node:test';
import { collectConnectionStats } from '../../../../src/client/webrtc/stats.ts';

function report(overrides: Record<string, unknown>[] = []): RTCStatsReport {
  const entries = [
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected', dtlsState: 'connected' },
    { id: 'unused', type: 'candidate-pair', state: 'succeeded', nominated: true, bytesReceived: 999999, localCandidateId: 'host', remoteCandidateId: 'host' },
    { id: 'selected', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote', bytesSent: 12000, bytesReceived: 15000, currentRoundTripTime: 0.045, availableOutgoingBitrate: 2_500_000 },
    { id: 'local', type: 'local-candidate', candidateType: 'relay', address: '203.0.113.8', port: 55001, protocol: 'udp', relayProtocol: 'tcp', url: 'turn:relay.example.com:443?transport=tcp', relatedAddress: '192.168.1.4', relatedPort: 60000 },
    { id: 'remote', type: 'remote-candidate', candidateType: 'relay', ip: '198.51.100.8', port: 55002, protocol: 'udp' },
    { id: 'host', type: 'local-candidate', candidateType: 'host', address: '192.168.1.4', port: 12345 },
    { id: 'video-codec', type: 'codec', mimeType: 'video/VP8' },
    { id: 'audio-codec', type: 'codec', mimeType: 'audio/opus' },
    { id: 'video-in', type: 'inbound-rtp', kind: 'video', bytesReceived: 10000, packetsReceived: 98, packetsLost: 2, framesDecoded: 50, framesDropped: 3, framesPerSecond: 25, frameWidth: 1280, frameHeight: 720, codecId: 'video-codec', jitter: 0.008 },
    { id: 'audio-in', type: 'inbound-rtp', kind: 'audio', bytesReceived: 2000, packetsReceived: 50, packetsLost: 0, codecId: 'audio-codec', jitter: 0.004 },
    { id: 'video-out', type: 'outbound-rtp', kind: 'video', bytesSent: 9000, packetsSent: 80, qualityLimitationReason: 'none' },
  ];
  const values = new Map(entries.map((entry) => [entry.id, entry]));
  for (const override of overrides) values.set(String(override['id']), override as typeof entries[number]);
  return values as unknown as RTCStatsReport;
}

const states = { connectionState: 'connected', iceState: 'connected', gatheringState: 'complete', signalingState: 'stable' };

test('stats follow the transport-selected pair and retain actual relay IP, ports, URL, and transport', () => {
  const { stats } = collectConnectionStats(report(), undefined, 1000, states);
  assert.equal(stats.route, 'relay');
  assert.equal(stats.pairId, 'selected');
  assert.equal(stats.localCandidate?.address, '203.0.113.8');
  assert.equal(stats.localCandidate?.port, 55001);
  assert.equal(stats.localCandidate?.url, 'turn:relay.example.com:443?transport=tcp');
  assert.equal(stats.remoteCandidate?.address, '198.51.100.8');
  assert.equal(stats.protocol, 'TCP');
  assert.equal(stats.rtt, 45);
  assert.equal(stats.jitter, 8);
  assert.equal(stats.resolution, '1280 x 720');
  assert.equal(stats.codec, 'VP8');
  assert.equal(stats.audioCodec, 'opus');
  assert.equal(stats.bitrate, null);
  assert.equal(stats.fps, 25);
  assert.equal(stats.framesDropped, 3);
  assert.equal(stats.availableBitrate, 2500);
  assert.equal(stats.loss, 2 / 150 * 100);
});

test('stats compute kbps from RTP byte deltas and never report negative or cross-pair rates', () => {
  const previous = collectConnectionStats(report(), undefined, 1000, states).sample;
  const changed = report([
    { id: 'video-in', type: 'inbound-rtp', kind: 'video', bytesReceived: 14000, packetsReceived: 110, framesDecoded: 80 },
    { id: 'video-out', type: 'outbound-rtp', kind: 'video', bytesSent: 15000, packetsSent: 100 },
  ]);
  const next = collectConnectionStats(changed, previous, 2000, states);
  assert.equal(next.stats.bitrate, 32);
  assert.equal(next.stats.outboundBitrate, 48);
  assert.equal(next.stats.fps, 30);
  assert.equal(collectConnectionStats(report(), next.sample, 3000, states).stats.bitrate, null);
  assert.equal(collectConnectionStats(changed, { ...previous, pairId: 'another-pair' }, 2000, states).stats.outboundBitrate, null);
});

test('missing browser fields remain unavailable rather than becoming fabricated endpoint or latency values', () => {
  const { stats } = collectConnectionStats(new Map() as unknown as RTCStatsReport, undefined, 1000, states);
  assert.equal(stats.route, 'pending');
  assert.equal(stats.rtt, null);
  assert.equal(stats.jitter, null);
  assert.equal(stats.localCandidate, null);
  assert.equal(stats.remoteCandidate, null);
  assert.equal(stats.loss, null);
});