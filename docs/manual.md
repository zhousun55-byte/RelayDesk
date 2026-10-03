# RelayDesk guide

Details that don't fit in the [README](../README.en.md). The full manual is in Chinese: [使用手册](使用手册.md).

## Get started

Requires [Node.js](https://nodejs.org) and git. 22 or a newer LTS is recommended; 20 is the minimum (20, 22 and 24 are tested, but 20 reached end of life in April 2026).

macOS, one command:

```bash
git clone https://github.com/zhousun55-byte/RelayDesk.git && cd RelayDesk && zsh scripts/make-desktop-app.sh
```

From a downloaded package: unzip it and double-click `安装接力台（Mac）.command` in Finder ("install RelayDesk"). If macOS says it can't verify the developer, click "Open Anyway" at the bottom of System Settings → Privacy & Security.

This installs dependencies, builds, puts a **RelayDesk** app (named 接力台) in `/Applications` (or `~/Applications` without write access) that starts in the background at login, and opens the web page. No Dock or desktop icon, no terminal window. Open it later from Launchpad or Spotlight, or at http://127.0.0.1:7388. To remove it: `zsh scripts/make-desktop-app.sh --remove`.

Windows 10 / 11: put the folder somewhere it will stay and double-click `install-windows.cmd`. It installs Node.js and Git with winget if they are missing, installs dependencies, builds, adds **RelayDesk** to the Start menu (named 接力台 on Chinese Windows), starts it in the background at login, and opens the web page. No console window, no desktop icon. To remove it: `install-windows.cmd --remove`.

Linux (or if you don't want it running in the background):

```bash
git clone https://github.com/zhousun55-byte/RelayDesk.git && cd RelayDesk && npm install && npm run build && npm start
```

`npm start` opens the web page; press Ctrl-C to stop. Run `npm link` once to get the `relay` command everywhere.

Then:

1. **Open RelayDesk.** The first time, it detects which AI tools are installed, which models they use and which model APIs you have configured (a few seconds). Members are named after their models.
2. **Connect a project.** Click **+** next to *Projects*, choose the project folder, and write what should be done. The first line is the task; each line starting with `- ` is a step.
3. **Continue**, either way:
   1. **By hand:** open the folder in any AI tool and say "continue". It reads `.relay/接力本.md` first and follows the rules while writing a handoff.
   2. **Let RelayDesk do it:** click **Auto** at the top (or turn on *Auto* under the input box before sending the task). To have one specific AI do one leg, use the ▾ next to it. With *Auto* off, sending only writes the task down.
4. **Watch, review, roll back** in the web app. Legs by weak models say *Needs review*.

### One tool, several models

A tool can usually switch models: Claude Code has Opus and Sonnet, Cursor has dozens. In *Settings → Members*, click a member's name: you see the model it uses and the newest few from the same family (type to search the rest, or type any model name). Click one to switch this member to it; the *+* on the right adds another member with that model, with its own name, strong/weak setting and quota. The list comes from the tool itself and costs nothing (Codex's model cache; the `models` command of Cursor, Antigravity, OpenCode and Grok; an API's model list; Claude Code's aliases fable / opus / sonnet / haiku). Effort and speed variants are merged, and speech or embedding models are left out. Nothing is added automatically.

A task written on the *Dispatch* page starts as soon as it is sent. On that page, the line under the input box (for example *GLM-5.3 hands to GLM-5.3 Flash*) sets who splits the task and does the final review, and who does the steps: by default strong models lead and weak models work, in list order. You can pick, for example, MiMo V2.6 Pro leading MiMo V2.6 Flash, GLM-5.3 leading GLM-5.3 Flash, or Opus leading Sonnet. If the crew member can't work this time, weak models take over in order. Strong and weak only decide reviews.

### What each tool keeps

Work sent to a coding tool (Claude Code, Codex, Cursor, Antigravity, DeepSeek Harness) runs in that tool's own CLI, so it keeps its own tools, subagents, skills, MCP servers, rules and memory. The Claude official-account member reads your user settings too; RelayDesk only overrides the few settings that point Claude Code at another provider. With permissions set to *project only*, MCP calls follow each tool's own approvals; with *unrestricted*, they are allowed (Cursor gets `--approve-mcps`). Group chat is read-only. API members use RelayDesk's small built-in agent and have no skills, MCP or subagents.

### Conversations in tools

Each leg records its conversation id in the tool (Claude Code, Codex, Cursor and Antigravity report one). On a leg, *Open in Claude* opens that conversation in the Claude desktop app; for Codex, Cursor and Antigravity, *Copy command* copies the command that continues it (`codex resume <id>` and so on). *Thread* shows the conversation inside RelayDesk, including anything you added later in the tool (Claude Code, Codex, DeepSeek Harness and Cursor CLI records are readable). On the Relay page, *Conversations in tools* lists the Claude Code, Codex, DeepSeek Harness and Cursor CLI conversations you started yourself in this project folder. In *Settings → Run*, *Continue the same conversation* (off by default) makes a member's next leg in a task continue its previous conversation, and *List conversations in tools* (on) can turn the list off. Only folders connected to RelayDesk are read, only when you look, and nothing is stored or sent anywhere.

## Where things live

1. `.relay/` in your project: the ledger, the relay book, handoffs, reviews, snapshots (a separate git directory, so your own git history is untouched), uploads.
2. `AGENTS.md` / `CLAUDE.md` in your project: a short *relay rules* section between two markers, so any AI tool knows how to take part.
3. `~/.relay/`: the member list, run settings and quota records, shared by all projects.

## Language

The web app switches between English and Chinese with one click. With English on, RelayDesk also asks every AI to write handoffs, reviews and replies in English. The relay rules, the relay book headings and the files inside `.relay/` stay in Chinese for now, because RelayDesk reads those headings.

## Development

```bash
npm test                  # build + all tests (no network, no cost)
python3 scripts/e2e.py    # real browser clicks (needs playwright)
```

Tests use fake `claude` / `codex` / `dsh` programs with the real argument and output formats, and a fake model API. Passing them is not the same as accepting a real tool. See [CONTRIBUTING.md](../CONTRIBUTING.md) to add a new AI tool.
