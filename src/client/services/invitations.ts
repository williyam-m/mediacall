export function inviteRoom(value: string, origin = location.origin): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{16,64}$/.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Enter a valid invite link or room ID.'); }
  if (url.origin !== origin) throw new Error('This invitation belongs to a different server.');
  const room = url.searchParams.get('room') ?? '';
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(room)) throw new Error('The invite link does not contain a valid room ID.');
  return room;
}