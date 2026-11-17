export type CallMode = 'auto' | 'relay';

export interface MediaState {
  audio: boolean;
  video: boolean;
  sharing: boolean;
}

export interface PeerInfo {
  id: string;
  name: string;
  media: MediaState;
}

export type ClientSignal =
  | { type: 'join'; roomId: string; name: string; mode: CallMode; accessToken: string }
  | { type: 'description'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'media'; media: MediaState }
  | { type: 'leave' };

export type ServerSignal =
  | { type: 'joined'; roomId: string; peerId: string; mode: CallMode; peers: PeerInfo[] }
  | { type: 'peer-joined'; peer: PeerInfo; mode: CallMode }
  | { type: 'peer-left' }
  | { type: 'description'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'media'; media: MediaState }
  | { type: 'error'; code: string; message: string };

export interface AppConfig {
  requiresAccessToken: boolean;
  turnUrls: string[];
  stunUrl: string;
  defaultMode?: CallMode;
  relay?: { name: string; host: string; managed: boolean; version: string };
}

export interface IceConfig {
  iceServers: RTCIceServer[];
  expiresAt: number;
  signalingUrl?: string;
  signalingTransport?: 'http' | 'metered';
}

export interface RelayStats {
  status: string;
  activeAllocations: number | null;
  maxAllocations: number | null;
  uptimeSeconds: number | null;
  transports: string[];
  created: number | null;
  bytesToPeer: number | null;
  bytesToClient: number | null;
  dropped: number | null;
  authFailures: number | null;
}