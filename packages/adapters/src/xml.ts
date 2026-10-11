/**
 * A minimal XML codec for the generic `http` adapter's `encoding: xml` (S3-style configuration documents such as a
 * bucket's `CORSConfiguration`), mapping XML to the JSON shapes the adapter already works with:
 *
 *   - an element with child elements is a map of child name → value; a child that repeats is a list of values;
 *   - an element with only text is that text, as a string (XML has no numbers or booleans); an empty element is "";
 *   - attributes are `@name` keys (`@xmlns`), and the text of an element that also has attributes is `#text`.
 *
 * Encoding is the inverse: the body is a map with one key (the root element), lists become repeated elements,
 * `null` leaves an element out. A single repeated element therefore reads back as a value, not a list of one.
 *
 * Safe by construction: no DTDs (a `<!DOCTYPE` or `<!ENTITY` is refused, so no external entities and no entity
 * expansion), only the five predefined entities and numeric character references, a depth limit, and no
 * namespace processing (prefixed names are kept as written).
 */

/** Nesting deeper than this is refused rather than recursed into. */
export const XML_MAX_DEPTH = 64;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;

/** Thrown for a document (or a body) this codec does not handle. */
export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function scalar(v: unknown, name: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new XmlError(`\`${name}\` must be a map, a list, a string, a number or a boolean`);
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new XmlError(`\`${name}\` is not an XML element name`);
}

function element(name: string, v: unknown, depth: number): string {
  if (depth > XML_MAX_DEPTH) throw new XmlError(`nested deeper than ${XML_MAX_DEPTH} elements`);
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => element(name, x, depth)).join("");
  checkName(name);
  if (typeof v !== "object") return `<${name}>${escapeText(scalar(v, name))}</${name}>`;
  let attrs = "";
  let inner = "";
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith("@")) {
      checkName(k.slice(1));
      attrs += ` ${k.slice(1)}="${escapeAttr(scalar(x, k))}"`;
    } else if (k === "#text") inner += escapeText(scalar(x, k));
    else inner += element(k, x, depth + 1);
  }
  return `<${name}${attrs}>${inner}</${name}>`;
}

/** A body as an XML document: a map with exactly one key, the root element. */
export function xmlEncode(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1) {
    throw new XmlError("an XML body must be a map with exactly one key: the root element, e.g. { CORSConfiguration: { … } }");
  }
  const [root, value] = Object.entries(body as Record<string, unknown>)[0]!;
  return `<?xml version="1.0" encoding="UTF-8"?>${element(root, value ?? "", 0)}`;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Text with its entity and character references replaced. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (_m, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const v = ENTITIES[ref];
    if (v === undefined) throw new XmlError(`unknown entity &${ref};`);
    return v;
  });
}

/** An element being parsed. */
interface Open {
  name: string;
  attrs: Record<string, string>;
  children: Array<[string, unknown]>;
  text: string;
}

function valueOf(e: Open): unknown {
  if (e.children.length === 0) {
    if (Object.keys(e.attrs).length === 0) return e.text;
    return { ...prefixed(e.attrs), ...(e.text.trim() !== "" ? { "#text": e.text } : {}) };
  }
  const groups = new Map<string, unknown[]>();
  for (const [name, v] of e.children) {
    const list = groups.get(name);
    if (list) list.push(v);
    else groups.set(name, [v]);
  }
  const out: Record<string, unknown> = prefixed(e.attrs);
  for (const [name, values] of groups) out[name] = values.length === 1 ? values[0] : values;
  return out;
}

function prefixed(attrs: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [`@${k}`, v]));
}

const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

/** Skip a construct starting at `i` that holds no data: declaration, processing instruction, comment. */
function skipMarkup(xml: string, i: number): number {
  const ends: Array<[string, string]> = [
    ["<?", "?>"],
    ["<!--", "-->"],
  ];
  for (const [start, end] of ends) {
    if (xml.startsWith(start, i)) {
      const j = xml.indexOf(end, i + start.length);
      if (j < 0) throw new XmlError(`unterminated ${start}`);
      return j + end.length;
    }
  }
  return -1;
}

/** Handle a tag at `i` (`<…`); returns the index after it. */
function tag(xml: string, i: number, stack: Open[], done: (v: { name: string; value: unknown }) => void): number {
  const skipped = skipMarkup(xml, i);
  if (skipped >= 0) return skipped;
  if (xml.startsWith("<!DOCTYPE", i) || xml.startsWith("<!ENTITY", i)) throw new XmlError("DTDs and entity declarations are not accepted");
  if (xml.startsWith("<![CDATA[", i)) return cdata(xml, i, stack);
  const end = xml.indexOf(">", i);
  if (end < 0) throw new XmlError("unterminated tag");
  const body = xml.slice(i + 1, end);
  if (body.startsWith("/")) {
    closingTag(body.slice(1).trim(), stack, done);
    return end + 1;
  }
  const selfClosing = body.endsWith("/");
  const inner = selfClosing ? body.slice(0, -1) : body;
  const name = /^[^\s/>]+/.exec(inner)?.[0] ?? "";
  if (!NAME.test(name)) throw new XmlError(`\`${name}\` is not an XML element name`);
  if (stack.length >= XML_MAX_DEPTH) throw new XmlError(`nested deeper than ${XML_MAX_DEPTH} elements`);
  const open: Open = { name, attrs: parseAttrs(inner.slice(name.length)), children: [], text: "" };
  if (selfClosing) close(open, stack, done);
  else stack.push(open);
  return end + 1;
}

/** A CDATA section's text, appended to the element it is in; the index after it. */
function cdata(xml: string, i: number, stack: Open[]): number {
  const j = xml.indexOf("]]>", i);
  if (j < 0 || stack.length === 0) throw new XmlError("misplaced or unterminated CDATA section");
  stack[stack.length - 1]!.text += xml.slice(i + 9, j);
  return j + 3;
}

function closingTag(name: string, stack: Open[], done: (v: { name: string; value: unknown }) => void): void {
  const open = stack.pop();
  if (!open || open.name !== name) throw new XmlError(`unexpected closing tag </${name}>`);
  close(open, stack, done);
}

function close(open: Open, stack: Open[], done: (v: { name: string; value: unknown }) => void): void {
  const value = valueOf(open);
  const parent = stack[stack.length - 1];
  if (parent) parent.children.push([open.name, value]);
  else done({ name: open.name, value });
}

/** An XML document as `{ <root>: <value> }`. */
export function xmlDecode(xml: string): Record<string, unknown> {
  const stack: Open[] = [];
  let root: { name: string; value: unknown } | undefined;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(text);
    else if (text.trim() !== "") throw new XmlError("text outside the root element");
    if (lt < 0) break;
    if (root && skipMarkup(xml, lt) < 0) throw new XmlError("more than one root element");
    i = tag(xml, lt, stack, (r) => (root = r));
  }
  if (stack.length > 0) throw new XmlError(`unclosed element <${stack[stack.length - 1]!.name}>`);
  if (!root) throw new XmlError("no root element");
  return { [root.name]: root.value };
}
