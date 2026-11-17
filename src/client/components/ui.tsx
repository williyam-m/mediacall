import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Volume2, X } from 'lucide-react';

export function IconButton({ label, children, active = false, danger = false, className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean; danger?: boolean }) {
  return <button type="button" aria-label={label} title={label} data-tooltip={label}
    className={`icon-button ${active ? 'is-active' : ''} ${danger ? 'is-danger' : ''} ${className}`} {...props}>{children}</button>;
}

export function Avatar({ name, small = false, guest = false }: { name: string; small?: boolean; guest?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'Y';
  return <span className={`avatar ${small ? 'avatar-small' : ''} ${guest ? 'avatar-guest' : ''}`}>{initials}</span>;
}

export function VideoStream({ stream, muted = false, hidden = false, sharing = false, testId }:
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

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={20} /></IconButton></div>
    {children}
  </dialog>;
}