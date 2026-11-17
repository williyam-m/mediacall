import { useEffect, useState } from 'react';

export function useAudioLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream?.getAudioTracks().length) { setLevel(0); return; }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const timer = setInterval(() => {
      analyser.getByteFrequencyData(samples);
      const average = samples.reduce((total, value) => total + value, 0) / samples.length;
      setLevel(Math.min(1, average / 80));
    }, 100);
    context.resume().catch(() => {});
    return () => { clearInterval(timer); source.disconnect(); context.close().catch(() => {}); };
  }, [stream]);
  return level;
}