/**
 * docs/recipes.md, entirely, from packages/adapters/recipes/*.yaml: one section per provider (its API defaults,
 * sources and assumptions) and one per op (params, an example line, what it expands into). Called by
 * scripts/gen-docs.ts.
 */
import { Document, isScalar, stringify, visit } from "yaml";
import { loadRecipes, type Recipe, type RecipeOp } from "../packages/adapters/src/index.js";
import { cell, show, slug } from "./md.js";

/** The heading of a recipe op's section, and so its anchor (`cloudflaredns_cname`). */
export function recipeHeading(provider: string, op: string): string {
  return `### \`${provider}.${op}\``;
}

/** The link to a recipe op's section of docs/recipes.md, relative to `from` (a file in docs/). */
export function recipeLink(provider: string, op: string): string {
  return `[\`${provider}.${op}\`](recipes.md#${slug(recipeHeading(provider, op).slice(4))})`;
}

function credential(api: Record<string, unknown> | undefined): string {
  if (!api) return "none (calls the app's own URL)";
  const auth = api.auth as Record<string, unknown>;
  if (typeof auth.bearer_env === "string") return `\`${auth.bearer_env}\` (bearer)`;
  if (typeof auth.value_env === "string") return `\`${String(auth.value_env)}\` (header \`${String(auth.header)}\`${typeof auth.prefix === "string" ? `, after \`${auth.prefix.trimEnd()}\`` : ""})`;
  const oauth = auth.oauth2_client_credentials as Record<string, string> | undefined;
  if (oauth) return `\`${oauth.client_id_env}\` / \`${oauth.client_secret_env}\` (OAuth2 client credentials)`;
  if (Array.isArray(auth.command)) return `the token \`${auth.command.join(" ")}\` prints (bearer)`;
  if (typeof auth.aws_sigv4 === "object" && auth.aws_sigv4 !== null) {
    const s = auth.aws_sigv4 as Record<string, string>;
    return `\`${s.access_key_id_env}\` / \`${s.secret_access_key_env}\`${s.session_token_env ? ` (and \`${s.session_token_env}\`)` : ""} (AWS SigV4, \`${s.service}\` in \`${s.region}\`)`;
  }
  return otherCredential(auth);
}

/** The forms `credential` leaves: several headers, HTTP Digest, Basic. */
function otherCredential(auth: Record<string, unknown>): string {
  if (Array.isArray(auth.headers)) return (auth.headers as Array<Record<string, string>>).map((h) => `\`${h.value_env}\` (header \`${h.header}\`)`).join(" and ");
  const digest = auth.digest as Record<string, string> | undefined;
  if (digest) return `\`${digest.user_env}\` / \`${digest.password_env}\` (HTTP Digest)`;
  const basic = auth.basic as Record<string, string>;
  return `\`${basic.user_env}\` / \`${basic.password_env}\` (basic)`;
}

/** A recipe's http spec as YAML, each `{ param: <name> }` on one line as the recipe file writes it. */
function templateYaml(http: Record<string, unknown>): string {
  const doc = new Document(http);
  visit(doc, {
    Map(_, node) {
      const [first] = node.items;
      if (node.items.length === 1 && first && isScalar(first.key) && first.key.value === "param") node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0 }).trimEnd();
}

/** The params a docs example sets: every param with an example value. */
export function exampleParams(op: RecipeOp): Record<string, unknown> {
  return Object.fromEntries(Object.entries(op.params).flatMap(([n, p]) => (p.example === undefined ? [] : [[n, p.example]])));
}

function exampleLine(r: Recipe, name: string, op: RecipeOp): string {
  const line = { id: name, adapter: "http", op: op.kind, recipe: `${r.provider}.${name}`, ...exampleParams(op) };
  if (!r.api || typeof r.api.base_url === "string") return `# under changes: (no provider block needed)\n${stringify([line], { lineWidth: 0 }).trimEnd()}`;
  // A per-account API: the block names the account's base URL.
  const block = stringify({ providers: { http: { [r.provider]: { recipe: r.provider, base_url: r.base_url_example } } } }, { lineWidth: 0 }).trimEnd();
  return `${block}\nchanges:\n${stringify([line], { lineWidth: 0 }).trimEnd().replace(/^/gm, "  ")}`;
}

function paramsTable(op: RecipeOp): string[] {
  const rows = ["| Param | Type | Required | Default | Meaning |", "|---|---|---|---|---|"];
  for (const [n, p] of Object.entries(op.params)) {
    const extra = [p.enum ? `One of ${p.enum.map((e) => `\`${show(e)}\``).join(", ")}.` : "", p.pattern ? `Matches \`${p.pattern}\`.` : ""].filter(Boolean).join(" ");
    rows.push(`| \`${n}\` | ${p.type} | ${p.required ? "yes" : "no"} | ${p.default === undefined ? "—" : `\`${show(p.default)}\``} | ${cell([p.description, extra].filter(Boolean).join(" "))} |`);
  }
  return rows;
}

function outputsOf(op: RecipeOp): string {
  if (op.kind === "list_item") return "none";
  if (op.kind === "action") return Object.keys((op.http.outputs as Record<string, unknown> | undefined) ?? {}).map((o) => `\`${o}\``).join(", ") || "none";
  const outputs = Object.entries((op.http.outputs as Record<string, unknown> | undefined) ?? {});
  const mark = (d: unknown) => {
    const decl = (typeof d === "object" && d !== null ? d : {}) as { sensitive?: boolean; once?: boolean };
    return decl.once ? " (sensitive, [once](plan-format.md#once-only-outputs): only from the create)" : decl.sensitive ? " (sensitive)" : "";
  };
  return ["`id`", ...outputs.map(([o, d]) => `\`${o}\`${mark(d)}`)].join(", ");
}

