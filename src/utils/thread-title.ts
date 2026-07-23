/** Compact a locally stored thread title or prompt for one-line UI display. */
export function cleanThreadTitle(value: unknown, maxLength = 72): string {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length <= maxLength
    ? clean
    : `${clean.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
