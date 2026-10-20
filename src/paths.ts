import { fileURLToPath } from "node:url";
import path from "node:path";

/** Root of this package: bundled assets (bridge, pointer backend, Steam helper) live here. */
export const harnessPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
