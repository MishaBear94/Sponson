import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "brainstorm/**", "coverage/**", ".claude/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Unit tests (and the adapters' sim harness) are outside the packages' build configs; they are
          // checked with the root test config, exactly as `pnpm typecheck` does.
          allowDefaultProject: ["packages/*/src/*.test.ts", "packages/*/src/*/*.test.ts", "packages/adapters/src/testing.ts"],
          defaultProject: "tsconfig.test.json",
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
  {
    // A ceiling, not a target: a function past it reads as several decisions at once. Split it into named steps
    // (see `judge` in engine/inspect.ts, or the sims' route tables) rather than raising the number.
    files: ["packages/**/*.ts", "scripts/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { complexity: ["error", 15] },
  },
  {
    files: ["**/*.test.ts", "scenarios/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
