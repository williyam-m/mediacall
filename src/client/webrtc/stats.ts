export interface CandidateDetails {
  id: string;
  type: string;
  address: string | null;
  port: number | null;
  protocol: string | null;
  relayProtocol: string | null;
  url: string | null;
  relatedAddress: string | null;
  relatedPort: number | null;
  networkType: string | null;
  tcpType: string | null;
  priority: number | null;
}

export interface ConnectionStats {
  timestamp: number | null;
  route: 'direct' | 'relay' | 'pending';
  protocol: string;
  rtt: number | null;
  bitrate: number | null;
  outboundBitrate: number | null;
  availableBitrate: number | null;
  loss: number | null;
  jitter: number | null;
  resolution: string;
  codec: string;
  audioCodec: string;
  fps: number | null;
  framesDecoded: number;
  framesDropped: number;
  packetsReceived: number;
  packetsSent: number;
  packetsLost: number;
  localCandidateType: string;
  remoteCandidateType: string;
  localCandidate: CandidateDetails | null;
  remoteCandidate: CandidateDetails | null;
  pairId: string | null;
  pairState: string;
  nominated: boolean;
  bytesSent: number;
  bytesReceived: number;
  connectionState: string;
  iceState: string;
  gatheringState: string;
  signalingState: string;
  dtlsState: string;
  qualityLimitation: string;
}

export interface StatsSample {
  time: number;
  inboundBytes: number;
  outboundBytes: number;
  framesDecoded: number;
  pairId: string | null;
}

export interface StatsPoint {
  time: number;
  inboundKbps: number | null;
  outboundKbps: number | null;
  rttMs: number | null;
}

export const EMPTY_STATS: ConnectionStats = {
  timestamp: null, route: 'pending', protocol: '--', rtt: null, bitrate: null, outboundBitrate: null, availableBitrate: null,
  loss: null, jitter: null, resolution: '--', codec: '--', audioCodec: '--', fps: null, framesDecoded: 0, framesDropped: 0,
  packetsReceived: 0, packetsSent: 0, packetsLost: 0, localCandidateType: '--', remoteCandidateType: '--',
  localCandidate: null, remoteCandidate: null, pairId: null, pairState: '--', nominated: false, bytesSent: 0, bytesReceived: 0,
  connectionState: 'new', iceState: 'new', gatheringState: 'new', signalingState: 'stable', dtlsState: '--', qualityLimitation: '--',
};

type Entry = Record<string, unknown> & { id: string; type: string };

