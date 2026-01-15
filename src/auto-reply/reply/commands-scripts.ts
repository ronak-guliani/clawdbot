import { exec, spawn } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import { logVerbose } from "../../globals.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const execAsync = promisify(exec);

// Custom clawd-* commands that run shell scripts
const CLAWD_SCRIPT_COMMANDS: Record<string, { path: string; restart: boolean }> = {
  // Short aliases (preferred)
  "/update": { path: "~/clawd-scripts/update.sh", restart: true },
  "/restart": { path: "~/clawd-scripts/restart.sh", restart: true },
  "/revert": { path: "~/clawd-scripts/revert.sh", restart: true },
  "/push": { path: "~/clawd-scripts/push.sh", restart: false },
  "/git-status": { path: "~/clawd-scripts/git-status.sh", restart: false },
  "/doctor": { path: "~/clawd-scripts/doctor.sh", restart: false },
  "/logs": { path: "~/clawd-scripts/logs.sh", restart: false },
  "/crons": { path: "~/clawd-scripts/crons.sh", restart: false },
  "/copilot-models": { path: "~/clawd-scripts/models.sh", restart: false },
  // Legacy aliases (for backwards compatibility)
  "/clawd-update": { path: "~/clawd-scripts/update.sh", restart: true },
  "/clawd-restart": { path: "~/clawd-scripts/restart.sh", restart: true },
  "/clawd-revert": { path: "~/clawd-scripts/revert.sh", restart: true },
  "/clawd-push": { path: "~/clawd-scripts/push.sh", restart: false },
  "/clawd-git-status": { path: "~/clawd-scripts/git-status.sh", restart: false },
  "/clawd-doctor": { path: "~/clawd-scripts/doctor.sh", restart: false },
  "/clawd-logs": { path: "~/clawd-scripts/logs.sh", restart: false },
};

export const handleScriptCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  const { command, ctx } = params;
  const scriptDef = CLAWD_SCRIPT_COMMANDS[command.commandBodyNormalized];

  if (!allowTextCommands || !scriptDef) {
    return null;
  }

  if (!command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${command.commandBodyNormalized} from unauthorized sender: ${command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const expandedPath = scriptDef.path.replace("~", process.env.HOME || "/home/azureuser");
  const lockFile = "/tmp/clawd-command.lock";

  if (scriptDef.restart) {
    try {
      const stat = fs.statSync(lockFile);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 300000) {
        return {
          shouldContinue: false,
          reply: { text: "⏳ A restart operation is already in progress. Please wait." },
        };
      }
    } catch {
      /* lock file does not exist, proceed */
    }

    fs.writeFileSync(lockFile, `${command.commandBodyNormalized} started at ${new Date().toISOString()}`);

    try {
      const subprocess = spawn(expandedPath, [], {
        detached: true,
        stdio: "ignore",
      });
      subprocess.unref();
      return {
        shouldContinue: false,
        reply: { text: "🔄 Process initiated in background. You will receive a Telegram notification when complete." },
      };
    } catch {
      fs.unlinkSync(lockFile);
      return {
        shouldContinue: false,
        reply: { text: "❌ Failed to spawn background process." },
      };
    }
  } else {
    try {
      const { stdout, stderr } = await execAsync(expandedPath, { timeout: 300000 });
      const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 4000);
      return {
        shouldContinue: false,
        reply: { text: cleanOutput || "✅ Command completed (no output)." },
      };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      const errorOutput = (error.stdout || "") + (error.stderr || "") || error.message || "Unknown error";
      const cleanError = errorOutput.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 4000);
      return {
        shouldContinue: false,
        reply: { text: `❌ Command failed:\n${cleanError}` },
      };
    }
  }
};

// Branch switching commands (/branch, /main)
export const handleBranchCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  const { command, ctx } = params;
  
  const branchCommandMatch = command.commandBodyNormalized.match(/^\/branch(?:\s+(.+))?$/);
  const mainCommandMatch = command.commandBodyNormalized === "/main";

  if (!allowTextCommands || (!branchCommandMatch && !mainCommandMatch)) {
    return null;
  }

  if (!command.isAuthorizedSender) {
    logVerbose(
      `Ignoring branch command from unauthorized sender: ${command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const lockFile = "/tmp/clawdbot-branch-switch.lock";

  // Check for concurrent execution
  try {
    const stat = fs.statSync(lockFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 300000) {
      return {
        shouldContinue: false,
        reply: { text: "⏳ A branch switch is already in progress. Please wait." },
      };
    }
  } catch {
    /* lock file does not exist, proceed */
  }

  const chatId = ctx.OriginatingTo || ctx.SenderId || "";
  
  let currentBranch = "main";
  try {
    const { execSync } = await import("child_process");
    currentBranch = execSync("git -C /home/azureuser/clawdbot-source rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
  } catch {
    currentBranch = "main";
  }

  if (mainCommandMatch) {
    if (currentBranch === "main") {
      return {
        shouldContinue: false,
        reply: { text: "Already on `main` branch." },
      };
    }

    const subprocess = spawn(
      "/home/azureuser/clawdbot-branch-switch.sh",
      ["main", chatId, currentBranch],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    subprocess.unref();

    return {
      shouldContinue: false,
      reply: { text: "Switching to `main` branch. I'll notify you when complete." },
    };
  }

  if (branchCommandMatch) {
    const targetBranch = branchCommandMatch[1]?.trim();

    if (!targetBranch) {
      // Show current branch
      return {
        shouldContinue: false,
        reply: {
          text: `Current branch: \`${currentBranch}\`\n\nUsage:\n- \`/branch <name>\` - switch to branch\n- \`/main\` - switch to main branch`,
        },
      };
    }

    const subprocess = spawn(
      "/home/azureuser/clawdbot-branch-switch.sh",
      [targetBranch, chatId, currentBranch],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    subprocess.unref();

    return {
      shouldContinue: false,
      reply: { text: `Switching to branch \`${targetBranch}\`. I'll notify you when complete.` },
    };
  }

  return null;
};
