import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // core/ stays free of the VS Code API so it runs under plain Node in tests.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vscode", message: "src/core must not import vscode." }] }],
    },
  },
  {
    files: ["esbuild.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
);
