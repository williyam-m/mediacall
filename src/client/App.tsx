import { AlertCircle, AudioLines, Headphones, Network, Settings2, ShieldCheck, Video, X } from 'lucide-react';
import { useWorkspace } from './hooks/useWorkspace.ts';
import { IconButton } from './components/ui.tsx';
import { CallMedia } from './components/CallMedia.tsx';
import { SessionPanel } from './components/SessionPanel.tsx';
import { CallDialogs } from './components/CallDialogs.tsx';
import { RelayConsole } from './components/RelayConsole.tsx';

export default function App() {
  const workspace = useWorkspace();
  const { call, active, busy, invitedRoom, serverOnline, statusText, callType, setCallType, notice, dismissError, setSettingsOpen, setConsoleOpen, consoleOpen, config } = workspace;
  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="/" onClick={(event) => { if (active) event.preventDefault(); }} aria-label="MediaCall home"><span className="brand-symbol"><AudioLines size={23} strokeWidth={2.2} /></span><span>mediacall<span className="brand-period">.</span></span></a>
      <nav className="main-nav" aria-label="Workspace"><button className="nav-item selected"><Video size={17} />Call room</button><button className="nav-item" onClick={() => setConsoleOpen(true)}><Network size={17} />Relay console</button></nav>
      <div className="header-actions"><span className="server-status"><span className={`status-dot ${serverOnline ? 'online' : ''}`} />{serverOnline ? 'Relay ready' : 'Relay offline'}</span><IconButton label="Call settings" onClick={() => setSettingsOpen(true)}><Settings2 size={20} /></IconButton></div>
    </header>
    <main className="workspace">
      <div className="page-heading"><div><div className="eyebrow">PERSONAL WORKSPACE <span>/</span> 01</div><div className="heading-line"><h1>{call.peer ? `Call with ${call.peer.name}` : active ? 'Your call room' : invitedRoom ? 'Join call' : 'New call'}</h1>
        <span className={`session-state ${call.status === 'connected' ? 'connected' : ''}`} data-testid="call-status"><span className={`status-dot ${call.status === 'connected' ? 'online' : ''} ${busy || call.status === 'connecting' ? 'pulse' : ''}`} />{statusText}</span></div></div>
        <div className="call-type-switch" aria-label="Call type"><button className={callType === 'video' ? 'selected' : ''} disabled={active || busy} onClick={() => setCallType('video')} aria-pressed={callType === 'video'}><Video size={17} />Video<span className="call-word"> call</span></button><button className={callType === 'audio' ? 'selected' : ''} disabled={active || busy} onClick={() => setCallType('audio')} aria-pressed={callType === 'audio'}><Headphones size={17} />Audio<span className="call-word"> call</span></button></div>
      </div>
      {(notice || call.error) && <div className="notice" role="alert"><AlertCircle size={19} /><span>{notice ?? call.error}</span><IconButton label="Dismiss error" onClick={dismissError}><X size={17} /></IconButton></div>}
      <div className="call-layout"><CallMedia workspace={workspace} /><SessionPanel workspace={workspace} /></div>
      <footer className="workspace-footer"><span><span className="footer-mark" />MediaCall<span className="footer-divider">/</span>Personal workspace</span><span><ShieldCheck size={13} />WebRTC<span className="footer-divider">/</span>{config?.relay?.managed ? 'Hosted TURN' : 'custom-turn'}</span></footer>
    </main>
    <CallDialogs workspace={workspace} />
    {consoleOpen && <RelayConsole workspace={workspace} />}
  </div>;
}