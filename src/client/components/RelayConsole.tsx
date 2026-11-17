import { Copy, FlaskConical, Server } from 'lucide-react';
import { IconButton, Modal } from './ui.tsx';
import { LiveStats } from './LiveStats.tsx';
import { useRelayLocations } from '../hooks/useRelayLocations.ts';
import { formatBytes, formatDuration } from '../lib/format.ts';
import type { Workspace } from '../hooks/useWorkspace.ts';
import type { CandidateDetails } from '../webrtc/stats.ts';
import type { RelayLocation } from '../../shared/types.ts';

function Endpoint({ label, candidate, location, side }: { label: string; candidate: CandidateDetails | null; location: RelayLocation | null | undefined; side: 'local' | 'remote' }) {
  const address = candidate?.address;
  const endpoint = address ? `${address.includes(':') ? `[${address}]` : address}${candidate.port ? `:${candidate.port}` : ''}` : '--';
  const place = location?.status === 'private' ? 'Local / reserved address' : location?.status === 'located' ? [location.city, location.region, location.country].filter(Boolean).join(', ') || 'Unavailable' :
    candidate?.type !== 'relay' ? 'Not a relay candidate' : location === undefined && address ? 'Looking up...' : 'Unavailable';
  return <section className="endpoint-section" aria-label={label}>
    <div className="endpoint-heading"><h4>{label}</h4><span className="candidate-kind">{candidate?.type ?? '--'}</span><IconButton label={`Copy ${side} relay endpoint`} disabled={!address} onClick={() => { navigator.clipboard.writeText(endpoint).catch(() => {}); }}><Copy size={14} /></IconButton></div>
    <code className="endpoint-address" data-testid={`${side}-relay-address`}>{address ?? 'Not disclosed by browser'}</code>
    <dl className="endpoint-fields"><div><dt>Allocated port</dt><dd data-testid={`${side}-relay-port`}>{candidate?.port ?? '--'}</dd></div><div><dt>ICE protocol</dt><dd>{candidate?.protocol?.toUpperCase() ?? '--'}</dd></div>
      <div><dt>Client to TURN</dt><dd>{candidate?.relayProtocol?.toUpperCase() ?? '--'}</dd></div><div><dt>Network / TCP</dt><dd>{candidate?.networkType ?? '--'} / {candidate?.tcpType ?? '--'}</dd></div>
      <div className="endpoint-wide"><dt>TURN listener URL</dt><dd><code>{candidate?.url ?? 'Not disclosed by browser'}</code></dd></div>
      <div className="endpoint-wide"><dt>Approximate IP location</dt><dd data-testid={`${side}-relay-location`}>{place}</dd></div>
      <div className="endpoint-wide"><dt>Network organization</dt><dd>{location?.organization ?? '--'}{location?.asn ? ` (AS${location.asn})` : ''}</dd></div>
      <div><dt>Related address</dt><dd>{candidate?.relatedAddress ?? '--'}</dd></div><div><dt>Related port</dt><dd>{candidate?.relatedPort ?? '--'}</dd></div>
    </dl>
    {location?.source && <div className="location-source">GeoIP: {location.source} <span>/</span> {location.timezone ?? '--'}</div>}
  </section>;
}

export function RelayConsole({ workspace }: { workspace: Workspace }) {
  const { call, config, relay, providerName, providerVersion, selectedPolicy, route, accessToken, probeRelay, probeState, probeResult, setConsoleOpen } = workspace;
  const locations = useRelayLocations(call.stats, accessToken);
  return <Modal title="Relay console" onClose={() => setConsoleOpen(false)} wide>
    <div className="console-server"><span className="relay-symbol"><Server size={22} /></span><div><h3>{providerName}</h3><span>{config?.relay?.managed ? 'Managed service' : `Version ${providerVersion}`} <span className="footer-divider">/</span> {call.stats.protocol}</span></div><span className="experimental-tag">{config?.relay?.managed ? 'Managed' : 'Experimental'}</span></div>
    <div className="console-metrics"><div><span>{config?.relay?.managed ? 'ICE POLICY' : 'ACTIVE ALLOCATIONS'}</span><strong>{config?.relay?.managed ? selectedPolicy === 'relay' ? 'Relay only' : 'Automatic' : <>{relay?.activeAllocations ?? '--'}<small> / {relay?.maxAllocations ?? '--'}</small></>}</strong></div>
      <div><span>SESSION SENT</span><strong>{formatBytes(call.stats.bytesSent)}</strong></div><div><span>SESSION RECEIVED</span><strong>{formatBytes(call.stats.bytesReceived)}</strong></div></div>
    <div className="console-section"><h3>Selected ICE connection</h3><div className="console-connection"><span>Route<strong>{route}</strong></span><span>Candidate pair<strong data-testid="ice-candidate-pair">{call.stats.localCandidateType} / {call.stats.remoteCandidateType}</strong></span><span>ICE policy<strong>{selectedPolicy === 'relay' ? 'Relay only' : 'All candidates'}</strong></span><span>Pair state<strong>{call.stats.pairState}{call.stats.nominated ? ' / nominated' : ''}</strong></span></div></div>
    <div className="relay-endpoints"><Endpoint label="Local relay endpoint" side="local" candidate={call.stats.localCandidate} location={call.stats.localCandidate?.address ? locations[call.stats.localCandidate.address] : null} />
      <Endpoint label="Remote relay endpoint" side="remote" candidate={call.stats.remoteCandidate} location={call.stats.remoteCandidate?.address ? locations[call.stats.remoteCandidate.address] : null} /></div>
    <LiveStats stats={call.stats} history={call.history} compact />
    <div className="console-section"><h3>Connection states</h3><dl className="state-grid"><div><dt>Peer connection</dt><dd>{call.stats.connectionState}</dd></div><div><dt>ICE</dt><dd>{call.stats.iceState}</dd></div><div><dt>ICE gathering</dt><dd>{call.stats.gatheringState}</dd></div><div><dt>Signaling</dt><dd>{call.stats.signalingState}</dd></div><div><dt>DTLS</dt><dd>{call.stats.dtlsState}</dd></div><div><dt>Quality limit</dt><dd>{call.stats.qualityLimitation}</dd></div></dl></div>
    <div className="console-section"><h3>Configured listeners</h3>{config?.turnUrls.length ? config.turnUrls.map((url) => <div className="listener-row" key={url}><span className="status-dot online" /><code>{url}</code><span>{url.startsWith('turns:') ? 'TLS' : url.endsWith('tcp') ? 'TCP' : 'UDP'}</span></div>) : <div className="listener-row"><code>{config?.relay?.host ?? '--'}</code><span>Managed</span></div>}</div>
    <div className="console-section"><h3>Session activity</h3><div className="activity-list">{call.events.map((entry) => <div key={entry.id}><span className="activity-point" /><span>{entry.text}</span><time>{new Date(entry.time).toLocaleTimeString()}</time></div>)}</div></div>
    <div className="console-bottom"><span>UPTIME <strong>{relay ? formatDuration(relay.uptimeSeconds) : '--'}</strong> <span className="footer-divider">/</span> DROPPED <strong>{relay?.dropped ?? '--'}</strong></span><button className="text-button" onClick={probeRelay} disabled={probeState === 'testing'}><FlaskConical size={16} />{probeState === 'testing' ? 'Testing...' : 'Test allocation'}</button></div>
    {probeResult && <div className={`probe-result ${probeState}`} role="status"><span>{probeState === 'success' ? 'Relay allocated' : 'Allocation failed'}</span><code>{probeResult}</code></div>}
  </Modal>;
}