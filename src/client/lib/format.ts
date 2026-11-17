export function formatDuration(seconds: number | null) {
  if (seconds === null) return '--';
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null) {
  if (bytes === null) return '--';
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

export function formatValue(value: number | null, unit = '', digits = 0) {
  return value === null || !Number.isFinite(value) ? '--' : `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}