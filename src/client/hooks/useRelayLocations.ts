import { useEffect, useState } from 'react';
import type { ConnectionStats } from '../webrtc/stats.ts';
import type { RelayLocation } from '../../shared/types.ts';

export function useRelayLocations(stats: ConnectionStats, accessToken: string) {
  const [locations, setLocations] = useState<Record<string, RelayLocation | null>>({});
  const addresses = [stats.localCandidate, stats.remoteCandidate].filter((candidate) => candidate?.type === 'relay').map((candidate) => candidate?.address ?? '').filter((address) => /^[a-f0-9:.]+$/i.test(address));
  const key = [...new Set(addresses)].sort().join(',');
  useEffect(() => {
    const controller = new AbortController();
    setLocations({});
    for (const address of key.split(',').filter(Boolean)) {
      fetch(`/api/network?ip=${encodeURIComponent(address)}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, signal: controller.signal, cache: 'no-store',
      }).then(async (response) => response.ok ? response.json() as Promise<RelayLocation> : null)
        .then((location) => { if (!controller.signal.aborted) setLocations((previous) => ({ ...previous, [address]: location })); })
        .catch(() => { if (!controller.signal.aborted) setLocations((previous) => ({ ...previous, [address]: null })); });
    }
    return () => controller.abort();
  }, [key, accessToken]);
  return locations;
}