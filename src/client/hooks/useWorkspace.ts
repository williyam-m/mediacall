import { useEffect, useRef, useState } from 'react';
import { useCall } from './useCall.ts';
import { inviteRoom } from '../services/invitations.ts';
import type { AppConfig, CallMode, RelayStats } from '../../shared/types.ts';

export function useWorkspace() {
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
  const [audioDevice, setAudioDevice] = useState('');
  const [videoDevice, setVideoDevice] = useState('');
  const inviteInput = useRef<HTMLInputElement>(null);
  const active = ['waiting', 'connecting', 'connected', 'reconnecting'].includes(call.status);
  const busy = call.status === 'preparing';
  const displayName = name.trim() || 'Guest';
  const roomLink = call.roomId ? `${location.origin}/?room=${call.roomId}` : '';
  const route = call.stats.route === 'pending' ? 'Not connected' : call.stats.route === 'relay' ? 'TURN relay' : 'Peer-to-peer';
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

  async function preview() { setPreviewBusy(true); await call.preview(callType === 'video'); setPreviewBusy(false); }

  async function copyInvite() {
    try { await navigator.clipboard.writeText(roomLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { inviteInput.current?.select(); setNotice('Clipboard access was denied.'); }
  }

  async function probeRelay() {
    if (config?.requiresAccessToken && !accessToken) { setSettingsOpen(true); return; }
    setProbeState('testing'); setProbeResult('');
    try { setProbeResult(await call.testRelay(accessToken)); setProbeState('success'); }
    catch (cause) { setProbeState('error'); setProbeResult(cause instanceof Error ? cause.message : 'Relay allocation failed.'); }
  }

  async function selectDevice(kind: 'audio' | 'video', value: string) {
    if (kind === 'audio') setAudioDevice(value); else setVideoDevice(value);
    try { await call.switchDevice(kind, value); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Unable to change device.'); }
  }

  function newCall() { setInvitedRoom(null); history.replaceState({}, '', '/'); }
  function dismissError() { setNotice(null); call.clearError(); }
  const statusText = { idle: 'Local preview', preparing: 'Preparing call', waiting: 'Waiting for guest', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', ended: 'Call ended', error: 'Call unavailable' }[call.status];

  return {
    call, name, setName, callType, setCallType, policy, setPolicy, config, relay, serverOnline, accessToken, setAccessToken,
    settingsOpen, setSettingsOpen, consoleOpen, setConsoleOpen, joinOpen, setJoinOpen, joinDraft, setJoinDraft, invitedRoom,
    notice, setNotice, copied, previewBusy, probeState, probeResult, seconds, audioDevice, videoDevice, inviteInput,
    active, busy, displayName, roomLink, route, selectedPolicy, providerName, providerVersion, statusText,
    start, join, preview, copyInvite, probeRelay, selectDevice, newCall, dismissError,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;