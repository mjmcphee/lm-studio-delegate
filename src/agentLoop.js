import path from "node:path";
import fs from "node:fs";
import { buildTools } from "./tools.js";

function systemPrompt(workingDir, readOnly) {
  return [
    `You are a focused local coding assistant running on the user's own machine.`,
    `Your working directory is: ${workingDir}`,
    `Every path you pass to a tool must be RELATIVE to this directory. You cannot and must not access anything outside it.`,
    readOnly
      ? `You are in READ-ONLY mode: you only have list_dir and read_file. You cannot write files or run commands. Produce any code or changes as text in your final answer instead.`
      : `You have list_dir, read_file, write_file, and run_command. Use run_command to run tests/builds/linters to verify your own work before finishing when that's practical.`,
    `Work efficiently. When the task is complete, stop calling tools and give a final plain-text summary: exactly what you changed (or propose, in read-only mode) and why, so a reviewer can check it at a glance.`,
  ].join("\n");
}

function buildInitialUserMessage(task, workingDir, contextFiles) {
  let msg = `Task:\n${task}`;
  if (contextFiles && contextFiles.length) {
    msg += `\n\nFor context, here are some files you may want to look at first (also re-readable via read_file/list_dir):\n`;
    for (const rel of contextFiles) {
      try {
        const root = path.resolve(workingDir);
        const target = path.resolve(root, rel);
        if (target !== root && !target.startsWith(root + path.sep)) {
          msg += `\n--- ${rel} ---\n(skipped: outside working directory)\n`;
          continue;
        }
        const content = fs.readFileSync(target, "utf8");
        const truncated = content.length > 4000 ? content.slice(0, 4000) + "\n...[truncated]" : content;
        msg += `\n--- ${rel} ---\n${truncated}\n`;
      } catch (err) {
        msg += `\n--- ${rel} ---\n(could not read: ${err.message})\n`;
      }
    }
  }
  return msg;
}

/**
 * Drives a tool-calling loop against any OpenAI-compatible chat/completions
 * endpoint (LM Studio, Ollama, vLLM, ...) until the model stops calling tools
 * or we hit max_iterations / max_wall_clock_ms.
 */
export async function runDelegateLoop({
  task,
  workingDir,
  readOnly = false,
  contextFiles = [],
  baseUrl,
  model,
  maxIterations = 15,
  maxWallClockMs = 10 * 60 * 1000, // hard stop so a runaway local model can't hang the turn forever
}) {
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
    throw new Error(`working_dir does not exist or is not a directory: ${workingDir}`);
  }

  const { defs: tools, impls } = buildTools(workingDir, { readOnly });

  const messages = [
    { role: "system", content: systemPrompt(workingDir, readOnly) },
    { role: "user", content: buildInitialUserMessage(task, workingDir, contextFiles) },
  ];

  const actions = [];
  const started = Date.now();
  let finalText = null;

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() - started > maxWallClockMs) {
      finalText = `(stopped: exceeded ${maxWallClockMs}ms wall-clock limit after ${i} iterations)`;
      break;
    }

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`LM Studio request failed: ${resp.status} ${resp.statusText}\n${body}`);
    }

    const data = await resp.json();
    const message = data?.choices?.[0]?.message;
    if (!message) {
      throw new Error(`Unexpected response shape from local model: ${JSON.stringify(data).slice(0, 500)}`);
    }

    const toolCalls = message.tool_calls || [];
    if (toolCalls.length === 0) {
      finalText = message.content || "(model returned no content)";
      break;
    }

    messages.push(message);

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      let resultText;
      try {
        const impl = impls[name];
        if (!impl) throw new Error(`Unknown tool: ${name}`);
        resultText = String(impl(args));
      } catch (err) {
        resultText = `Error: ${err.message}`;
      }

      actions.push({ tool: name, args, result: resultText.slice(0, 2000) });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultText,
      });
    }
  }

  if (finalText === null) {
    finalText = `(stopped: reached max_iterations=${maxIterations} without a final answer)`;
  }

  return { finalText, actions, iterations: actions.length ? undefined : 0 };
}
