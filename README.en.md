<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-en-dark.png">
    <img alt="RelayDesk: quota runs out, the work doesn't." src="docs/images/hero-en-light.png" width="880">
  </picture>
</p>

<p align="center">
  Let Claude Code, Codex, Cursor and DeepSeek take turns in the same folder.<br>
  When one runs out of quota, the next picks up. Work done by a lighter model is checked by a stronger one.
</p>

<p align="center">
  <a href="https://github.com/zhousun55-byte/RelayDesk/releases/latest/download/RelayDesk-mac.zip"><b>Download for macOS</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/zhousun55-byte/RelayDesk/releases/latest/download/RelayDesk-windows.zip"><b>Download for Windows</b></a>
  &nbsp;·&nbsp;
  <a href="docs/manual.md">Guide</a>
  &nbsp;·&nbsp;
  <a href="README.md">中文</a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/ui-en-dark.png">
  <img alt="RelayDesk: Claude Opus 5.5 runs out of quota, DeepSeek Flash continues, GPT-6.1 Sol reviews each leg, and the task is accepted (sandbox demo; the AIs wrote their notes in Chinese)" src="docs/images/ui-en-light.png">
</picture>

## Why

Claude runs out of quota halfway through. Codex picks it up and runs out too. DeepSeek still has plenty, but you don't trust it alone with that much code.

RelayDesk lines up the AIs you already have and lets them take turns in the same folder.

## What it does

1. Relay. Every leg starts by reading the relay book and ends with a handoff, so nobody has to re-explain. When one AI runs out of quota the next takes over; when all are out, it waits for the first to come back.
2. Review. Legs done by lighter models are marked *needs review* until a stronger model checks the real changes.
3. Roll back. There is a snapshot before and after every leg. Roll back to before any leg, and undo the rollback.
4. Dispatch. Inside one tool, a strong model splits the task into small steps and a faster model from the same family does them one by one.
5. Group chat. Ask several AIs at once. Votes are anonymous: one AI, one vote, no voting for yourself.

## Install

1. Install [Node.js](https://nodejs.org) 20 or newer and git. On Windows the installer gets them with winget if they are missing.
2. Download the package for your system above, unzip it, and put the folder somewhere it will stay.
3. On a Mac, double-click `安装接力台（Mac）.command` ("install RelayDesk"). On Windows, double-click `install-windows.cmd`.

The web app opens when it is done. Open it later from Launchpad or the Start menu; it runs in the background with no icon. If macOS or Windows blocks it, see `INSTALL.txt` in the package.

On Linux, or to run from source:

```bash
git clone https://github.com/zhousun55-byte/RelayDesk.git && cd RelayDesk
npm install && npm run build && npm start
```

## Use it

1. Click **+** next to *Projects* and choose a project folder.
2. Write what should be done and press Enter.
3. Click **Auto**. RelayDesk hands out legs until the work is accepted. Or open the folder in any AI tool and say "continue".

The web app switches between English and Chinese with **EN / 中** at the bottom left. With English on, the AIs write their handoffs and reviews in English.

## Works with

Claude Code, Codex, Cursor, ZCode, DeepSeek Harness, Antigravity, Gemini CLI, Qwen Code, OpenCode, and OpenAI-compatible APIs such as DeepSeek, Kimi, Zhipu and MiMo. Work runs in each tool's own CLI, with its own skills, MCP servers and rules.

## Good to know

1. RelayDesk runs on your machine. It writes only `.relay/` in your project and a marked section at the end of `AGENTS.md` and `CLAUDE.md`. Snapshots live in their own repository and never touch your git.
2. Dispatch does not save tokens. On tasks that take ten minutes or so, it spends 3 to 7 times the strong-model tokens of doing it directly. It is meant for jobs too big for one leg.
3. Used most on macOS. Windows has been installed and used on a real machine. Linux has only been through the automated tests.

More in the [guide](docs/manual.md). The full manual is in Chinese: [使用手册](docs/使用手册.md).

## Thanks

Reading tool transcripts follows [mindbus](https://github.com/BaoWeiiii/mindbus). Failure classification and backing off after errors follow [magpie](https://github.com/yetone/magpie). Checking Codex quota without spending it follows [CodexBar](https://github.com/steipete/CodexBar).

[MIT](LICENSE) © ZHOUSUN
