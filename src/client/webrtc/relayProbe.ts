import { fetchIce } from '../services/callApi.ts';
import { createSignalingConnection } from '../signaling/connection.ts';
import type { SignalingConnection } from '../signaling/connection.ts';
import type { ClientSignal, ServerSignal } from '../../shared/types.ts';

export async function testRelay(accessToken: string) {
  const ice = await fetchIce(accessToken);
  let signaling: SignalingConnection | undefined;
  let probe: RTCPeerConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (ice.signalingTransport === 'metered') {
      signaling = createSignalingConnection(ice);
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Managed relay setup timed out. Check the signing key and TURN injection setting.')), 12_000);
        signaling!.onopen = () => signaling!.send(JSON.stringify({ type: 'join', roomId: crypto.randomUUID().replaceAll('-', ''), name: 'Relay probe', mode: 'relay', accessToken } satisfies ClientSignal));
        signaling!.onmessage = (event) => {
          const message = JSON.parse(event.data) as ServerSignal;
          if (message.type === 'joined') { clearTimeout(timer); resolve(); }
          else if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
        };
        signaling!.onerror = signaling!.onclose = () => { clearTimeout(timer); reject(new Error('Unable to connect to managed signaling.')); };
      });
    }
    const currentProbe = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: 'relay' });
    probe = currentProbe;
    const result = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('No relay candidate. Check the TURN host, credentials, and firewall.')), 10_000);
      currentProbe.onicecandidate = (event) => {
        if (event.candidate?.type === 'relay') {
          clearTimeout(timer);
          resolve(`${event.candidate.address}:${event.candidate.port} / ${event.candidate.protocol?.toUpperCase() ?? 'UDP'}`);
        }
      };
    });
    currentProbe.createDataChannel('allocation-test');
    await currentProbe.setLocalDescription(await currentProbe.createOffer());
    return await result;
  } finally { if (timer) clearTimeout(timer); probe?.close(); signaling?.close(); }
}