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
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["packages/*/src/**/*.test.ts"], testTimeout: 20000 } },
      { resolve: { alias }, test: { name: "scenarios", include: ["scenarios/**/*.test.ts"], testTimeout: 60000 } },
      { resolve: { alias }, test: { name: "property", include: ["property/**/*.test.ts"], testTimeout: 300000 } },
    ],
  },
});
