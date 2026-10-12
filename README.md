# lm-studio-delegate-mcp

An MCP server that gives Claude Code a `delegate` tool: hand a well-specified
task to a model running locally in LM Studio, let it run its own
read/write/run-command loop inside a confined working directory, and get a
summary of what it did back as a tool result.

Claude Code stays the orchestrator on your normal (Anthropic) model the whole
time — this never touches `ANTHROPIC_BASE_URL`. It's a plain MCP tool call,
so it works the same way on a subscription plan as it does with an API key.

## 1. Start LM Studio

1. Load a model that supports tool/function calling (e.g. Qwen2.5-Coder,
   Qwen3, Llama 3.1/3.3-Instruct, Mistral-Nemo-Instruct — check the model
   card in LM Studio for "tool use" support; not every local model handles
   function calling well, and that directly affects how reliable `delegate`
   is). I tested this with the excellent prism-ml/bonsai-27b model in my own lab.
2. Go to the **Local Server** tab (the `<>` icon) and start the server.
   Default port is `1234`.
3. Copy the exact model identifier shown there — you'll need it below.
4. Sanity check it's up:
   ```bash
   curl http://localhost:1234/v1/models
   ```

## 2. Install this server

```bash
cd lm-studio-delegate-mcp
npm install
```

## 3. Register it with Claude Code

> **Known CLI bug:** in current versions of the `claude` CLI, `-e`/`--env` is
> variadic and greedily swallows every argument after it — including the
> server name — if the name comes *after* the `-e` flags. This throws
> `Invalid environment variable format: <server-name>, ...` even though the
> command looks correct. (Tracked upstream as
> [anthropics/claude-code#23365](https://github.com/anthropics/claude-code/issues/23365)
> and [#62332](https://github.com/anthropics/claude-code/issues/62332) —
> still open, not fixed by updating Claude Code.) The fix is simply to put
> the server name **before** the `-e` flags, as below.

Use `--scope user` so it's available in every project (default scope is
project-only — use that instead if you only want it in one repo):

```bash
claude mcp add --transport stdio --scope user lm-studio-delegate \
  -e LM_STUDIO_MODEL="your-model-id" \
  -e LM_STUDIO_BASE_URL="http://localhost:1234/v1" \
  -- node /absolute/path/to/lm-studio-delegate-mcp/src/server.js
```

Replace `LM_STUDIO_MODEL` with the exact identifier you copied in step 1,
and `/absolute/path/to/...` with wherever you cloned this repo — point it at
`src/server.js`, not just the repo root.

If that still errors on your CLI version, skip the flag parser entirely:

```bash
claude mcp add-json lm-studio-delegate '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/lm-studio-delegate-mcp/src/server.js"],
  "env": {
    "LM_STUDIO_MODEL": "your-model-id",
    "LM_STUDIO_BASE_URL": "http://localhost:1234/v1"
  }
}' --scope user
```

Verify it registered correctly — this also shows you exactly what command
and env vars got recorded, so you can catch a bad parse before using it:

```bash
claude mcp get lm-studio-delegate
```

and confirm it's connected with `claude mcp list` or `/mcp` from inside a
Claude Code session.

## 4. Use it

Just ask Claude Code to delegate — e.g.:

> "Delegate writing unit tests for `src/utils/parser.ts` to the local model,
> then review what it produced."

Claude Code will call `delegate` with a task description, `working_dir`, and
optionally `context_files` to pre-load. You can also invoke it explicitly by
asking Claude Code to use the `lm-studio-delegate` MCP tool.

### Tool parameters

| Parameter | Required | Description |
|---|---|---|
| `task` | yes | Precise, self-contained description of what to do, including acceptance criteria |
| `working_dir` | yes | Absolute path the local model is confined to — it cannot read/write/execute outside it |
| `read_only` | no | If `true`, strips `write_file`/`run_command` entirely so the model can only inspect and propose text |
| `context_files` | no | Paths (relative to `working_dir`) to pre-load into the model's first message |
| `max_iterations` | no | Cap on tool-calling turns (default 15, env override `LM_DELEGATE_MAX_ITERATIONS`) |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio's OpenAI-compatible endpoint |
| `LM_STUDIO_MODEL` | *(required)* | Exact model identifier from LM Studio's Local Server tab |
| `LM_DELEGATE_MAX_ITERATIONS` | `15` | Default tool-call turn cap |
| `LM_DELEGATE_COMMAND_TIMEOUT_MS` | `120000` | Per-command timeout for `run_command` |

## Security notes (read this before pointing it at anything that matters)

This gives a local model the ability to write files and run arbitrary shell
commands on your machine, scoped to `working_dir`. Mitigations built in:

- **Path confinement**: `read_file`/`write_file`/`list_dir` resolve against
  `working_dir` and refuse anything that resolves outside it (no `../`
  escapes, no absolute paths elsewhere).
- **Command blocklist**: a short list of obviously destructive patterns
  (`rm -rf /`, fork bombs, `sudo`, pipe-to-shell downloads) is rejected
  before `run_command` runs anything. This is a minimal tripwire, **not** a
  sandbox — treat it as such.
- **Hard caps**: per-file read/write size limits, truncated command output,
  a tool-call iteration cap, and a wall-clock timeout so a confused local
  model can't loop forever or fill your context with huge output.
- **`read_only` mode**: strips `write_file`/`run_command` from the tool list
  sent to the model entirely (not just a prompt instruction it could ignore)
  when you want analysis/proposals without any side effects.

What this does **not** do: sandbox the process (no container, no seccomp, no
filesystem namespace), rate-limit by cost, or review changes before they
land. For anything beyond a throwaway scratch directory:

- Point `working_dir` at a dedicated project checkout, not your whole home
  directory or anything with credentials nearby.
- Commit or branch before delegating, so you can diff and roll back.
- Treat `run_command` as equivalent to giving the local model a shell — because
  it is one, inside that directory.

## Troubleshooting

- **"LM_STUDIO_MODEL is not set"** — you forgot `-e LM_STUDIO_MODEL=...` when
  running `claude mcp add`, or it doesn't match `claude mcp get
  lm-studio-delegate`'s recorded env. Run `claude mcp get lm-studio-delegate`
  to see what actually got saved. Re-run `claude mcp add` (remove the old one
  with `claude mcp remove lm-studio-delegate` first) following the argument
  order in step 3 above, or edit `.mcp.json`/`~/.claude.json` directly.
- **"LM Studio request failed: 404"** — the model identifier doesn't match
  what LM Studio has loaded. Copy it again from the Local Server tab; it has
  to match exactly.
- **Model ignores tools / never calls them** — the loaded model doesn't
  support function calling well. Swap to a model explicitly marked as
  supporting tool use in LM Studio.
- **First call is slow** — cold-load latency on the first request to a model
  LM Studio hasn't warmed up yet. Send a throwaway request to the `/v1/models`
  or `/v1/chat/completions` endpoint right after starting the server if this
  bothers you.
