/**
 * Flatten light markdown to plain text.
 *
 * Neither frontend parses markdown — the Ink pane and the menubar renderer both
 * paint literal text — so any syntax the model emits reaches the user verbatim
 * as noise ("## Agent status", "**not stuck**"). The system prompt asks for
 * plain prose, but prompt compliance is not a guarantee: models drop headings
 * and keep inline bold, or regress on a model swap. This is the deterministic
 * backstop, so a formatting slip can never reach the panel.
 *
 * Deliberately narrow: it strips the syntax that shows up in practice and does
 * not try to be a markdown parser.
 */
export function stripMarkdown(text: string): string {
  const lines: string[] = [];

  for (const raw of text.split('\n')) {
    let line = raw;

    // Horizontal rules carry nothing once unstyled.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) continue;

    // ATX headings: keep the words, drop the hashes.
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '');

    // Blockquote markers.
    line = line.replace(/^\s{0,3}>\s?/, '');

    // Normalize bullets to a single "- ", preserving indentation.
    line = line.replace(/^(\s*)[*+]\s+/, '$1- ');

    // Inline emphasis and code. Bold before italic so "**x**" doesn't leave "*x*".
    line = line
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2')
      .replace(/(^|[^\w`])`([^`\n]+)`/g, '$1$2');

    // Links: keep the label, drop the target — a URL is unclickable here anyway.
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

    lines.push(line);
  }

  // Collapse the blank-line runs that dropped rules and headings leave behind.
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
