#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

const BLOCK_START = "# >>> outlook-google-calendar-sync >>>";
const BLOCK_END = "# <<< outlook-google-calendar-sync <<<";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function promptDefault(rl, label, defaultValue) {
  return rl.question(`${label} [${defaultValue}]: `).then((answer) => answer.trim() || defaultValue);
}

async function promptInterval(rl, defaultInterval) {
  while (true) {
    const raw = await promptDefault(
      rl,
      "Polling interval in minutes (1-59)",
      String(defaultInterval),
    );

    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 59) {
      return parsed;
    }

    console.error("Invalid interval. Enter an integer between 1 and 59.");
  }
}

async function promptYesNo(rl, label, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${label} ${suffix}: `)).trim().toLowerCase();

  if (!answer) {
    return defaultYes;
  }

  if (answer === "y" || answer === "yes") {
    return true;
  }

  if (answer === "n" || answer === "no") {
    return false;
  }

  console.error("Please answer y or n.");
  return promptYesNo(rl, label, defaultYes);
}

function getCurrentCrontab() {
  try {
    return execSync("crontab -l", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : undefined;
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8")
      : String(error?.stderr || "");

    if (status === 1 && /no crontab/i.test(stderr)) {
      return "";
    }

    if (error?.code === "ENOENT") {
      throw new Error("`crontab` command not found. Install cron/crontab first.");
    }

    throw new Error(stderr || "Failed to read existing crontab");
  }
}

function stripManagedBlock(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const outputLines = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === BLOCK_START) {
      skipping = true;
      continue;
    }

    if (line.trim() === BLOCK_END) {
      skipping = false;
      continue;
    }

    if (!skipping) {
      outputLines.push(line);
    }
  }

  return outputLines.join("\n").trimEnd();
}

function writeCrontab(content) {
  execSync("crontab -", {
    input: content,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
}

function ensurePathExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} does not exist: ${targetPath}`);
  }
}

function main() {
  const rl = readline.createInterface({ input, output });

  return (async () => {
    const defaultRepoDir = process.cwd();
    const defaultNodePath = process.execPath;
    const defaultLogPath = path.join(defaultRepoDir, "logs", "cron-sync.log");
    const defaultInterval = 5;

    console.log("Configure cron job for outlook-google-calendar-sync (current user).\n");

    const repoDirInput = await promptDefault(rl, "Repository directory", defaultRepoDir);
    const repoDir = path.resolve(repoDirInput);
    ensurePathExists(repoDir, "Repository directory");

    const nodePathInput = await promptDefault(rl, "Node binary path", defaultNodePath);
    const nodePath = path.resolve(nodePathInput);
    ensurePathExists(nodePath, "Node binary");

    const intervalMinutes = await promptInterval(rl, defaultInterval);
    const schedule = `*/${intervalMinutes} * * * *`;

    const logPathInput = await promptDefault(rl, "Log file path", defaultLogPath);
    const logPath = path.resolve(logPathInput);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const cliPath = path.join(repoDir, "dist", "src", "cli.js");
    const hasBuiltCli = fs.existsSync(cliPath);

    if (!hasBuiltCli) {
      console.warn(`\nWarning: ${cliPath} not found. Run \`npm run build\` before cron executes.\n`);
    }

    const cronLine =
      `${schedule} cd ${shellQuote(repoDir)} && ` +
      `${shellQuote(nodePath)} ${shellQuote(cliPath)} once >> ${shellQuote(logPath)} 2>&1`;

    console.log("Cron entry to install:");
    console.log(cronLine);
    console.log("");

    const shouldWrite = await promptYesNo(rl, "Install/update this cron job", true);
    if (!shouldWrite) {
      console.log("Cancelled. No changes were made.");
      return;
    }

    const current = getCurrentCrontab();
    const stripped = stripManagedBlock(current);
    const managedBlock = [
      BLOCK_START,
      `# generated_at=${new Date().toISOString()}`,
      cronLine,
      BLOCK_END,
    ].join("\n");

    const updated = stripped ? `${stripped}\n\n${managedBlock}\n` : `${managedBlock}\n`;
    writeCrontab(updated);

    console.log("Cron job installed successfully.");
    console.log("Run `crontab -l` to review installed entries.");
  })()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    })
    .finally(() => {
      rl.close();
    });
}

main();
