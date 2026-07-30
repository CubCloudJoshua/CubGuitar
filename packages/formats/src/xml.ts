/**
 * Just enough XML, owned.
 *
 * MusicXML has to be read in a Node test and in a browser, and the two do not share
 * a parser: `DOMParser` is a browser API, and reaching for one of the npm XML
 * libraries to read a format we already understand would put a dependency in the
 * middle of the one path that has to keep working when everything else is stripped
 * out (STANDALONE.md).
 *
 * So this is a parser for the subset MusicXML actually uses: elements, attributes,
 * text, comments, processing instructions, CDATA and the five predefined entities
 * plus numeric character references. It is deliberately not a validating parser and
 * it does not resolve a DTD — a DOCTYPE is skipped, which is the right thing to do
 * with an external entity reference in a file a stranger sent you.
 *
 * Where it refuses, it throws with a position, because a MusicXML file that will not
 * parse is nearly always a file that was truncated or is not MusicXML, and "unexpected
 * end of input at 41,203" tells a user which of those it was.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content, with entities resolved and whitespace kept. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Resolves the entities MusicXML is allowed to contain. */
function unescape(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Escapes text for an element body or an attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Line and column of an offset, for an error a person can act on. */
function where(source: string, at: number): string {
  const before = source.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  return `${line},${column}`;
}

/**
 * Parses a document and returns its root element.
 *
 * Throws on malformed input rather than guessing. A half-parsed score is worse than
 * a refused one: the user would get a document missing bars with nothing saying so.
 */
export function parseXml(source: string): XmlNode {
  let i = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  const fail = (message: string): never => {
    throw new Error(`${message} at ${where(source, i)}`);
  };

  while (i < source.length) {
    const open = source.indexOf("<", i);
    if (open < 0) break;

    // Text between elements belongs to whatever is currently open.
    if (open > i) {
      const parent = stack.at(-1);
      if (parent) parent.text += unescape(source.slice(i, open));
    }
    i = open;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i);
      if (end < 0) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i);
      if (end < 0) fail("unterminated CDATA");
      const parent = stack.at(-1);
      // CDATA is literal by definition, so it is not unescaped.
      if (parent) parent.text += source.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i);
      if (end < 0) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (source.startsWith("<!", i)) {
      // A DOCTYPE, which may carry an internal subset in brackets. Skipped rather
      // than read: nothing here needs a DTD, and following an external entity
      // reference in an untrusted file is how XML parsers become a security bug.
      let depth = 0;
      while (i < source.length) {
        const ch = source[i];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        else if (ch === ">" && depth <= 0) break;
        i += 1;
      }
      if (i >= source.length) fail("unterminated declaration");
      i += 1;
      continue;
    }

    if (source.startsWith("</", i)) {
      const end = source.indexOf(">", i);
      if (end < 0) fail("unterminated closing tag");
      const name = source.slice(i + 2, end).trim();
      const node = stack.pop();
      if (!node) fail(`closing tag </${name}> with nothing open`);
      if (node && node.name !== name) fail(`</${name}> closes <${node.name}>`);
      i = end + 1;
      continue;
    }

    // An element. The tag runs to the first '>' that is not inside an attribute.
    let end = i + 1;
    let quote: string | null = null;
    while (end < source.length) {
      const ch = source[end]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      end += 1;
    }
    if (end >= source.length) fail("unterminated tag");

    const inner = source.slice(i + 1, end);
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) fail("tag with no name");
    const name = nameMatch![1]!;

    const attrs: Record<string, string> = {};
    const attrPattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = attrPattern.exec(body.slice(name.length))) !== null) {
      attrs[match[1]!] = unescape(match[3] ?? match[4] ?? "");
    }

    const node: XmlNode = { name, attrs, children: [], text: "" };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) fail("a second root element");
    else root = node;
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }

  if (stack.length > 0) throw new Error(`unexpected end of input: <${stack.at(-1)!.name}> is still open`);
  if (!root) throw new Error("no elements found: this is not an XML document");
  return root;
}

/** The first child with this name, or undefined. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

/** Every child with this name, in document order. */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

/** A named child's trimmed text, or undefined when the child is absent. */
export function childText(node: XmlNode | undefined, name: string): string | undefined {
  const found = child(node, name);
  return found === undefined ? undefined : found.text.trim();
}

/**
 * A named child's numeric text, or undefined.
 *
 * Undefined rather than zero for a missing or unparseable value, so a caller can
 * tell "this file says nothing" from "this file says none" — in MusicXML those mean
 * different things for `alter`, `fifths` and `octave-change` alike.
 */
export function childNumber(node: XmlNode | undefined, name: string): number | undefined {
  const raw = childText(node, name);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Whether a named child is present at all, for MusicXML's many empty flags. */
export function has(node: XmlNode | undefined, name: string): boolean {
  return child(node, name) !== undefined;
}

/** Every descendant with this name, at any depth. */
export function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}
