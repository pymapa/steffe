/**
 * Minimal YAML-frontmatter reader: `key: value` lines, with indented
 * continuation lines (block scalars like `description: >`) folded into the value.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw.trim() };
  const frontmatter: Record<string, string> = {};
  let last: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      last = kv[1];
      frontmatter[last] = kv[2].trim().replace(/^[>|][-+]?$/, '').replace(/^(['"])(.*)\1$/, '$2');
    } else if (last && /^\s+\S/.test(line)) {
      frontmatter[last] = `${frontmatter[last]} ${line.trim()}`.trim();
    }
  }
  return { frontmatter, body: m[2].trim() };
}