/** What destroying the scope does with what the op made. */
function destroyOf(op: RecipeOp): string {
  if (op.kind === "action") return op.http.undo ? "its `undo` request is sent, then the record is forgotten." : "nothing is sent (there is nothing to undo); the record is forgotten.";
  if (op.destroy === "never") return "left in place: the provider offers no way to delete it (`destroy: delete` is refused).";
  if (op.destroy === "keep") return "left in place by default (`destroy: delete` on the line removes it).";
  return "deleted (`destroy: keep` on the line leaves it).";
}

function opSection(r: Recipe, name: string, op: RecipeOp): string[] {
  return [
    recipeHeading(r.provider, name),
    "",
    `**${op.title}** (\`http.${op.kind}\`). ${op.summary}`,
    "",
    `Covers: ${op.covers.map((c) => `\`${c}\``).join(", ") || "—"} in [the coverage matrix](coverage.md#coverage-matrix). Outputs: ${outputsOf(op)}. On destroy: ${destroyOf(op)}`,
    "",
    ...paramsTable(op),
    "",
    "```yaml",
    exampleLine(r, name, op),
    "```",
    "",
    `What the line expands into: the [\`http.${op.kind}\`](plan-format.md#http${op.kind}) params, \`{ param: <name> }\` standing for a param's value${JSON.stringify(op.http).includes('"join":') ? ", `{ join: [...] }` for its parts joined into one string," : ""} and \`{<name>}\` in a path for its URI-encoded value.`,
    "",
    "```yaml",
    templateYaml(op.http),
    "```",
    "",
  ];
}

/** A recipe's credential refusal, as a table cell. */
function refused(r: { prefixes: string[]; unless_env: string }): string {
  return `credentials starting ${r.prefixes.map((p) => `\`${p}\``).join(" or ")} are refused (\`PROVIDER_AUTH\`) unless \`${r.unless_env}=1\`; a plan cannot override this`;
}

/** An OAuth2 recipe's token endpoint and audience (a path: on the origin of the plan's `base_url`), as table rows. */
function tokenRows(api: Record<string, unknown>): string[] {
  const oauth = (api.auth as Record<string, unknown>).oauth2_client_credentials as Record<string, string> | undefined;
  if (!oauth) return [];
  const where = (v: string) => (v.startsWith("/") ? `\`${v}\` on the origin of \`base_url\`` : `\`${v}\``);
  return [
    `| Token endpoint | ${where(oauth.token_url!)}; override: \`${oauth.token_url_env}\` |`,
    ...(oauth.audience ? [`| Audience | ${where(oauth.audience)} |`] : []),
    ...(oauth.scope ? [`| Scope | \`${oauth.scope}\` |`] : []),
  ];
}

