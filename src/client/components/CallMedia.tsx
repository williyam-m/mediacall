import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, ShieldCheck, Signal, Video, VideoOff } from 'lucide-react';
import { Avatar, IconButton, VideoStream } from './ui.tsx';
import { LiveStats } from './LiveStats.tsx';
import { formatDuration, formatValue } from '../lib/format.ts';
import type { Workspace } from '../hooks/useWorkspace.ts';

export function CallMedia({ workspace }: { workspace: Workspace }) {
  const { call, callType, displayName, active, busy, previewBusy, seconds, route, preview, setSettingsOpen, setConsoleOpen, setNotice } = workspace;
  const stage = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const hasCamera = Boolean(call.localStream?.getVideoTracks().some((track) => track.readyState === 'live') && call.cameraEnabled);
  useEffect(() => {
    const handler = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);
  return <section className="call-main" aria-label="Call media">
    <div className={`video-stage ${callType === 'audio' && !call.peer?.media.video ? 'audio-stage' : ''}`} ref={stage}>
      <div className="stage-topline"><span className="stage-tag"><span className={`status-dot ${call.status === 'connected' ? 'online' : ''}`} />{call.peer ? call.peer.media.sharing ? 'SCREEN SHARE' : 'LIVE CALL' : 'YOUR PREVIEW'}</span>
        <div className="stage-top-actions"><span className="privacy-tag"><ShieldCheck size={14} />{call.status === 'connected' ? 'Encrypted' : 'Private room'}</span><IconButton label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => {
          (fullscreen ? document.exitFullscreen() : stage.current?.requestFullscreen())?.catch(() => setNotice('Fullscreen is unavailable.'));
        }}>{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton></div></div>
      {call.peer ? <>
        <VideoStream stream={call.remoteStream} hidden={!call.peer.media.video && !call.peer.media.sharing} sharing={call.peer.media.sharing} testId="remote-video" />
        {(!call.peer.media.video && !call.peer.media.sharing || !call.remoteStream) && <div className="stage-placeholder"><Avatar name={call.peer.name} guest /><h2>{call.peer.name}</h2><span className="placeholder-caption">{call.status === 'connected' ? 'Audio connected' : 'Connecting media'}</span><div className="audio-wave" aria-hidden="true">{Array.from({ length: 29 }, (_, index) => <span key={index} style={{ height: `${5 + Math.abs(Math.sin(index * 1.7)) * call.remoteLevel * 46}px` }} />)}</div></div>}
        <div className="self-preview"><VideoStream stream={call.displayStream ?? call.localStream} muted hidden={!hasCamera && !call.isSharing} sharing={call.isSharing} testId="local-video" />
          {!hasCamera && !call.isSharing && <div className="self-placeholder"><Avatar name={displayName} small /></div>}<span className="self-label">You {!call.micEnabled && <MicOff size={12} />}</span></div>
      </> : <>
        <VideoStream stream={call.displayStream ?? call.localStream} muted hidden={!hasCamera || callType === 'audio'} sharing={call.isSharing} testId="local-video" />
        {(!hasCamera || callType === 'audio') && <div className="stage-placeholder">
          {callType === 'audio' ? <Avatar name={displayName} /> : <div className="camera-glyph"><VideoOff size={32} strokeWidth={1.4} /></div>}<h2>{callType === 'audio' ? displayName : call.status === 'ended' ? 'Call ended' : 'Camera off'}</h2>
          {callType === 'audio' ? <><span className="placeholder-caption">Audio call</span><div className="audio-wave" aria-hidden="true">{Array.from({ length: 29 }, (_, index) => <span key={index} style={{ height: `${5 + Math.abs(Math.sin(index * 1.7)) * call.level * 46}px` }} />)}</div></> :
            <button className="enable-camera" onClick={() => { if (active) call.toggleCamera(); else preview(); }} disabled={previewBusy || busy}>{previewBusy ? <LoaderCircle size={17} className="spin" /> : <Video size={17} />} Enable camera</button>}
        </div>}
      </>}
      <div className="stage-bottomline"><span className="nameplate">{call.peer ? call.peer.name : `${displayName} (you)`}{call.peer ? !call.peer.media.audio && <MicOff size={14} /> : !call.micEnabled && <MicOff size={14} />}</span>
        {call.status === 'waiting' && <span className="waiting-badge"><span className="status-dot pulse" /> Waiting for your guest</span>}{call.startedAt && <span className="call-timer"><span className="status-dot online" />{formatDuration(seconds)}</span>}</div>
    </div>
    <div className="call-toolbar"><div className="your-signal"><Avatar name={displayName} small /><div><strong>You</strong><span>{call.isSharing ? 'Sharing screen' : hasCamera ? 'Camera on' : 'Camera off'}</span></div></div>
      <div className="media-controls"><div className="control"><div className="split-control"><IconButton label={call.micEnabled ? 'Mute microphone' : 'Unmute microphone'} active={!call.micEnabled} onClick={call.toggleMic}>{call.micEnabled ? <Mic size={21} /> : <MicOff size={21} />}</IconButton><button className="device-arrow" aria-label="Microphone settings" title="Microphone settings" onClick={() => setSettingsOpen(true)}><ChevronDown size={12} /></button></div><span>Mic</span></div>
        <div className="control"><IconButton label={hasCamera ? 'Turn camera off' : 'Turn camera on'} active={!hasCamera} disabled={callType === 'audio' && !active} onClick={() => call.toggleCamera()}>{hasCamera ? <Video size={21} /> : <VideoOff size={21} />}</IconButton><span>Camera</span></div>
        <div className="control"><IconButton label={call.isSharing ? 'Stop sharing screen' : 'Share screen'} active={call.isSharing} disabled={!call.peer || !['connected', 'reconnecting'].includes(call.status)} onClick={() => call.toggleSharing()}><MonitorUp size={21} /></IconButton><span>Share</span></div>
        <span className="control-divider" /><div className="control"><IconButton label="Leave call" danger disabled={!active && !busy} onClick={call.hangup}><PhoneOff size={21} /></IconButton><span>Leave</span></div></div>
      <button className="toolbar-network" aria-label="Connection details" title="Connection details" onClick={() => setConsoleOpen(true)}><Signal size={19} /></button></div>
    <div className="media-readout"><div><span className="readout-label">CONNECTION</span><strong data-testid="connection-route"><span className={`status-dot ${call.stats.route === 'relay' ? 'relay-dot' : call.stats.route === 'direct' ? 'online' : ''}`} />{route}</strong></div><div><span className="readout-label">ROUND TRIP</span><strong data-testid="round-trip">{formatValue(call.stats.rtt, 'ms')}</strong></div>
      <div className="microphone-readout"><span className="readout-label">MICROPHONE</span><div className="level-meter" aria-label="Microphone level">{Array.from({ length: 14 }, (_, index) => <span className={call.micEnabled && call.level > index / 14 ? 'lit' : ''} key={index} />)}</div></div></div>
    {active && <LiveStats stats={call.stats} history={call.history} />}
  </section>;
}