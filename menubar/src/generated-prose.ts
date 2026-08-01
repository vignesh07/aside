export interface GeneratedProseSection {
  heading: string;
  paragraphs: string[];
  items: string[];
}

/**
 * Parse Aside's own generated artifact format into renderable sections.
 *
 * The observer engine emits plain text with a heading followed by either one
 * paragraph or bullet-prefixed claims. Keeping this parser deliberately small
 * lets the renderer create every node with `textContent`; generated model text
 * never crosses an HTML parsing boundary.
 */
export function parseGeneratedProse(value: string): GeneratedProseSection[] {
  const blocks = value
    .replaceAll('\r\n', '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const [first = '', ...rest] = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const hasBody = rest.length > 0;
    const body = hasBody ? rest : [first];
    return {
      heading: hasBody ? first : '',
      paragraphs: body
        .filter((line) => !isBullet(line))
        .map((line) => line.trim()),
      items: body
        .filter(isBullet)
        .map((line) => line.replace(/^[•*-]\s+/, '').trim())
        .filter(Boolean),
    };
  });
}

function isBullet(value: string): boolean {
  return /^[•*-]\s+\S/.test(value);
}
