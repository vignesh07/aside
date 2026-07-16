/**
 * Word-wrap plain text to a fixed column width.
 *
 * The chat pane needs to know its own row count before Ink lays it out: it has
 * to keep the *newest* lines when an answer is too tall, and Ink's own wrapping
 * happens too late to count. So wrapping happens here, up front, where the line
 * count is knowable and testable.
 *
 * Existing newlines are preserved as hard breaks. Words longer than `width`
 * (URLs, paths) are hard-split rather than allowed to overflow the column.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }

    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      // A word that can never fit gets chopped across lines.
      if (word.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        let rest = word;
        while (rest.length > width) {
          out.push(rest.slice(0, width));
          rest = rest.slice(width);
        }
        line = rest;
        continue;
      }

      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > width) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }

  return out;
}
