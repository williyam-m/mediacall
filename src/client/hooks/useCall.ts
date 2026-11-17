import { useEffect, useRef, useState } from 'react';
import type { CallMode, ClientSignal, IceConfig, MediaState, PeerInfo, ServerSignal } from '../../shared/types.ts';
import { createSignalingConnection } from '../signaling/connection.ts';
import type { SignalingConnection } from '../signaling/connection.ts';
import { useAudioLevel } from './useAudioLevel.ts';
import { useConnectionStats } from './useConnectionStats.ts';
import { fetchIce } from '../services/callApi.ts';
import { mediaError } from '../media/errors.ts';
import { testRelay } from '../webrtc/relayProbe.ts';
export type { ConnectionStats } from '../webrtc/stats.ts';

export type CallStatus = 'idle' | 'preparing' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error';

interface StartOptions {
  roomId: string;
  name: string;
  mode: CallMode;
  video: boolean;
  accessToken: string;
}

interface Session {
  ice: IceConfig;
  mode: CallMode;
  polite: boolean;
  token: string;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  restarts: number;
}

export function useCall() {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);
  const [peer, setPeer] = useState<PeerInfo | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [mode, setMode] = useState<CallMode>('auto');
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [isSharing, setIsSharing] = useState(false);
  const level = useAudioLevel(localStream);
  const remoteLevel = useAudioLevel(remoteStream);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [events, setEvents] = useState<{ id: string; time: number; text: string }[]>([]);
  const local = useRef<MediaStream | null>(null);
  const display = useRef<MediaStream | null>(null);
  const connection = useRef<RTCPeerConnection | null>(null);
  const socket = useRef<SignalingConnection | null>(null);
  const session = useRef<Session | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const localMedia = useRef<MediaState>({ audio: true, video: true, sharing: false });
  const selectedDevices = useRef({ audio: '', video: '' });
  const generation = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { stats, history, resetStats } = useConnectionStats(connection, (route) => log(route === 'relay' ? 'Media routed through TURN relay' : 'Direct peer connection selected'));

  function log(text: string) {
    setEvents((entries) => [...entries.slice(-7), { id: crypto.randomUUID(), time: Date.now(), text }]);
  }

  function send(message: ClientSignal) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }

  function publishMedia() { send({ type: 'media', media: { ...localMedia.current } }); }

  async function refreshDevices() {
    if (navigator.mediaDevices) setDevices(await navigator.mediaDevices.enumerateDevices());
  }

  async function acquire(video: boolean, currentGeneration: number) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone access requires HTTPS or localhost.');
    if (local.current?.getAudioTracks().some((track) => track.readyState === 'live') &&
      (!video || local.current.getVideoTracks().some((track) => track.readyState === 'live'))) return local.current;
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(selectedDevices.current.audio ? { deviceId: { exact: selectedDevices.current.audio } } : {}),
      },
      video: video ? {
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
        ...(selectedDevices.current.video ? { deviceId: { exact: selectedDevices.current.video } } : {}),
      } : false,
    });
    if (generation.current !== currentGeneration) {
      captured.getTracks().forEach((track) => track.stop());
      throw new Error('Call cancelled.');
    }
    const old = local.current;
    for (const track of captured.getTracks()) track.enabled = track.kind === 'audio' ? localMedia.current.audio : localMedia.current.video;
    local.current = captured;
    setLocalStream(captured);
    old?.getTracks().forEach((track) => track.stop());
    await refreshDevices();
    return captured;
  }

  function closePeer() {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    const previous = connection.current;
    connection.current = null;
    previous?.close();
    pendingIce.current = [];
    setRemoteStream(null);
    resetStats();
  }

  function closeSession() {
    const previous = socket.current;
    socket.current = null;
    previous?.close();
    closePeer();
    session.current = null;
    setPeer(null);
    setRoomId(null);
  }

  function releaseMedia() {
    const sharing = display.current;
    display.current = null;
    sharing?.getTracks().forEach((track) => track.stop());
    local.current?.getTracks().forEach((track) => track.stop());
    local.current = null;
    localMedia.current.sharing = false;
    setLocalStream(null);
    setDisplayStream(null);
    setIsSharing(false);
  }

  function fail(cause: unknown) {
    generation.current++;
    closeSession();
    releaseMedia();
    setError(mediaError(cause));
    setStatus('error');
    log('Call interrupted');
  }

  async function offer(iceRestart = false) {
    const current = connection.current;
    const active = session.current;
    if (!current || !active || current.signalingState !== 'stable') return;
    try {
      active.makingOffer = true;
      await current.setLocalDescription(await current.createOffer({ iceRestart }));
      if (connection.current === current && current.localDescription) send({ type: 'description', description: current.localDescription.toJSON() });
    } finally { active.makingOffer = false; }
  }

  async function reconnect() {
    const current = connection.current;
    const active = session.current;
    if (!current || !active) return;
    setError(null);
    setStatus('reconnecting');
    const refreshed = await fetchIce(active.token);
    if (refreshed.signalingTransport === 'metered' && !refreshed.iceServers.length) refreshed.iceServers = active.ice.iceServers;
    active.ice = refreshed;
    if (connection.current !== current) return;
    current.setConfiguration({ iceServers: active.ice.iceServers, iceTransportPolicy: active.mode === 'relay' ? 'relay' : 'all' });
    await offer(true);
    log('ICE restart requested');
  }

  async function attachTracks(current: RTCPeerConnection) {
    for (const transceiver of current.getTransceivers()) {
      const kind = transceiver.receiver.track.kind;
      const track = kind === 'video' && display.current ? display.current.getVideoTracks()[0] : local.current?.getTracks().find((entry) => entry.kind === kind);
      transceiver.direction = 'sendrecv';
      transceiver.sender.setStreams(...(local.current ? [local.current] : []));
      await transceiver.sender.replaceTrack(track ?? null);
    }
  }

  async function createPeer() {
    const active = session.current;
    if (!active) throw new Error('Missing call configuration.');
    closePeer();
    const current = new RTCPeerConnection({ iceServers: active.ice.iceServers, iceTransportPolicy: active.mode === 'relay' ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
    connection.current = current;
    if (!active.polite) {
      for (const kind of ['audio', 'video'] as const) current.addTransceiver(kind, { direction: 'sendrecv' });
      await attachTracks(current);
    }
    const incoming = new MediaStream();
    current.ontrack = (event) => {
      if (connection.current !== current) return;
      incoming.addTrack(event.track);
      setRemoteStream(new MediaStream(incoming.getTracks()));
    };
    current.onicecandidate = (event) => {
      if (connection.current === current && event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    current.onconnectionstatechange = () => {
      if (connection.current !== current) return;
      if (current.connectionState === 'connected') {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        active.restarts = 0;
        setStatus('connected');
        setError(null);
        setStartedAt((previous) => previous ?? Date.now());
        log('Encrypted media connected');
      } else if (['disconnected', 'failed'].includes(current.connectionState)) {
        setStatus('reconnecting');
        if (!active.polite && !retryTimer.current && active.restarts < 3) {
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            active.restarts++;
            reconnect().catch((cause: unknown) => setError(mediaError(cause)));
          }, 4000);
        } else if (current.connectionState === 'failed') {
          setError('The media connection failed. Reconnect or rejoin the call.');
        }
      }
    };
    setStatus('connecting');
    publishMedia();
    return current;
  }

  async function handle(message: ServerSignal) {
    if (message.type === 'error') throw new Error(message.message);
    if (message.type === 'joined') {
      const active = session.current!;
      active.mode = message.mode;
      active.polite = message.peers.length > 0;
      setMode(message.mode);
      setRoomId(message.roomId);
      log(message.mode === 'relay' ? 'Room joined with relay-only policy' : 'Room joined with automatic routing');
      publishMedia();
      if (message.peers[0]) { setPeer(message.peers[0]); await createPeer(); }
      else setStatus('waiting');
    } else if (message.type === 'peer-joined') {
      setPeer(message.peer);
      session.current!.polite = false;
      session.current!.mode = message.mode;
      setMode(message.mode);
      log(`${message.peer.name} joined`);
      await createPeer();
      await offer();
    } else if (message.type === 'peer-left') {
      closePeer();
      setPeer(null);
      setStartedAt(null);
      setStatus('waiting');
      log('Guest left the room');
    } else if (message.type === 'media') {
      setPeer((previous) => previous ? { ...previous, media: message.media } : null);
    } else if (message.type === 'ice') {
      const current = connection.current;
      if (!current?.remoteDescription) {
        if (pendingIce.current.length < 256) pendingIce.current.push(message.candidate);
      } else {
        try { await current.addIceCandidate(message.candidate); } catch (cause) { if (!session.current?.ignoreOffer) throw cause; }
      }
    } else if (message.type === 'description') {
      const current = connection.current ?? await createPeer();
      const active = session.current!;
      const ready = !active.makingOffer && (current.signalingState === 'stable' || active.settingAnswer);
      active.ignoreOffer = !active.polite && message.description.type === 'offer' && !ready;
      if (active.ignoreOffer) return;
      active.settingAnswer = message.description.type === 'answer';
      await current.setRemoteDescription(message.description);
      active.settingAnswer = false;
      for (const candidate of pendingIce.current.splice(0)) await current.addIceCandidate(candidate);
      if (message.description.type === 'offer') {
        await attachTracks(current);
        await current.setLocalDescription(await current.createAnswer());
        send({ type: 'description', description: current.localDescription!.toJSON() });
      }
    }
  }

  async function start(options: StartOptions) {
    const currentGeneration = ++generation.current;
    closeSession();
    setError(null);
    setStartedAt(null);
    setEvents([]);
    setStatus('preparing');
    try {
      localMedia.current.video = options.video && cameraEnabled;
      setCameraEnabled(localMedia.current.video);
      await acquire(localMedia.current.video, currentGeneration);
      const ice = await fetchIce(options.accessToken);
      if (generation.current !== currentGeneration) return;
      session.current = { ice, mode: options.mode, polite: false, token: options.accessToken, makingOffer: false, ignoreOffer: false, settingAnswer: false, restarts: 0 };
      const websocket = createSignalingConnection(ice);
      socket.current = websocket;
      let queue = Promise.resolve();
      const joinTimeout = setTimeout(() => { if (socket.current === websocket) fail(new Error('Signaling timed out. Check the server connection.')); }, 12_000);
      websocket.onopen = () => { send({ type: 'join', ...options }); };
      websocket.onmessage = (event) => {
        if (socket.current !== websocket) return;
        clearTimeout(joinTimeout);
        queue = queue.then(async () => {
          if (socket.current === websocket) await handle(JSON.parse(event.data) as ServerSignal);
        }).catch((cause: unknown) => { if (socket.current === websocket) fail(cause); });
      };
      websocket.onclose = () => {
        clearTimeout(joinTimeout);
        if (socket.current === websocket) fail(new Error('The signaling connection closed. Rejoin to reconnect.'));
      };
      websocket.onerror = () => { if (socket.current === websocket) fail(new Error('Unable to reach the signaling server.')); };
    } catch (cause) {
      if (generation.current === currentGeneration) fail(cause);
    }
  }

  function hangup() {
    generation.current++;
    send({ type: 'leave' });
    closeSession();
    releaseMedia();
    setStatus('ended');
    setError(null);
    setStartedAt(null);
    log('Call ended');
  }

  async function preview(video = true) {
    setError(null);
    if (video) { localMedia.current.video = true; setCameraEnabled(true); }
    try { await acquire(video, generation.current); } catch (cause) { setError(mediaError(cause)); }
  }

  function toggleMic() {
    localMedia.current.audio = !localMedia.current.audio;
    local.current?.getAudioTracks().forEach((track) => { track.enabled = localMedia.current.audio; });
    setMicEnabled(localMedia.current.audio);
    publishMedia();
  }

  async function toggleCamera() {
    if (!local.current) { await preview(true); return; }
    const enabled = !localMedia.current.video;
    if (enabled && !local.current?.getVideoTracks().some((track) => track.readyState === 'live')) {
      try {
        await switchDevice('video', selectedDevices.current.video);
      } catch (cause) { setError(mediaError(cause)); return; }
    }
    localMedia.current.video = enabled;
    local.current?.getVideoTracks().forEach((track) => { track.enabled = enabled; });
    setCameraEnabled(enabled);
    publishMedia();
  }

  async function switchDevice(kind: 'audio' | 'video', deviceId: string) {
    if (!navigator.mediaDevices) throw new Error('Media devices are unavailable.');
    selectedDevices.current[kind] = deviceId;
    if (!local.current) return;
    const currentGeneration = generation.current;
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'audio' ? { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true } : false,
      video: kind === 'video' ? { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    const track = captured.getTracks()[0]!;
    if (generation.current !== currentGeneration) { captured.getTracks().forEach((entry) => entry.stop()); return; }
    track.enabled = kind === 'audio' ? localMedia.current.audio : localMedia.current.video;
    const sender = connection.current?.getTransceivers().find((entry) => entry.receiver.track.kind === kind)?.sender;
    try { if (sender && !(kind === 'video' && display.current)) await sender.replaceTrack(track); }
    catch (cause) { track.stop(); throw cause; }
    const old = local.current.getTracks().filter((entry) => entry.kind === kind);
    const stream = new MediaStream([...local.current.getTracks().filter((entry) => entry.kind !== kind), track]);
    local.current = stream;
    setLocalStream(stream);
    old.forEach((entry) => entry.stop());
    await refreshDevices();
  }

  async function stopSharing() {
    const sharing = display.current;
    if (!sharing) return;
    display.current = null;
    const sender = connection.current?.getTransceivers().find((entry) => entry.receiver.track.kind === 'video')?.sender;
    await sender?.replaceTrack(local.current?.getVideoTracks()[0] ?? null);
    sharing.getTracks().forEach((track) => track.stop());
    localMedia.current.sharing = false;
    setDisplayStream(null);
    setIsSharing(false);
    publishMedia();
    log('Screen sharing stopped');
  }

  async function toggleSharing() {
    try {
      if (display.current) { await stopSharing(); return; }
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser.');
      const currentGeneration = generation.current;
      const captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 15 } }, audio: false });
      const sender = connection.current?.getTransceivers().find((entry) => entry.receiver.track.kind === 'video')?.sender;
      if (generation.current !== currentGeneration || !sender) { captured.getTracks().forEach((track) => track.stop()); return; }
      try { await sender.replaceTrack(captured.getVideoTracks()[0]!); }
      catch (cause) { captured.getTracks().forEach((track) => track.stop()); throw cause; }
      display.current = captured;
      captured.getVideoTracks()[0]!.onended = () => { stopSharing().catch((cause: unknown) => setError(mediaError(cause))); };
      localMedia.current.sharing = true;
      setDisplayStream(captured);
      setIsSharing(true);
      publishMedia();
      log('Screen sharing started');
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'NotAllowedError')) setError(mediaError(cause));
    }
  }

  useEffect(() => {
    refreshDevices().catch(() => {});
    const handler = () => { refreshDevices().catch(() => {}); };
    navigator.mediaDevices?.addEventListener('devicechange', handler);
    return () => {
      generation.current++;
      closeSession();
      releaseMedia();
      navigator.mediaDevices?.removeEventListener('devicechange', handler);
    };
  }, []);

  return {
    status, localStream, remoteStream, displayStream, peer, roomId, mode, error, micEnabled, cameraEnabled,
    isSharing, level, remoteLevel, devices, startedAt, stats, history, events,
    start, hangup, preview, toggleMic, toggleCamera, toggleSharing, switchDevice, refreshDevices,
    reconnect: () => reconnect().catch((cause: unknown) => setError(mediaError(cause))), testRelay,
    clearError: () => setError(null),
  };
}

export type CallController = ReturnType<typeof useCall>;