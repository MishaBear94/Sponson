/**
 * The public API of every package, as a reviewed list. A new export fails this test until it is added here, so
 * widening the API is a decision made in review rather than a side effect of `export *`; a removed one fails it
 * too (it may break users). Every export must also carry a doc comment that says when to use it.
 *
 * Lives in core because core is the root of the dependency graph; it only reads the other packages' sources.
 */
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PUBLIC_API: Record<string, string[]> = {
  "@sponson/core": [
    "AdapterContext", "AdoptedLine", "AncestryCheck", "ApplyResult", "ApplyResultSummary", "Change", "Ctx",
    "DiffKind", "DiffSide", "Drift", "DriftKind", "ERROR_CODES", "ErrorCode", "ErrorCodeSpec", "ExitCode", "FromRef",
    "GitBranchReceiptStore", "GitBranchStoreOptions", "KeepRef", "Ledger", "LedgerEntry", "LineOutputs", "LineStatus",
    "Literal", "LiveState", "LocalReceiptStore", "LockHeldError", "LockInfo", "LockLostError", "MASK",
    "MIN_REDACT_LENGTH", "MarkerKind", "OpSpec", "OutputSpec", "PLAN_FILENAME", "ParseWarning", "ParsedPlan", "Plan",
    "PlanLine", "PlanLineStatus", "PlanResult", "RECEIPT_VERSION", "Receipt", "ReceiptLine", "ReceiptStore",
    "RedactDeepOptions", "Redactor", "Registry", "ResolveResult", "ResolvedParams", "ResolvedValue",
    "ResourceAdapter", "ResourceDiff", "ResourceRecord", "RunOptions", "RunStatus", "SecretRef", "SecretSource",
    "SponsonError", "Staleness", "ValueSpec", "ValueState", "WARNING_CODES", "WarningCode", "applyRun",
    "canonicalJson", "changesFor", "cliHintFor", "dependenciesOf", "dependentsOf", "destroyRun", "exitCodeFor",
    "identity", "interpolate", "isFromRef", "isKeepMarker", "isKeepRef", "isPendingMarker", "isSecretRef",
    "isSponsonError", "latestPath", "loadPlan", "lockExpired", "lockPath", "markerKind", "migrateV1", "orderChanges",
    "outputRefs", "parseLock", "parsePlan", "parseReceipt", "pendingMarker", "pendingRef", "planRun", "receiptDir",
    "resolveParams", "runPath", "scopeFor", "secretRefs", "serialize", "sha256", "shortHash", "staleness",
    "walkParams",
  ],
  "@sponson/adapters": [
    "ApiClient", "ApiClientOptions", "CLERK_DEFAULT_API_URL", "DEFAULT_RETRIES", "DEFAULT_RETRY_BASE_MS",
    "DEFAULT_TIMEOUT_MS", "Exec", "HTTP_ERROR_BODY_LIMIT", "MAX_PAGES", "MAX_RETRY_WAIT_MS", "NEON_DEFAULT_API_URL",
    "Page", "ProviderErrorCode", "ProviderErrorDetails", "Shape", "ShapeError", "VERCEL_DEFAULT_API_URL", "apiClient",
    "assertNoPending", "backoffMs", "classifyStatus", "clerkAdapter", "clientFor", "createRegistry", "defaultExec",
    "deleteIgnoringNotFound", "desiredSide", "diffValue", "dopplerSecretSource", "envSecretSource", "excerptOf",
    "isObject", "isProviderError", "isTransient", "listAll", "neonAdapter", "obj", "opSecretSource", "paramError",
    "records", "requireEnv", "requireProvider", "retryAfterMs", "stringParam", "vercelAdapter", "withQuery",
  ],
  "@sponson/sim": [
    "CHAOS_KEYS", "ChaosAction", "ChaosConfig", "ChaosRequest", "ClerkRedirect", "ClerkSeed", "ClerkState",
    "CreatedBy", "DEFAULT_CHAOS", "DEFAULT_SEED", "DeploymentState", "DriftRequest", "NeonBranch", "NeonProject",
    "NeonSeed", "NeonState", "PROVIDERS", "ProviderName", "ProviderSim", "ProviderStates", "Reply", "RouteRequest",
    "SIM_TOKENS", "SimCore", "SimHandle", "SimSeed", "SimState", "VercelDeployment", "VercelEnv", "VercelProject",
    "VercelSeed", "VercelState", "WriteLogEntry", "chaosFor", "clerkSim", "connectionUri", "createBranch",
    "createDeployment", "createSimServer", "defaultChaos", "matchesRule", "neonSim", "page", "providerEntries",
    "refreshDeployments", "simEnv", "startSim", "vercelSim",
  ],
  "sponson": [
    "CtxFacts", "CtxOverrides", "CtxSource", "DEFAULT_CTX_SOURCES", "RunIO", "SponsonPlugin", "detectCtx",
    "githubActionsSource", "localGitSource", "run", "sponsonEnvSource",
  ],
};

const ENTRY: Record<string, string> = {
  "@sponson/core": "packages/core/src/index.ts",
  "@sponson/adapters": "packages/adapters/src/index.ts",
  "@sponson/sim": "packages/sim/src/index.ts",
  sponson: "packages/cli/src/index.ts",
};

const root = fileURLToPath(new URL("../../../", import.meta.url));

function surfaces(): Map<string, Array<{ name: string; documented: boolean }>> {
  const files = Object.values(ENTRY).map((f) => root + f);
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const out = new Map<string, Array<{ name: string; documented: boolean }>>();
  for (const [pkg, file] of Object.entries(ENTRY)) {
    const module = checker.getSymbolAtLocation(program.getSourceFile(root + file)!)!;
    out.set(
      pkg,
      checker.getExportsOfModule(module).map((e) => {
        const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        const documented = (target.declarations ?? []).some((d) => ts.getJSDocCommentsAndTags(ts.isVariableDeclaration(d) ? d.parent.parent : d).length > 0);
        return { name: e.name, documented };
      }),
    );
  }
  return out;
}

describe("public API", () => {
  const actual = surfaces();

  it.each(Object.keys(ENTRY))("%s exports exactly the reviewed list", (pkg) => {
    const names = actual.get(pkg)!.map((e) => e.name);
    const allowed = new Set(PUBLIC_API[pkg]);
    const added = names.filter((n) => !allowed.has(n)).sort();
    const removed = [...allowed].filter((n) => !names.includes(n)).sort();
    // A new export: document it and add it to PUBLIC_API above, or stop exporting it.
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it.each(Object.keys(ENTRY))("every export of %s has a doc comment", (pkg) => {
    expect(actual.get(pkg)!.filter((e) => !e.documented).map((e) => e.name)).toEqual([]);
  });
});
