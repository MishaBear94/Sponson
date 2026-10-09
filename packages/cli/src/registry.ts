import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Registry, SponsonError } from "@sponson/core";

/**
 * A third-party extension: a module that exports `register` (named or as its default export) and adds
 * adapters and secret sources to the registry the CLI and the MCP server use.
 */
export interface SponsonPlugin {
  register(registry: Registry): void | Promise<void>;
}

/** The production registry: every adapter and secret source that ships with Sponson. */
export async function defaultRegistry(): Promise<Registry> {
  const adapters = await import("@sponson/adapters");
  return adapters.createRegistry();
}

/** The module specifiers listed in `$SPONSON_PLUGINS` (comma-separated; blanks ignored). */
export function pluginSpecifiers(env: NodeJS.ProcessEnv): string[] {
  return (env.SPONSON_PLUGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Load every plugin in `$SPONSON_PLUGINS` into `registry`, in order. Specifiers resolve like an `import`
 * written in a file in `cwd`: package names from its node_modules, relative paths against it.
 * Any failure is ADAPTER_UNKNOWN naming the plugin, so a broken plugin is never silently skipped.
 */
export async function loadPlugins(registry: Registry, env: NodeJS.ProcessEnv, cwd: string): Promise<Registry> {
  const require = createRequire(join(cwd, "noop.js"));
  for (const plugin of pluginSpecifiers(env)) {
    const fail = (reason: string, cause?: unknown): never => {
      throw new SponsonError("ADAPTER_UNKNOWN", `Plugin \`${plugin}\` (from SPONSON_PLUGINS) ${reason}`, {
        plugin,
        ...(cause instanceof Error ? { cause: cause.message } : {}),
      });
    };
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(require.resolve(plugin)).href)) as Record<string, unknown>;
    } catch (e) {
      return fail(`could not be loaded: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    const register = registerOf(mod);
    if (!register) return fail("must export `register(registry)` or default-export it (or an object with `register`).");
    try {
      await register(registry);
    } catch (e) {
      return fail(`failed in register(): ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }
  return registry;
}

function registerOf(mod: Record<string, unknown>): SponsonPlugin["register"] | undefined {
  const candidates = [mod.register, mod.default, (mod.default as { register?: unknown } | null | undefined)?.register];
  return candidates.find((c): c is SponsonPlugin["register"] => typeof c === "function");
}
