import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  AlertCircle, ArrowRight, ArrowUpRight, AudioLines, Check, ChevronDown, Copy, FlaskConical, Headphones,
  Link2, LoaderCircle, Maximize2, Mic, MicOff, Minimize2, MonitorUp, Network, PhoneOff,
  RefreshCw, Route, Server, Settings2, ShieldCheck, Signal, Video, VideoOff, Volume2, X,
} from 'lucide-react';
import { useCall } from './hooks/useCall.ts';
import type { CallMode, AppConfig, RelayStats } from '../shared/types.ts';

function IconButton({ label, children, active = false, danger = false, className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean; danger?: boolean }) {
  return <button type="button" aria-label={label} title={label} data-tooltip={label}
    className={`icon-button ${active ? 'is-active' : ''} ${danger ? 'is-danger' : ''} ${className}`} {...props}>{children}</button>;
}

function Avatar({ name, small = false, guest = false }: { name: string; small?: boolean; guest?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'Y';
  return <span className={`avatar ${small ? 'avatar-small' : ''} ${guest ? 'avatar-guest' : ''}`}>{initials}</span>;
}

function VideoStream({ stream, muted = false, hidden = false, sharing = false, testId }:
  { stream: MediaStream | null; muted?: boolean; hidden?: boolean; sharing?: boolean; testId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  useEffect(() => {
    const element = video.current!;
    element.srcObject = stream;
    setNeedsPlay(false);
    if (stream) element.play().catch(() => { if (!muted) setNeedsPlay(true); });
    return () => { element.srcObject = null; };
  }, [stream, muted]);
  return <>
    <video ref={video} data-testid={testId} autoPlay playsInline muted={muted}
      className={`call-video ${muted && !sharing ? 'mirrored' : ''} ${hidden ? 'video-hidden' : ''} ${sharing ? 'shared-video' : ''}`} />
    {needsPlay && <button className="play-audio" onClick={() => { video.current?.play().then(() => setNeedsPlay(false)); }}><Volume2 size={18} /> Play audio</button>}
  </>;
}

function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={20} /></IconButton></div>
    {children}
  </dialog>;
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return '--';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return '--';
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1000).toFixed(1)} KB`;
}

function inviteRoom(value: string): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{16,64}$/.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Enter a valid invite link or room ID.'); }
  if (url.origin !== location.origin) throw new Error('This invitation belongs to a different server.');
  const room = url.searchParams.get('room') ?? '';
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(room)) throw new Error('The invite link does not contain a valid room ID.');
  return room;
}

export default function App() {
  const call = useCall();
  const [name, setName] = useState(() => localStorage.getItem('mediacall-name') ?? '');
  const [callType, setCallType] = useState<'video' | 'audio'>('video');
  const [policy, setPolicy] = useState<CallMode>('auto');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [relay, setRelay] = useState<RelayStats | null>(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinDraft, setJoinDraft] = useState(() => new URL(location.href).searchParams.has('room') ? location.href : '');
  const [invitedRoom, setInvitedRoom] = useState(() => new URL(location.href).searchParams.get('room'));
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [probeState, setProbeState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [probeResult, setProbeResult] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [audioDevice, setAudioDevice] = useState('');
  const [videoDevice, setVideoDevice] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);
  const active = ['waiting', 'connecting', 'connected', 'reconnecting'].includes(call.status);
  const busy = call.status === 'preparing';
  const displayName = name.trim() || 'Guest';
  const roomLink = call.roomId ? `${location.origin}/?room=${call.roomId}` : '';
  const route = call.stats.route === 'pending' ? 'Not connected' : call.stats.route === 'relay' ? 'TURN relay' : 'Peer-to-peer';
  const hasCamera = Boolean(call.localStream?.getVideoTracks().some((track) => track.readyState === 'live') && call.cameraEnabled);
  const selectedPolicy = active ? call.mode : policy;
  const providerName = config?.relay?.name ?? 'custom-turn';
  const providerVersion = config?.relay?.version ?? '0.1';

  useEffect(() => {
    fetch('/api/config', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Unable to load the call server.');
      }
      return response.json() as Promise<AppConfig>;
    }).then((configuration) => {
      setConfig(configuration);
      if (configuration.defaultMode) setPolicy(configuration.defaultMode);
    }).catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : 'Unable to load the call server.'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const health = await fetch('/api/health', { cache: 'no-store' });
        if (!cancelled) setServerOnline(health.ok);
        const response = await fetch('/api/relay', { cache: 'no-store', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
        if (!cancelled) setRelay(response.ok ? await response.json() as RelayStats : null);
      } catch { if (!cancelled) { setServerOnline(false); setRelay(null); } }
    }
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [accessToken]);

  useEffect(() => {
    const update = () => setSeconds(call.startedAt ? Math.floor((Date.now() - call.startedAt) / 1000) : 0);
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [call.startedAt]);

  useEffect(() => {
    const handler = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  async function start(room?: string) {
    setNotice(null);
    if (config?.requiresAccessToken && !accessToken) { setSettingsOpen(true); setNotice('Enter the server access token to start a call.'); return; }
    if (!config || !serverOnline) { setNotice('The call server is unavailable.'); return; }
    const target = room ?? crypto.randomUUID().replaceAll('-', '');
    setJoinOpen(false);
    localStorage.setItem('mediacall-name', displayName);
    await call.start({ roomId: target, name: displayName, mode: policy, video: callType === 'video', accessToken });
  }

  async function join() {
    try { await start(inviteRoom(joinDraft)); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Invalid invitation.'); }
  }

  async function preview() {
    setPreviewBusy(true);
    await call.preview(callType === 'video');
    setPreviewBusy(false);
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(roomLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { inviteInput.current?.select(); setNotice('Clipboard access was denied.'); }
  }

  async function probeRelay() {
    if (config?.requiresAccessToken && !accessToken) { setSettingsOpen(true); return; }
    setProbeState('testing');
    setProbeResult('');
    try { setProbeResult(await call.testRelay(accessToken)); setProbeState('success'); }
    catch (cause) { setProbeState('error'); setProbeResult(cause instanceof Error ? cause.message : 'Relay allocation failed.'); }
  }

  async function selectDevice(kind: 'audio' | 'video', value: string) {
    if (kind === 'audio') setAudioDevice(value); else setVideoDevice(value);
    try { await call.switchDevice(kind, value); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Unable to change device.'); }
  }

  const statusText = {
    idle: 'Local preview', preparing: 'Preparing call', waiting: 'Waiting for guest', connecting: 'Connecting',
    connected: 'Connected', reconnecting: 'Reconnecting', ended: 'Call ended', error: 'Call unavailable',
  }[call.status];

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="/" onClick={(event) => { if (active) event.preventDefault(); }} aria-label="MediaCall home">
        <span className="brand-symbol"><AudioLines size={23} strokeWidth={2.2} /></span><span>mediacall<span className="brand-period">.</span></span>
      </a>
      <nav className="main-nav" aria-label="Workspace"><button className="nav-item selected"><Video size={17} /> Call room</button>
        <button className="nav-item" onClick={() => setConsoleOpen(true)}><Network size={17} /> Relay console</button></nav>
      <div className="header-actions"><span className="server-status"><span className={`status-dot ${serverOnline ? 'online' : ''}`} />{serverOnline ? 'Relay online' : 'Relay offline'}</span>
        <IconButton label="Call settings" onClick={() => setSettingsOpen(true)}><Settings2 size={20} /></IconButton></div>
    </header>

    <main className="workspace">
      <div className="page-heading"><div><div className="eyebrow">PERSONAL WORKSPACE <span>/</span> 01</div>
        <div className="heading-line"><h1>{call.peer ? `Call with ${call.peer.name}` : active ? 'Your call room' : invitedRoom ? 'Join call' : 'New call'}</h1>
          <span className={`session-state ${call.status === 'connected' ? 'connected' : ''}`} data-testid="call-status"><span className={`status-dot ${call.status === 'connected' ? 'online' : ''} ${busy || call.status === 'connecting' ? 'pulse' : ''}`} />{statusText}</span></div></div>
        <div className="call-type-switch" aria-label="Call type"><button className={callType === 'video' ? 'selected' : ''} disabled={active || busy}
          onClick={() => setCallType('video')} aria-pressed={callType === 'video'}><Video size={17} /> Video<span className="call-word"> call</span></button>
          <button className={callType === 'audio' ? 'selected' : ''} disabled={active || busy} onClick={() => setCallType('audio')} aria-pressed={callType === 'audio'}><Headphones size={17} /> Audio<span className="call-word"> call</span></button></div>
      </div>

      {(notice || call.error) && <div className="notice" role="alert"><AlertCircle size={19} /><span>{notice ?? call.error}</span>
        <IconButton label="Dismiss error" onClick={() => { setNotice(null); call.clearError(); }}><X size={17} /></IconButton></div>}

      <div className="call-layout">
        <section className="call-main" aria-label="Call media">
          <div className={`video-stage ${callType === 'audio' && !call.peer?.media.video ? 'audio-stage' : ''}`} ref={stage}>
            <div className="stage-topline"><span className="stage-tag"><span className={`status-dot ${call.status === 'connected' ? 'online' : ''}`} />{call.peer ? (call.peer.media.sharing ? 'SCREEN SHARE' : 'LIVE CALL') : 'YOUR PREVIEW'}</span>
              <div className="stage-top-actions"><span className="privacy-tag"><ShieldCheck size={14} />{call.status === 'connected' ? 'Encrypted' : 'Private room'}</span>
                <IconButton label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => {
                  (fullscreen ? document.exitFullscreen() : stage.current?.requestFullscreen())?.catch(() => setNotice('Fullscreen is unavailable.'));
                }}>{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton></div></div>

            {call.peer ? <>
              <VideoStream stream={call.remoteStream} hidden={!call.peer.media.video && !call.peer.media.sharing} sharing={call.peer.media.sharing} testId="remote-video" />
              {(!call.peer.media.video && !call.peer.media.sharing || !call.remoteStream) && <div className="stage-placeholder">
                <Avatar name={call.peer.name} guest /><h2>{call.peer.name}</h2>
                <span className="placeholder-caption">{call.status === 'connected' ? 'Audio connected' : 'Connecting media'}</span>
                <div className="audio-wave" aria-hidden="true">{Array.from({ length: 29 }, (_, index) => <span key={index}
                  style={{ height: `${5 + Math.abs(Math.sin(index * 1.7)) * call.remoteLevel * 46}px` }} />)}</div>
              </div>}
              <div className="self-preview"><VideoStream stream={call.displayStream ?? call.localStream} muted hidden={!hasCamera && !call.isSharing} sharing={call.isSharing} testId="local-video" />
                {!hasCamera && !call.isSharing && <div className="self-placeholder"><Avatar name={displayName} small /></div>}
                <span className="self-label">You {!call.micEnabled && <MicOff size={12} />}</span></div>
            </> : <>
              <VideoStream stream={call.displayStream ?? call.localStream} muted hidden={!hasCamera || callType === 'audio'} sharing={call.isSharing} testId="local-video" />
              {(!hasCamera || callType === 'audio') && <div className="stage-placeholder">
                {callType === 'audio' ? <Avatar name={displayName} /> : <div className="camera-glyph"><VideoOff size={32} strokeWidth={1.4} /></div>}
                <h2>{callType === 'audio' ? displayName : call.status === 'ended' ? 'Call ended' : 'Camera off'}</h2>
                {callType === 'audio' ? <><span className="placeholder-caption">Audio call</span><div className="audio-wave" aria-hidden="true">
                  {Array.from({ length: 29 }, (_, index) => <span key={index} style={{ height: `${5 + Math.abs(Math.sin(index * 1.7)) * call.level * 46}px` }} />)}</div></> :
                  <button className="enable-camera" onClick={() => { if (active) call.toggleCamera(); else preview(); }} disabled={previewBusy || busy}>
                    {previewBusy ? <LoaderCircle size={17} className="spin" /> : <Video size={17} />} Enable camera</button>}
              </div>}
            </>}

            <div className="stage-bottomline"><span className="nameplate">{call.peer ? call.peer.name : `${displayName} (you)`}
              {call.peer ? !call.peer.media.audio && <MicOff size={14} /> : !call.micEnabled && <MicOff size={14} />}</span>
              {call.status === 'waiting' && <span className="waiting-badge"><span className="status-dot pulse" /> Waiting for your guest</span>}
              {call.startedAt && <span className="call-timer"><span className="status-dot online" />{formatDuration(seconds)}</span>}</div>
          </div>

          <div className="call-toolbar">
            <div className="your-signal"><Avatar name={displayName} small /><div><strong>You</strong><span>{call.isSharing ? 'Sharing screen' : hasCamera ? 'Camera on' : 'Camera off'}</span></div></div>
            <div className="media-controls">
              <div className="control"><div className="split-control"><IconButton label={call.micEnabled ? 'Mute microphone' : 'Unmute microphone'} active={!call.micEnabled} onClick={call.toggleMic}>
                {call.micEnabled ? <Mic size={21} /> : <MicOff size={21} />}</IconButton><button className="device-arrow" aria-label="Microphone settings" title="Microphone settings" onClick={() => setSettingsOpen(true)}><ChevronDown size={12} /></button></div><span>Mic</span></div>
              <div className="control"><IconButton label={hasCamera ? 'Turn camera off' : 'Turn camera on'} active={!hasCamera} disabled={callType === 'audio' && !active}
                onClick={() => { call.toggleCamera(); }}>{hasCamera ? <Video size={21} /> : <VideoOff size={21} />}</IconButton><span>Camera</span></div>
              <div className="control"><IconButton label={call.isSharing ? 'Stop sharing screen' : 'Share screen'} active={call.isSharing} disabled={!call.peer || !['connected', 'reconnecting'].includes(call.status)}
                onClick={() => { call.toggleSharing(); }}><MonitorUp size={21} /></IconButton><span>Share</span></div>
              <span className="control-divider" />
              <div className="control"><IconButton label="Leave call" danger disabled={!active && !busy} onClick={call.hangup}><PhoneOff size={21} /></IconButton><span>Leave</span></div>
            </div>
            <button className="toolbar-network" aria-label="Connection details" title="Connection details" onClick={() => setConsoleOpen(true)}><Signal size={19} /></button>
          </div>

          <div className="media-readout"><div><span className="readout-label">CONNECTION</span><strong data-testid="connection-route"><span className={`status-dot ${call.stats.route === 'relay' ? 'relay-dot' : call.stats.route === 'direct' ? 'online' : ''}`} />{route}</strong></div>
            <div><span className="readout-label">ROUND TRIP</span><strong data-testid="round-trip">{call.stats.route === 'pending' ? '--' : `${Math.round(call.stats.rtt)} ms`}</strong></div>
            <div className="microphone-readout"><span className="readout-label">MICROPHONE</span><div className="level-meter" aria-label="Microphone level">{Array.from({ length: 14 }, (_, index) =>
              <span className={call.micEnabled && call.level > index / 14 ? 'lit' : ''} key={index} />)}</div></div></div>
        </section>

        <aside className="session-panel">
          <section className="session-section">
            <div className="section-heading"><h2>{active ? 'THIS SESSION' : 'GET CONNECTED'}</h2><span className="small-label">1:1</span></div>
            {!active ? <>
              <div className="field-group"><label htmlFor="display-name">Your name</label><input id="display-name" placeholder="e.g. Alex Morgan" maxLength={48} value={name}
                onChange={(event) => setName(event.target.value)} disabled={busy} autoComplete="given-name" /></div>
              <button className="primary-button" disabled={busy || !config} onClick={() => start(invitedRoom ?? undefined)}>
                {busy ? <LoaderCircle size={18} className="spin" /> : <Video size={18} />} {busy ? 'Preparing...' : invitedRoom ? 'Join call' : 'Create call'}{!busy && <ArrowUpRight size={18} />}</button>
              {invitedRoom ? <button className="join-button" onClick={() => { setInvitedRoom(null); history.replaceState({}, '', '/'); }} disabled={busy}><ArrowRight size={16} />Create a new call</button> :
                <button className="join-button" onClick={() => { setNotice(null); setJoinOpen(true); }} disabled={busy}><Link2 size={17} />Join with a link <ArrowRight size={15} /></button>}
            </> : <>
              <label className="invite-label" htmlFor="invite-url">INVITE LINK</label>
              <div className="invite-field"><input ref={inviteInput} id="invite-url" aria-label="Invite link" value={roomLink} readOnly onClick={(event) => event.currentTarget.select()} />
                <IconButton label={copied ? 'Invite copied' : 'Copy invite'} onClick={copyInvite}>{copied ? <Check size={17} /> : <Copy size={17} />}</IconButton></div>
              <button className="primary-button copy-button" onClick={copyInvite}>{copied ? <Check size={17} /> : <Link2 size={17} />}{copied ? 'Link copied' : 'Copy invite link'}<ArrowUpRight size={17} /></button>
            </>}
          </section>

          {active && <section className="people-section"><div className="section-heading"><h2>PARTICIPANTS</h2><span className="small-label">{call.peer ? '2' : '1'} / 2</span></div>
            <div className="participant"><Avatar name={displayName} small /><div><strong>{displayName}<span className="participant-you"> (you)</span></strong><span>In the room</span></div>{call.micEnabled ? <Mic size={15} /> : <MicOff size={15} />}</div>
            <div className={`participant ${!call.peer ? 'participant-empty' : ''}`}><Avatar name={call.peer?.name ?? '?'} small guest /><div><strong>{call.peer?.name ?? 'Guest'}</strong><span>{call.peer ? 'In the room' : 'Not joined yet'}</span></div>
              {call.peer ? call.peer.media.audio ? <Mic size={15} /> : <MicOff size={15} /> : <span className="status-dot" />}</div></section>}

          <section className="network-section"><div className="section-heading"><h2>CONNECTION</h2><IconButton label="Open relay console" onClick={() => setConsoleOpen(true)}><ArrowUpRight size={16} /></IconButton></div>
            <div className="policy-switch" aria-label="Connection mode"><button aria-pressed={selectedPolicy === 'auto'} className={selectedPolicy === 'auto' ? 'selected' : ''} disabled={active || busy}
              onClick={() => setPolicy('auto')}><Route size={16} /> Automatic</button><button aria-pressed={selectedPolicy === 'relay'} className={selectedPolicy === 'relay' ? 'selected' : ''} disabled={active || busy}
              onClick={() => setPolicy('relay')}><ShieldCheck size={16} /> Force TURN</button></div>
            <div className="network-details"><div><span>ICE policy</span><strong>{selectedPolicy === 'relay' ? 'Relay only' : 'All candidates'}</strong></div>
              <div><span>Media security</span><strong>{call.status === 'connected' ? 'DTLS-SRTP' : '--'}</strong></div>
              <div><span>Packet loss</span><strong>{call.stats.route === 'pending' ? '--' : `${call.stats.loss.toFixed(1)}%`}</strong></div></div>
            <div className="relay-identity"><div className="relay-symbol"><Server size={19} /></div><div><strong>{providerName}<span className="version-tag">{providerVersion}</span></strong><span>{config?.relay?.host ?? config?.turnUrls[0]?.replace('turn:', '').split('?')[0] ?? 'Connecting...'}</span></div><span className={`status-dot ${serverOnline ? 'online' : ''}`} /></div>
            <div className="relay-summary"><span>{config?.relay?.managed ? 'PROVIDER' : 'ALLOCATIONS'} <strong>{config?.relay?.managed ? 'Hosted TURN' : relay?.activeAllocations != null ? `${relay.activeAllocations} / ${relay.maxAllocations}` : '--'}</strong></span><span>TRANSPORT <strong>{relay?.transports.map((transport) => transport.toUpperCase()).join(' / ') ?? '--'}</strong></span></div>
            <button className="text-button probe-button" disabled={probeState === 'testing' || !serverOnline} onClick={probeRelay}>
              {probeState === 'testing' ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}{probeState === 'testing' ? 'Testing allocation...' : 'Test relay'}<ArrowRight size={14} /></button>
            {probeState !== 'idle' && probeState !== 'testing' && <div className={`probe-result ${probeState}`} role="status"><span>{probeState === 'success' ? 'Relay allocated' : 'Allocation failed'}</span><code>{probeResult}</code></div>}
            {call.status === 'reconnecting' && <button className="text-button" onClick={call.reconnect}><RefreshCw size={15} />Reconnect media</button>}
          </section>
        </aside>
      </div>

      <footer className="workspace-footer"><span><span className="footer-mark" /> MediaCall <span className="footer-divider">/</span> Personal workspace</span><span><ShieldCheck size={13} /> WebRTC <span className="footer-divider">/</span> {config?.relay?.managed ? 'Hosted TURN' : 'custom-turn'}</span></footer>
    </main>

    {joinOpen && <Modal title="Join a call" onClose={() => setJoinOpen(false)}><form onSubmit={(event) => { event.preventDefault(); join(); }}>
      <div className="field-group"><label htmlFor="join-link">Invite link or room ID</label><input id="join-link" value={joinDraft} onChange={(event) => setJoinDraft(event.target.value)} autoFocus required placeholder={`${location.origin}/?room=...`} /></div>
      {notice && <div className="form-error" role="alert">{notice}</div>}
      <button className="primary-button" type="submit"><Link2 size={18} /> Join call<ArrowRight size={18} /></button></form></Modal>}

    {settingsOpen && <Modal title="Call settings" onClose={() => setSettingsOpen(false)}>
      <div className="settings-section"><div className="settings-section-heading"><h3>Devices</h3><IconButton label="Refresh devices" onClick={() => call.refreshDevices()}><RefreshCw size={16} /></IconButton></div>
        <div className="field-group"><label htmlFor="audio-input"><Mic size={14} />Microphone</label><select id="audio-input" value={audioDevice} onChange={(event) => selectDevice('audio', event.target.value)}>
          <option value="">Default microphone</option>{call.devices.filter((device) => device.kind === 'audioinput' && device.deviceId).map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>
        <div className="field-group"><label htmlFor="video-input"><Video size={14} />Camera</label><select id="video-input" value={videoDevice} onChange={(event) => selectDevice('video', event.target.value)}>
          <option value="">Default camera</option>{call.devices.filter((device) => device.kind === 'videoinput' && device.deviceId).map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>
        <button className="text-button" onClick={preview} disabled={previewBusy}>{previewBusy ? <LoaderCircle className="spin" size={16} /> : <AudioLines size={16} />}Check devices</button>
      </div>
      <div className="settings-section"><h3>Server access</h3><div className="field-group"><label htmlFor="access-token">Access token<span className="field-tag">{config?.requiresAccessToken ? 'Required' : 'Not required locally'}</span></label>
        <input type="password" id="access-token" autoComplete="off" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="Server access token" /></div></div>
      <button className="primary-button" onClick={() => setSettingsOpen(false)}><Check size={17} />Done</button>
    </Modal>}

    {consoleOpen && <Modal title="Relay console" onClose={() => setConsoleOpen(false)} wide>
      <div className="console-server"><span className="relay-symbol"><Server size={22} /></span><div><h3>{providerName}</h3><span>{config?.relay?.managed ? 'Managed service' : `Version ${providerVersion}`} <span className="footer-divider">/</span> IPv4</span></div><span className="experimental-tag">{config?.relay?.managed ? 'Managed' : 'Experimental'}</span></div>
      <div className="console-metrics"><div><span>{config?.relay?.managed ? 'ICE POLICY' : 'ACTIVE ALLOCATIONS'}</span><strong>{config?.relay?.managed ? selectedPolicy === 'relay' ? 'Relay only' : 'Automatic' : <>{relay?.activeAllocations ?? '--'}<small> / {relay?.maxAllocations ?? '--'}</small></>}</strong></div>
        <div><span>{config?.relay?.managed ? 'SESSION SENT' : 'TO PEERS'}</span><strong>{config?.relay?.managed ? formatBytes(call.stats.bytesSent) : relay ? formatBytes(relay.bytesToPeer) : '--'}</strong></div><div><span>{config?.relay?.managed ? 'SESSION RECEIVED' : 'TO CLIENTS'}</span><strong>{config?.relay?.managed ? formatBytes(call.stats.bytesReceived) : relay ? formatBytes(relay.bytesToClient) : '--'}</strong></div></div>
      <div className="console-section"><h3>Relay listeners</h3>{config?.turnUrls.map((url) => <div className="listener-row" key={url}><span className="status-dot online" /><code>{url}</code><span>{url.startsWith('turns:') ? 'TLS' : url.endsWith('tcp') ? 'TCP' : 'UDP'}</span></div>)}</div>
      <div className="console-section"><h3>Current connection</h3><div className="console-connection"><span>Route<strong>{route}</strong></span><span>Protocol<strong>{call.stats.protocol}</strong></span><span>ICE candidate pair<strong data-testid="ice-candidate-pair">{call.stats.localCandidateType} / {call.stats.remoteCandidateType}</strong></span><span>ICE policy<strong>{selectedPolicy === 'relay' ? 'Relay only' : 'All candidates'}</strong></span><span>Incoming bitrate<strong>{Math.round(call.stats.bitrate)} kbps</strong></span><span>Video<strong>{call.stats.resolution} {call.stats.codec !== '--' ? `/ ${call.stats.codec}` : ''}</strong></span></div></div>
      <div className="console-section"><h3>Session activity</h3>{call.events.length ? <div className="activity-list">{call.events.map((entry) => <div key={entry.id}><span className="activity-point" /><span>{entry.text}</span><time>{new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>)}</div> : <div className="empty-activity"><AudioLines size={18} />No session activity</div>}</div>
      <div className="console-bottom"><span>UPTIME <strong>{relay ? formatDuration(relay.uptimeSeconds) : '--'}</strong> <span className="footer-divider">/</span> DROPPED <strong>{relay?.dropped ?? '--'}</strong></span>
        <button className="text-button" onClick={probeRelay} disabled={probeState === 'testing'}><FlaskConical size={16} />{probeState === 'testing' ? 'Testing...' : 'Test allocation'}</button></div>
      {probeResult && <div className={`probe-result ${probeState}`} role="status"><span>{probeState === 'success' ? 'Relay allocated' : 'Allocation failed'}</span><code>{probeResult}</code></div>}
    </Modal>}
  </div>;
}