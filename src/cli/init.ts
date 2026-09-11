// `quotacap init`: explicit config inspection and reset. Stdout keeps the
// effective config as JSON; human guidance goes to stderr; --quiet prints
// nothing on success and --force rewrites defaults after backing up.
import type { Command } from "commander";
import fsSync from "node:fs";
import {
  defaultConfig,
  ensureConfig,
  getConfigPath,
  readConfig,
  writeConfig,
} from "../config.js";

const NEXT_STEP =
  "next: run 'quotacap web' to open the dashboard, 'quotacap service status' to check the background service";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("show or reset the config file")
    .option("--quiet", "print nothing on success")
    .option("--force", "rewrite defaults after moving the existing file to config.json.bak")
    .action(async (o) => {
      const p = getConfigPath();
      if (o.force && fsSync.existsSync(p)) {
        fsSync.renameSync(p, `${p}.bak`);
        await writeConfig(defaultConfig());
        if (o.quiet) return;
        console.log(JSON.stringify(await readConfig(), null, 2));
        console.error(`rewrote default config at ${p} (previous saved to ${p}.bak)\n${NEXT_STEP}`);
        return;
      }
      const r = await ensureConfig();
      if (o.quiet) return;
      console.log(JSON.stringify(r.config, null, 2));
      console.error(
        r.created
          ? `wrote default config to ${p}\n${NEXT_STEP}`
          : `config already exists at ${p} (use --force to rewrite defaults)\n${NEXT_STEP}`,
      );
    });
}