function numeric(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function text(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null; }

function candidate(entry: Entry | undefined): CandidateDetails | null {
  if (!entry) return null;
  return {
    id: entry.id, type: text(entry['candidateType']) ?? '--', address: text(entry['address']) ?? text(entry['ip']), port: numeric(entry['port']),
    protocol: text(entry['protocol']), relayProtocol: text(entry['relayProtocol']), url: text(entry['url']),
    relatedAddress: text(entry['relatedAddress']), relatedPort: numeric(entry['relatedPort']), networkType: text(entry['networkType']),
    tcpType: text(entry['tcpType']), priority: numeric(entry['priority']),
  };
}

function rate(current: number, previous: number, elapsed: number): number | null {
  return elapsed > 0 && current >= previous ? (current - previous) * 8 / elapsed : null;
}

export function collectConnectionStats(
  report: RTCStatsReport,
  previous: StatsSample | undefined,
  now: number,
  states: Pick<ConnectionStats, 'connectionState' | 'iceState' | 'gatheringState' | 'signalingState'>,
): { stats: ConnectionStats; sample: StatsSample } {
  const entries = Array.from(report.values()) as Entry[];
  const transport = entries.find((entry) => entry.type === 'transport' && entry['selectedCandidatePairId'] && entry['dtlsState'] === 'connected') ??
    entries.find((entry) => entry.type === 'transport' && entry['selectedCandidatePairId']);
  const selected = transport ? report.get(String(transport['selectedCandidatePairId'])) as Entry | undefined : undefined;
  const pair = selected ?? entries.filter((entry) => entry.type === 'candidate-pair' && entry['state'] === 'succeeded' && entry['nominated'])
    .sort((left, right) => Number(right['bytesReceived'] ?? 0) - Number(left['bytesReceived'] ?? 0))[0];
  const local = candidate(pair ? report.get(String(pair['localCandidateId'])) as Entry | undefined : undefined);
  const remote = candidate(pair ? report.get(String(pair['remoteCandidateId'])) as Entry | undefined : undefined);
  let inboundBytes = 0;
  let outboundBytes = 0;
  let packetsReceived = 0;
  let packetsSent = 0;
  let packetsLost = 0;
  let framesDecoded = 0;
  let framesDropped = 0;
  let resolution = '--';
  let codec = '--';
  let audioCodec = '--';
  let fps: number | null = null;
  let jitter: number | null = null;
  let qualityLimitation = '--';
  for (const entry of entries) {
    if (entry.type === 'inbound-rtp') {
      inboundBytes += numeric(entry['bytesReceived']) ?? 0;
      packetsReceived += numeric(entry['packetsReceived']) ?? 0;
      packetsLost += Math.max(0, numeric(entry['packetsLost']) ?? 0);
      const kind = entry['kind'] ?? entry['mediaType'];
      const mimeType = text(report.get(String(entry['codecId']))?.mimeType)?.split('/')[1] ?? '--';
      if (kind === 'video') {
        framesDecoded += numeric(entry['framesDecoded']) ?? 0;
        framesDropped += numeric(entry['framesDropped']) ?? 0;
        fps = numeric(entry['framesPerSecond']) ?? fps;
        if (numeric(entry['frameWidth']) && numeric(entry['frameHeight'])) resolution = `${entry['frameWidth']} x ${entry['frameHeight']}`;
        codec = mimeType;
      } else if (kind === 'audio') audioCodec = mimeType;
      const measuredJitter = numeric(entry['jitter']);
      if (measuredJitter !== null) jitter = Math.max(jitter ?? 0, measuredJitter * 1000);
    } else if (entry.type === 'outbound-rtp' && !entry['isRemote']) {
      outboundBytes += numeric(entry['bytesSent']) ?? 0;
      packetsSent += numeric(entry['packetsSent']) ?? 0;
      if (entry['kind'] === 'video') qualityLimitation = text(entry['qualityLimitationReason']) ?? '--';
    }
  }
  const pairId = pair?.id ?? null;
  const elapsed = previous && previous.pairId === pairId ? now - previous.time : 0;
  if (fps === null && previous && elapsed > 0 && framesDecoded >= previous.framesDecoded) fps = (framesDecoded - previous.framesDecoded) * 1000 / elapsed;
  const route = pair ? local?.type === 'relay' || remote?.type === 'relay' ? 'relay' : 'direct' : 'pending';
  const rtt = numeric(pair?.['currentRoundTripTime']);
  const available = numeric(pair?.['availableOutgoingBitrate']);
  return {
    sample: { time: now, inboundBytes, outboundBytes, framesDecoded, pairId },
    stats: {
      ...EMPTY_STATS, ...states, timestamp: now, route, pairId,
      protocol: (local?.relayProtocol ?? local?.protocol ?? '--').toUpperCase(),
      rtt: rtt === null ? null : rtt * 1000,
      bitrate: previous ? rate(inboundBytes, previous.inboundBytes, elapsed) : null,
      outboundBitrate: previous ? rate(outboundBytes, previous.outboundBytes, elapsed) : null,
      availableBitrate: available === null ? null : available / 1000,
      loss: packetsReceived + packetsLost > 0 ? packetsLost / (packetsReceived + packetsLost) * 100 : null,
      jitter, resolution, codec, audioCodec, fps, framesDecoded, framesDropped, packetsReceived, packetsSent, packetsLost,
      localCandidateType: local?.type ?? '--', remoteCandidateType: remote?.type ?? '--', localCandidate: local, remoteCandidate: remote,
      pairState: text(pair?.['state']) ?? '--', nominated: pair?.['nominated'] === true,
      bytesSent: numeric(pair?.['bytesSent']) ?? 0, bytesReceived: numeric(pair?.['bytesReceived']) ?? 0,
      dtlsState: text(transport?.['dtlsState']) ?? '--', qualityLimitation,
    },
  };
}