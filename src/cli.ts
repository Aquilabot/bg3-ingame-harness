import { loadHarnessConfig } from "./config.js";
import { createNodeBg3TestPlatform } from "./node-platform.js";
import { runBg3Test } from "./runner.js";
import { createBg3TestScenarioCatalog } from "./scenario-catalog.js";
import { describeBg3TestError } from "./errors.js";

const abortController = new AbortController();
const handleSigint = (): void => abortController.abort("SIGINT");
const handleSigterm = (): void => abortController.abort("SIGTERM");
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);

try {
  const config = await loadHarnessConfig();
  const catalog = createBg3TestScenarioCatalog(config.catalog);
  process.exitCode = await runBg3Test(
    process.argv.slice(2),
    createNodeBg3TestPlatform({
      signal: abortController.signal,
      catalog,
      modSettings: config.modSettings,
      protectedSaves: config.protectedSaves,
      modDiagnostics: config.modDiagnostics,
      workRoot: config.workRoot,
      ...(config.steamRoot === undefined ? {} : { steamRoot: config.steamRoot }),
    }),
    catalog,
    abortController.signal,
  );
} catch (error) {
  console.error(`ERROR runtime: ${describeBg3TestError(error)}`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}
