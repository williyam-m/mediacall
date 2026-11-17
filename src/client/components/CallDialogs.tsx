import { ArrowRight, AudioLines, Check, Link2, LoaderCircle, Mic, RefreshCw, Video } from 'lucide-react';
import { IconButton, Modal } from './ui.tsx';
import type { Workspace } from '../hooks/useWorkspace.ts';

export function CallDialogs({ workspace }: { workspace: Workspace }) {
  const { call, joinOpen, setJoinOpen, join, joinDraft, setJoinDraft, notice, settingsOpen, setSettingsOpen, audioDevice, videoDevice, selectDevice, preview, previewBusy, config, accessToken, setAccessToken } = workspace;
  return <>
    {joinOpen && <Modal title="Join a call" onClose={() => setJoinOpen(false)}><form onSubmit={(event) => { event.preventDefault(); join(); }}><div className="field-group"><label htmlFor="join-link">Invite link or room ID</label><input id="join-link" value={joinDraft} onChange={(event) => setJoinDraft(event.target.value)} autoFocus required placeholder={`${location.origin}/?room=...`} /></div>
      {notice && <div className="form-error" role="alert">{notice}</div>}<button className="primary-button" type="submit"><Link2 size={18} />Join call<ArrowRight size={18} /></button></form></Modal>}
    {settingsOpen && <Modal title="Call settings" onClose={() => setSettingsOpen(false)}><div className="settings-section"><div className="settings-section-heading"><h3>Devices</h3><IconButton label="Refresh devices" onClick={() => call.refreshDevices()}><RefreshCw size={16} /></IconButton></div>
      <div className="field-group"><label htmlFor="audio-input"><Mic size={14} />Microphone</label><select id="audio-input" value={audioDevice} onChange={(event) => selectDevice('audio', event.target.value)}><option value="">Default microphone</option>{call.devices.filter((device) => device.kind === 'audioinput' && device.deviceId).map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>
      <div className="field-group"><label htmlFor="video-input"><Video size={14} />Camera</label><select id="video-input" value={videoDevice} onChange={(event) => selectDevice('video', event.target.value)}><option value="">Default camera</option>{call.devices.filter((device) => device.kind === 'videoinput' && device.deviceId).map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>
      <button className="text-button" onClick={preview} disabled={previewBusy}>{previewBusy ? <LoaderCircle className="spin" size={16} /> : <AudioLines size={16} />}Check devices</button></div>
      <div className="settings-section"><h3>Server access</h3><div className="field-group"><label htmlFor="access-token">Access token<span className="field-tag">{config?.requiresAccessToken ? 'Required' : 'Not required'}</span></label><input type="password" id="access-token" autoComplete="off" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="Server access token" /></div></div><button className="primary-button" onClick={() => setSettingsOpen(false)}><Check size={17} />Done</button>
    </Modal>}
  </>;
}