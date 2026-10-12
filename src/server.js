#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDelegateLoop } from "./agentLoop.js";

const DEFAULT_BASE_URL = process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1";
const DEFAULT_MODEL = process.env.LM_STUDIO_MODEL; // no fallback: force explicit config
const DEFAULT_MAX_ITERATIONS = Number(process.env.LM_DELEGATE_MAX_ITERATIONS || 15);

const server = new McpServer({ name: "lm-studio-delegate", version: "0.1.0" });

function formatResult({ finalText, actions }) {
  const lines = [];
  if (actions.length) {
    lines.push(`Actions taken (${actions.length}):`);
    for (const a of actions) {
      const argSummary = JSON.stringify(a.args).slice(0, 200);
      lines.push(`- ${a.tool}(${argSummary})`);
    }
    lines.push("");
  }
  lines.push("Final report from the local model:");
  lines.push(finalText);
  return lines.join("\n");
}

server.registerTool(
  "delegate",
  {
    title: "Delegate to local model",
    description:
      "Hand a self-contained coding task off to a locally-hosted model (via LM Studio) running on the user's own machine. " +
      "The local model gets its own read/write/run-command tool loop scoped to working_dir and works until done or it hits a limit. " +
      "Use this for mechanical, well-specified work (boilerplate, repetitive edits, test scaffolding, straightforward refactors) rather than " +
      "anything requiring broad judgment \u2014 review its output before trusting it, the same as you would a junior contributor's PR.",
    inputSchema: {
      task: z
        .string()
        .describe("A precise, self-contained description of the task. Include any constraints or acceptance criteria."),
      working_dir: z
        .string()
        .describe("Absolute path to the directory the local model is confined to. It cannot read or write outside this path."),
      read_only: z
        .boolean()
        .optional()
        .describe("If true, the local model can only read files, not write or run commands. Default false."),
      context_files: z
        .array(z.string())
        .optional()
        .describe("Paths (relative to working_dir) to pre-load into the local model's context."),
      max_iterations: z
        .number()
        .optional()
        .describe(`Cap on tool-calling turns before giving up (default ${DEFAULT_MAX_ITERATIONS}).`),
    },
  },
  async ({ task, working_dir, read_only, context_files, max_iterations }) => {
    if (!DEFAULT_MODEL) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "LM_STUDIO_MODEL is not set. Set it to the exact model identifier shown in LM Studio's Local Server tab.",
          },
        ],
      };
    }
    try {
      const result = await runDelegateLoop({
        task,
        workingDir: working_dir,
        readOnly: !!read_only,
        contextFiles: context_files || [],
        baseUrl: DEFAULT_BASE_URL,
        model: DEFAULT_MODEL,
        maxIterations: max_iterations || DEFAULT_MAX_ITERATIONS,
      });
      return { content: [{ type: "text", text: formatResult(result) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `delegate failed: ${err.message}` }],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
