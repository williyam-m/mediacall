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
}

export interface IceConfig {
  iceServers: RTCIceServer[];
  expiresAt: number;
}

export interface RelayStats {
  status: string;
  activeAllocations: number;
  maxAllocations: number;
  uptimeSeconds: number;
  transports: string[];
  created: number;
  bytesToPeer: number;
  bytesToClient: number;
  dropped: number;
  authFailures: number;
}