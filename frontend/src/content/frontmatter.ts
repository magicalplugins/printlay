/**
 * Tiny, dependency-free YAML-frontmatter parser.
 *
 * We deliberately avoid gray-matter / js-yaml here: those reference Node
 * globals (Buffer / process) that don't exist in the browser bundle, and the
 * content registry ships to the client (lazy chunks). This parser supports the
 * constrained subset our content actually uses:
 *   - scalars:            key: value   /   key: "value"
 *   - booleans:           draft: true
 *   - block scalar lists: keywords:\n  - a\n  - b
 *   - block map lists:    faq:\n  - q: "..."\n    a: "..."
 *
 * It is intentionally strict/simple — content is authored in-repo, so we
 * control the shape. Anything unexpected is skipped rather than guessed.
 */

type Scalar = string | boolean;
type Value = Scalar | Scalar[] | Record<string, Scalar>[];

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KV_RE = /^([A-Za-z0-9_]+):\s*(.*)$/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function coerce(s: string): Scalar {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  return stripQuotes(t);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export function parseFrontmatter(raw: string): {
  data: Record<string, Value>;
  content: string;
} {
  const m = FM_RE.exec(raw);
  if (!m) return { data: {}, content: raw };
  const [, fm, content] = m;
  const lines = fm.split("\n");
  const data: Record<string, Value> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const kv = KV_RE.exec(line);
    if (!kv || indentOf(line) !== 0) {
      i++;
      continue;
    }
    const key = kv[1];
    const inlineVal = kv[2];

    if (inlineVal !== "") {
      data[key] = coerce(inlineVal);
      i++;
      continue;
    }

    // Block value (list of scalars or list of maps) follows.
    i++;
    const scalars: Scalar[] = [];
    const maps: Record<string, Scalar>[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        i++;
        continue;
      }
      if (indentOf(l) === 0) break; // back to a top-level key
      const t = l.trim();
      if (!t.startsWith("- ")) {
        i++;
        continue;
      }
      const itemIndent = indentOf(l);
      const after = t.slice(2);
      const mkv = KV_RE.exec(after);
      if (mkv) {
        // Map item: collect this and any deeper-indented sibling keys.
        const obj: Record<string, Scalar> = { [mkv[1]]: coerce(mkv[2]) };
        i++;
        while (i < lines.length) {
          const l2 = lines[i];
          if (!l2.trim()) {
            i++;
            continue;
          }
          if (indentOf(l2) <= itemIndent) break;
          const mkv2 = KV_RE.exec(l2.trim());
          if (!mkv2) break;
          obj[mkv2[1]] = coerce(mkv2[2]);
          i++;
        }
        maps.push(obj);
      } else {
        scalars.push(coerce(after));
        i++;
      }
    }
    data[key] = maps.length ? maps : scalars;
  }

  return { data, content };
}
