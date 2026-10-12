import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const MAX_FILE_BYTES = 200_000; // don't let the local model read/write giant files blind
const MAX_COMMAND_OUTPUT = 20_000; // characters, truncated beyond this

/**
 * Resolve a user-supplied relative path against workingDir and refuse
 * anything that escapes it (path traversal, absolute paths elsewhere, symlink tricks).
 */
function resolveSafe(workingDir, userPath) {
  const root = path.resolve(workingDir);
  const target = path.resolve(root, userPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Refused: "${userPath}" resolves outside the working directory (${root}).`
    );
  }
  return target;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated, ${str.length - max} more characters]`;
}

/**
 * Tool schemas in OpenAI function-calling format, plus the implementations
 * that actually execute them. `readOnly` strips out write_file/run_command
 * entirely so the local model is never even offered them.
 */
export function buildTools(workingDir, { readOnly }) {
  const defs = [];
  const impls = {};

  defs.push({
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List files and directories at a path relative to the project working directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the working directory. Use \".\" for the root.",
          },
        },
        required: ["path"],
      },
    },
  });
  impls.list_dir = ({ path: p }) => {
    const target = resolveSafe(workingDir, p);
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "f"}  ${e.name}`)
      .sort()
      .join("\n");
  };

  defs.push({
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file's contents, given a path relative to the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory." },
        },
        required: ["path"],
      },
    },
  });
  impls.read_file = ({ path: p }) => {
    const target = resolveSafe(workingDir, p);
    const stat = fs.statSync(target);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `Refused: ${p} is ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit.`
      );
    }
    return fs.readFileSync(target, "utf8");
  };

  if (!readOnly) {
    defs.push({
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create or overwrite a text file at a path relative to the working directory. Creates parent directories as needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the working directory." },
            content: { type: "string", description: "Full new contents of the file." },
          },
          required: ["path", "content"],
        },
      },
    });
    impls.write_file = ({ path: p, content }) => {
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        throw new Error(`Refused: content exceeds ${MAX_FILE_BYTES} bytes.`);
      }
      const target = resolveSafe(workingDir, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const existed = fs.existsSync(target);
      fs.writeFileSync(target, content, "utf8");
      return `${existed ? "Overwrote" : "Created"} ${p} (${Buffer.byteLength(content, "utf8")} bytes).`;
    };

    defs.push({
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command inside the working directory (e.g. run tests, a linter, or a build). Runs via /bin/sh -c.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run." },
          },
          required: ["command"],
        },
      },
    });
    impls.run_command = ({ command }) => {
      const blocked = [
        /rm\s+-rf\s+\/(?!\S)/, // rm -rf /
        /:\(\)\s*\{.*\};:/, // fork bomb
        /\bsudo\b/,
        /\bcurl\b.*\|\s*sh\b/,
        /\bwget\b.*\|\s*sh\b/,
        />\s*\/dev\/sd[a-z]/,
      ];
      if (blocked.some((re) => re.test(command))) {
        throw new Error(`Refused: command matched a blocked pattern.`);
      }
      try {
        const out = execSync(command, {
          cwd: path.resolve(workingDir),
          timeout: Number(process.env.LM_DELEGATE_COMMAND_TIMEOUT_MS || 120_000),
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf8",
          shell: "/bin/sh",
        });
        return truncate(out || "(no output)", MAX_COMMAND_OUTPUT);
      } catch (err) {
        const out = `${err.stdout || ""}${err.stderr || ""}` || err.message;
        return truncate(`Command failed (exit ${err.status ?? "?"}):\n${out}`, MAX_COMMAND_OUTPUT);
      }
    };
  }

  return { defs, impls };
}
