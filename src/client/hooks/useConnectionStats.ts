import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { collectConnectionStats, EMPTY_STATS } from '../webrtc/stats.ts';
import type { ConnectionStats, StatsPoint, StatsSample } from '../webrtc/stats.ts';

export function useConnectionStats(connection: RefObject<RTCPeerConnection | null>, onRouteChange: (route: ConnectionStats['route']) => void) {
  const [stats, setStats] = useState<ConnectionStats>(EMPTY_STATS);
  const [history, setHistory] = useState<StatsPoint[]>([]);
  const previous = useRef<StatsSample | undefined>(undefined);
  const reportedRoute = useRef<ConnectionStats['route']>('pending');
  const routeChanged = useEffectEvent(onRouteChange);

  function resetStats() {
    previous.current = undefined;
    reportedRoute.current = 'pending';
    setStats(EMPTY_STATS);
    setHistory([]);
  }

  useEffect(() => {
    let active = true;
    let sampling = false;
    const timer = setInterval(async () => {
      const current = connection.current;
      if (!current || current.connectionState === 'closed' || sampling) return;
      sampling = true;
      try {
        const report = await current.getStats();
        if (!active || connection.current !== current) return;
        const now = Date.now();
        const result = collectConnectionStats(report, previous.current, now, {
          connectionState: current.connectionState, iceState: current.iceConnectionState,
          gatheringState: current.iceGatheringState, signalingState: current.signalingState,
        });
        previous.current = result.sample;
        setStats(result.stats);
        setHistory((points) => [...points.slice(-59), { time: now, inboundKbps: result.stats.bitrate, outboundKbps: result.stats.outboundBitrate, rttMs: result.stats.rtt }]);
        if (result.stats.route !== 'pending' && result.stats.route !== reportedRoute.current) {
          reportedRoute.current = result.stats.route;
          routeChanged(result.stats.route);
        }
      } catch {} finally { sampling = false; }
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [connection]);

  return { stats, history, resetStats };
}