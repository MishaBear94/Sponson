import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Root-level suites (scenarios, property) import workspace packages by name; resolve them to sources.
const alias = {
  "@sponson/core": pkg("core"),
  "@sponson/adapters": pkg("adapters"),
  "@sponson/sim": pkg("sim"),
  sponson: pkg("cli"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "packages/adapters/src/testing.ts", "packages/*/src/bin.ts"],
      reporter: ["text-summary", "text"],
    },
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["packages/*/src/**/*.test.ts"], testTimeout: 20000 } },
      // Scenarios exclude the tooling suites below, which are CPU-heavy (they run tsc and eslint)
      // and would steal time from the timing-sensitive concurrency journeys if run alongside them.
      { resolve: { alias }, test: { name: "scenarios", include: ["scenarios/**/*.test.ts"], exclude: ["scenarios/tooling/**", "scenarios/docs/**"], testTimeout: 60000 } },
      { resolve: { alias }, test: { name: "tooling", include: ["scenarios/tooling/**/*.test.ts", "scenarios/docs/**/*.test.ts"], testTimeout: 180000 } },
      { resolve: { alias }, test: { name: "property", include: ["property/**/*.test.ts"], testTimeout: 300000 } },
    ],
  },
});
