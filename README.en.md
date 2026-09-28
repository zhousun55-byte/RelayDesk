# Relay

**Run out of quota? Anyone can pick up where the last one stopped.**

You probably have several AIs: Claude, Codex (GPT), Cursor, ZCode, MiMo, DeepSeek… each with its own quota. Claude runs out halfway through, so Codex continues in the same folder; Codex runs out too and only DeepSeek is left, which is cheap but noticeably weaker, and you worry it will break things.

Relay lets these AIs **take turns in the same project folder**, and makes sure that:

- **Nothing is lost between turns.** Every AI starts by reading the relay book: the task, how far it got, what the last leg left behind, what is still open.
- **Every change is on the record.** Each leg's changed files and its own account of what it did are recorded. If a leg is cut off by quota before it writes a handoff, Relay records it anyway.
- **Weak work gets reviewed.** Every leg done by a weak model is marked *needs review*. When a strong model has quota again, it first checks the real changes against the handoff, fixes what is wrong, writes a verdict, and only then continues.
- **Mistakes can be undone.** There are snapshots before and after every leg, so you can roll back to before any leg, and undo the rollback.
- **No babysitting.** Continue by hand in any AI tool (Relay only keeps the books), or let Relay dispatch: *Auto* keeps relaying until the work is accepted, switches to the next AI when one runs out, sends a strong model to review when its quota returns, and waits when nobody has quota.

There is also a **group chat**: ask several AIs the same thing. *Compare* asks them at once without seeing each other; *Vote* collects anonymous proposals and one vote per AI, weak or strong, with no voting for yourself. The adopted plan goes into the task's rules, and every later leg follows it.

> The web app is available in English and Chinese: click **EN / 中** at the bottom left (the first visit follows your browser language). Detailed documentation is in Chinese ([README.md](README.md), [docs/设计说明.md](docs/设计说明.md)). Relay is used most on macOS; the CLI and web app also run on Linux. Windows support (folder picker, Show in folder, clipboard) is written but not yet tested on a real machine.

## Get started

Requires [Node.js](https://nodejs.org) 20 or newer (20, 22 and 24 are tested) and git.

macOS, one command:

```bash
git clone <repo url> agent-relay && cd agent-relay && zsh scripts/make-desktop-app.sh
```

This installs dependencies, builds, puts a **Relay** app in `/Applications` (or `~/Applications` without write access) that starts in the background at login, and opens the web page. No Dock or desktop icon, no terminal window. Open it later from Launchpad or Spotlight, or at http://127.0.0.1:7388. To remove it: `zsh scripts/make-desktop-app.sh --remove`.

Linux and Windows (or if you don't want it running in the background):

```bash
git clone <repo url> agent-relay && cd agent-relay && npm install && npm run build && npm start
```

`npm start` opens the web page; press Ctrl-C to stop. Run `npm link` once to get the `relay` command everywhere.

Then:

1. **Open Relay.** The first time, it detects which AI tools are installed, which models they use and which model APIs you have configured (a few seconds). Members are named after their models.
2. **Connect a project.** Click **+** next to *Projects*, choose the project folder, and write what should be done. The first line is the task; each line starting with `- ` is a step.
3. **Continue**, either way:
   - **By hand:** open the folder in any AI tool and say "continue". It reads `.relay/接力本.md` first and follows the rules while writing a handoff.
   - **Let Relay do it:** click **Auto** at the top. To have one specific AI do one leg, use the ▾ next to it.
4. **Watch, review, roll back** in the web app. Legs by weak models say *Needs review*.

## Where things live

- `.relay/` in your project: the ledger, the relay book, handoffs, reviews, snapshots (a separate git directory, so your own git history is untouched), uploads.
- `AGENTS.md` / `CLAUDE.md` in your project: a short *relay rules* section between two markers, so any AI tool knows how to take part.
- `~/.relay/`: the member list, run settings and quota records, shared by all projects.

## Language

The web app switches between English and Chinese with one click. With English on, Relay also asks every AI to write handoffs, reviews and replies in English. The relay rules, the relay book headings and the files inside `.relay/` stay in Chinese for now, because Relay reads those headings.

## Development

```bash
npm test      # build + all tests
python3 scripts/e2e.py   # real browser clicks (needs playwright)
```

Tests use fake `claude` / `codex` / `dsh` programs with the real argument and output formats, and a fake model API. Passing them is not the same as accepting a real tool. See [CONTRIBUTING.md](CONTRIBUTING.md) to add a new AI tool.

## License

[MIT](LICENSE)
