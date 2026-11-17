import { Download, Activity } from 'lucide-react';
import { IconButton } from './ui.tsx';
import { formatBytes, formatValue } from '../lib/format.ts';
import type { ConnectionStats, StatsPoint } from '../webrtc/stats.ts';

function path(values: (number | null)[], maximum: number) {
  let drawing = false;
  return values.map((value, index) => {
    if (value === null) { drawing = false; return ''; }
    const command = drawing ? 'L' : 'M';
    drawing = true;
    return `${command}${(index / 59 * 300).toFixed(1)},${(54 - Math.min(1, value / maximum) * 48).toFixed(1)}`;
  }).join(' ');
}

export function LiveStats({ stats, history, compact = false }: { stats: ConnectionStats; history: StatsPoint[]; compact?: boolean }) {
  const measured = history.flatMap((point) => [point.inboundKbps, point.outboundKbps]).filter((value): value is number => value !== null);
  const peak = measured.length ? Math.max(...measured) : null;
  const maximum = Math.max(1, peak ?? 0);
  const metric = (label: string, value: string, testId?: string) => <div key={label}><dt>{label}</dt><dd data-testid={testId}>{value}</dd></div>;
  function download() {
    const blob = new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), stats, history }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `mediacall-stats-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className={`live-stats ${compact ? 'stats-compact' : ''}`} aria-label="Live WebRTC stats" data-testid="live-stats">
    <div className="stats-heading"><h2><Activity size={15} /> Live WebRTC stats</h2><div><span className={`status-dot ${stats.connectionState === 'connected' ? 'online' : ''}`} />
      <time data-testid="stats-sample-time">{stats.timestamp ? new Date(stats.timestamp).toLocaleTimeString() : 'Not connected'}</time><IconButton label="Download stats" onClick={download}><Download size={15} /></IconButton></div></div>
    <dl className="stats-grid">
      {metric('INBOUND RTP', formatValue(stats.bitrate, 'kbps'), 'inbound-bitrate')}
      {metric('OUTBOUND RTP', formatValue(stats.outboundBitrate, 'kbps'), 'outbound-bitrate')}
      {metric('ROUND TRIP', formatValue(stats.rtt, 'ms'))}
      {metric('JITTER', formatValue(stats.jitter, 'ms', 1))}
      {metric('PACKET LOSS', formatValue(stats.loss, '%', 2))}
      {metric('VIDEO FPS', formatValue(stats.fps, 'fps', 1))}
    </dl>
    <div className="stats-chart"><div className="chart-legend"><span><i className="inbound-key" />Inbound</span><span><i className="outbound-key" />Outbound</span><span>Peak {formatValue(peak, 'kbps')}</span></div>
      <svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="RTP bitrate over the last 60 samples"><line x1="0" y1="6" x2="300" y2="6" /><line x1="0" y1="30" x2="300" y2="30" /><line x1="0" y1="54" x2="300" y2="54" />
        <path className="inbound-line" d={path(history.map((point) => point.inboundKbps), maximum)} /><path className="outbound-line" d={path(history.map((point) => point.outboundKbps), maximum)} /></svg></div>
    <dl className="stats-detail-grid">
      {metric('Received / sent', `${formatBytes(stats.bytesReceived)} / ${formatBytes(stats.bytesSent)}`)}
      {metric('Packets received / sent', `${stats.packetsReceived} / ${stats.packetsSent}`)}
      {metric('Video / audio codec', `${stats.codec} / ${stats.audioCodec}`)}
      {metric('Decoded / dropped frames', `${stats.framesDecoded} / ${stats.framesDropped}`)}
      {metric('Resolution', stats.resolution)}
      {metric('Available send bandwidth', formatValue(stats.availableBitrate, 'kbps'))}
    </dl>
  </section>;
}