/** The API defaults table, or what a recipe without an API block does instead. */
function apiTable(api: Record<string, unknown> | undefined): string[] {
  if (!api) return ["No API block: its ops send their request to the app's own URL (a param), with no credential."];
  return [
    "| API default | Value |",
    "|---|---|",
    `| \`base_url\` | ${typeof api.base_url === "string" ? `\`${api.base_url}\`` : "none: set it in the provider block"} |`,
    `| \`base_url_env\` | \`${String(api.base_url_env)}\` |`,
    `| Credential | ${credential(api)} |`,
    ...tokenRows(api),
    ...(api.headers ? [`| \`headers\` | ${cell(JSON.stringify(api.headers))} |`] : []),
    ...(api.encoding ? [`| \`encoding\` | \`${String(api.encoding)}\` |`] : []),
    ...(api.refuse_credential ? [`| \`refuse_credential\` | ${refused(api.refuse_credential as { prefixes: string[]; unless_env: string })} |`] : []),
  ];
}

function providerSection(r: Recipe): string[] {
  return [
    `## ${r.title}`,
    "",
    `Recipe file: [\`packages/adapters/recipes/${r.provider}.yaml\`](../packages/adapters/recipes/${r.provider}.yaml). Verified on ${r.verified_on} against:`,
    "",
    ...r.docs.map((d) => `- [${d.title}](${d.url})`),
    "",
    ...apiTable(r.api),
    "",
    "Assumptions:",
    "",
    ...r.assumptions.map((a) => `- **${a.id}** ${a.verified ? `(verified${a.source ? `, [source](${a.source})` : ""})` : "**(unverified)**"}: ${a.text}`),
    "",
    ...Object.entries(r.ops).flatMap(([name, op]) => opSection(r, name, op)),
  ];
}

export function renderRecipes(): string {
  const recipes = loadRecipes();
  const index = ["| Recipe | Op | What it manages | Credential |", "|---|---|---|---|"];
  for (const r of recipes) for (const [name, op] of Object.entries(r.ops)) index.push(`| ${recipeLink(r.provider, name).replace("recipes.md", "")} | \`${op.kind}\` | ${cell(op.title)} | ${credential(r.api)} |`);
  const lines = [
    "<!-- Generated by scripts/gen-docs.ts from packages/adapters/recipes/*.yaml. Do not edit: run `pnpm docs:gen`. -->",
    "",
    "# Recipes",
    "",
    "A recipe is a verified [`http`](plan-format.md#the-generic-http-adapter) spec for one operation of one provider,",
    "shipped with Sponson: the line names it and fills in its params, and the requests, envelopes, ids and drift rules",
    "come from the recipe. Everything the generic adapter guarantees holds unchanged (intents before creates, idempotent",
    "apply, drift by hash, destroy only what Sponson created). Why and how: [ADR 0020](adr/0020-recipes.md).",
    "",
    "```yaml",
    "providers:",
    "  http:",
    "    cloudflare: { recipe: cloudflare }   # optional: the recipe's API defaults; override base_url, auth, headers here",
    "changes:",
    "  - id: preview_dns",
    "    adapter: http",
    "    op: resource                         # the recipe's kind: resource or list_item",
    "    recipe: cloudflare.dns_cname",
    "    zone_id: 023e105f4ecef8ad9ca31a8372d0c353",
    "    name: \"${ctx.scope}.preview.example.com\"",
    "    target: preview-host.example.net",
    "```",
    "",
    "- `recipe: <provider>.<op>` picks the operation; `api` defaults to `<provider>`, and so does its block under",
    "  `providers.http`: write the block only to override `base_url`, `base_url_env`, `auth`, `headers` or `encoding`.",
    "- Every other key of the line is one of the recipe's params. Values are literals, `${ctx.*}`, `{ from }`,",
    "  `{ secret }` or `{ keep: true }`, as anywhere in a plan. An unknown param, a missing required one or a value of",
    "  the wrong type is `PARAM_INVALID` naming it, before any request; an unknown recipe or op lists the known ones.",
    "- `destroy: keep` leaves what the line made in place when the scope is destroyed.",
    "- Identity: the ledger records the API block as resolved (base URL, credential variable, headers, encoding) and the",
    "  keys and record ids of the expanded requests, never the recipe's text. A line written by hand with the same",
    "  values is the same resource, and a new Sponson version whose recipe changes only its docs, params or assumptions",
    "  re-identifies nothing.",
    "",
    "Every op below is tested by `scenarios/recipes.test.ts` against the local fake cloud (create, idempotent re-apply,",
    "drift, destroy), and live with `pnpm test:live` when its credential and the `SPONSON_LIVE_*` variables its recipe",
    "names are set.",
    "",
    ...index,
    "",
    ...recipes.flatMap(providerSection),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
