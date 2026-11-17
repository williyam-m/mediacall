export function mediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Camera or microphone access was denied. Check your browser permissions, or try an audio call.';
    if (error.name === 'NotFoundError') return 'No matching camera or microphone was found. Connect a device or try an audio call.';
    if (error.name === 'NotReadableError') return 'Your camera or microphone is in use by another application.';
  }
  return error instanceof Error ? error.message : 'Unable to start the call.';
}