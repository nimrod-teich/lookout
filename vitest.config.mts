import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode/stub-vscode.ts", import.meta.url)),
    },
  },
});
