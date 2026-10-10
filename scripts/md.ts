/** Markdown helpers shared by the documentation generators. */

/** Markdown table cells cannot contain a raw `|` or a newline; backslashes are escaped first so `\|` survives. */
export function cell(s: string | undefined): string {
  return (s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** GitHub's anchor for a Markdown heading (enough of github-slugger for our headings). */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** A value as it reads in a table or a YAML flow: strings as they are, anything else as JSON. */
export function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
