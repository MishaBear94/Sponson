# Sponson in agent tools

`sponson mcp` serves three MCP tools over stdio: `sponson_plan`, `sponson_apply` and `sponson_receipt`. Every tool
answers with the same JSON envelope as `--json` on the command line. [SKILL.md](../../SKILL.md) tells the agent when
to write a plan line, when to stop and show a human the diff, and why it must never write a secret value or approve
production itself. Give an agent both: the MCP server to act, the skill to know when not to.

Each tool below gets two things: the MCP server configuration (copy it as it is) and a place for SKILL.md.

## Before you start

- Node.js 22 or later on the `PATH` the tool starts servers with: every configuration runs `npx -y sponson mcp`.
  To pin a version, write `sponson@0.4.0` instead of `sponson` in the arguments.
- The server reads `release.plan.yaml`, the git checkout and its `origin` (where receipts are pushed) from the
  directory it starts in, and provider tokens (`VERCEL_TOKEN`, `NEON_API_KEY`, `CLERK_SECRET_KEY`, every
  `env://NAME` the plan references) from its environment. Never write a token into one of these files: they are
  committed or shared. Each tool starts the server with the environment it was itself started with unless noted.
- When a tool starts servers outside the project (a global configuration), the agent can pass `plan`, `branch`,
  `sha` and `pr` to every tool, or start the server from the project:
  `"command": "sh", "args": ["-c", "cd /path/to/project && exec npx -y sponson mcp"]`.

## Claude Code

Add the server for this project (stored in your user configuration, not committed):

```bash
claude mcp add sponson -- npx -y sponson mcp
```

Or share it with the team in `.mcp.json` at the repository root. `claude mcp add --scope project sponson -- npx -y
sponson mcp` writes exactly this:

```json
{
  "mcpServers": {
    "sponson": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sponson", "mcp"],
      "env": {}
    }
  }
}
```

Claude Code asks each person to approve a project's `.mcp.json` servers once. `claude mcp list` shows whether the
server started.

**The skill.** SKILL.md is already in Claude Code's skill format (a `name` and `description` frontmatter). Save it as
`.claude/skills/sponson/SKILL.md` in the repository (or `~/.claude/skills/sponson/SKILL.md` for every project); Claude
loads it when a task touches what its description names.

```bash
mkdir -p .claude/skills/sponson
curl -fsSL https://raw.githubusercontent.com/MishaBear94/Sponson/main/SKILL.md -o .claude/skills/sponson/SKILL.md
```

## Cursor

`.cursor/mcp.json` in the repository (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "sponson": {
      "command": "npx",
      "args": ["-y", "sponson", "mcp"]
    }
  }
}
```

Enable the server under **Cursor Settings → MCP**. The agent uses MCP tools in Agent mode.

**The skill.** Save SKILL.md's text (without its frontmatter) as a project rule, `.cursor/rules/sponson.mdc`, with
this frontmatter so the agent pulls it in when the description matches:

```markdown
---
description: Declare and apply everything that ships beside the code (database branches, env vars, callbacks) through release.plan.yaml and the sponson MCP tools, stopping for a human between plan and apply.
alwaysApply: false
---
```

## Codex CLI

`~/.codex/config.toml` (Codex's configuration is per user):

```toml
[mcp_servers.sponson]
command = "npx"
args = ["-y", "sponson", "mcp"]
```

`codex mcp add sponson -- npx -y sponson mcp` writes exactly this. Codex does not hand MCP servers your whole
environment: name the provider tokens to forward in `env_vars`, and, since the configuration is global, give the
project directory as `cwd`:

```toml
[mcp_servers.sponson]
command = "npx"
args = ["-y", "sponson", "mcp"]
env_vars = ["VERCEL_TOKEN", "NEON_API_KEY", "CLERK_SECRET_KEY"]
cwd = "/path/to/project"
```

**The skill.** Codex reads `AGENTS.md` at the repository root. Add SKILL.md's text there under a `## Sponson`
heading, or a line telling the agent to read `SKILL.md` before touching `release.plan.yaml` (with the file committed
next to it).

## Windsurf

Windsurf's MCP configuration is per user: `~/.codeium/windsurf/mcp_config.json` (**Windsurf Settings → Cascade →
MCP servers → View raw config**):

```json
{
  "mcpServers": {
    "sponson": {
      "command": "npx",
      "args": ["-y", "sponson", "mcp"]
    }
  }
}
```

Refresh the server list in the MCP panel after saving. As the configuration is global, start the server from the
project (`sh -c "cd … && exec npx -y sponson mcp"`, above) when Cascade's tools cannot find the plan.

**The skill.** Save SKILL.md's text (without its frontmatter) as a workspace rule, `.windsurf/rules/sponson.md`, and
set its activation to **Model decision** with SKILL.md's description, so Cascade reads it when the task needs it.

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in the repository (note the top-level key is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "sponson": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sponson", "mcp"]
    }
  }
}
```

To give the server a token VS Code does not have in its environment, let VS Code prompt for it and store it encrypted
instead of writing it into the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "vercel-token", "description": "Vercel token for Sponson", "password": true }
  ],
  "servers": {
    "sponson": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sponson", "mcp"],
      "env": { "VERCEL_TOKEN": "${input:vercel-token}" }
    }
  }
}
```

Start the server from the file's **Start** code lens or **MCP: List Servers**, then pick the Sponson tools in the
Copilot Chat tools menu (agent mode).

**The skill.** Save SKILL.md's text (without its frontmatter) as `.github/instructions/sponson.instructions.md` with
this frontmatter, so Copilot adds it whenever the plan file is in play:

```markdown
---
applyTo: "**/release.plan.yaml"
---
```

Or append it to `.github/copilot-instructions.md`, which Copilot reads on every request.

## How these configurations were checked

Every JSON and TOML block on this page parses, and each one's server runs `sponson mcp` (`scenarios/docs/integrations.test.ts`).
"Verified" means the tool's own CLI wrote or read the configuration back; "from the documentation" means it is
written from the tool's documentation and was not run:

| Tool | MCP configuration | Instructions |
|---|---|---|
| Claude Code | `claude mcp add`, and the `.mcp.json` it writes with `--scope project`: verified with the CLI | `.claude/skills/<name>/SKILL.md` and the frontmatter: from the documentation |
| Cursor | `.cursor/mcp.json` `mcpServers`: from the documentation | `.cursor/rules/*.mdc` frontmatter: from the documentation |
| Codex CLI | `codex mcp add` output, and `env_vars` and `cwd` read back by `codex mcp get --json`: verified with codex-cli 0.153.2. That only the named variables reach the server is from the documentation | `AGENTS.md`: from the documentation |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` `mcpServers`: from the documentation | `.windsurf/rules/` and its activation modes: not verified |
| VS Code | `.vscode/mcp.json` `servers`, `inputs`: from the documentation | `.github/instructions/*.instructions.md` `applyTo`: from the documentation |

If one of them has moved on, please open an issue or a pull request against this file.
