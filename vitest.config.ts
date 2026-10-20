import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run archives and Wine prefixes under .cache may link outside the repository.
    exclude: [...configDefaults.exclude, "**/.cache/**"],
  },
});
