# 接力台（relay）

让这台电脑上的几个 AI 编程工具**自己把一件事做完**：一个干活，另一个审查，不合格就带着意见再改，通过了自动合回你的项目。你只需要写一句「要做什么」。

- **自动识别**：自己找出装了哪些 AI 编程工具（Claude Code、Codex、Cursor Agent、ZCode……）、登没登录、各用什么模型；配了哪些模型接口（DeepSeek……）。
- **全自动**：开始任务 → 干活 → 交接（存检查点、跑检查）→ 换一个 AI 审查 → 要改就再来一轮 → 通过后合回。全程不用点。
- **不怕出事**：所有改动都在项目外的隔离副本里做，正式文件夹一直不动，直到审查通过才合回（合成一个提交，接力分支留底）。随时能停，能接着跑，能退回任何一次交接。

## 快速开始

1. 双击「多协同工作」文件夹里的 **打开接力台.command**（或在终端执行 `relay ui`）。浏览器会打开接力台。
2. 第一次打开时，接力台会**自动识别**这台电脑上的 AI 工具（十几秒）。
3. 右上角选好项目文件夹，写下要做什么，点 **全自动完成**（⌘Enter 也行）。
4. 看着它干：页面上有每一步的进度和实时日志。做完会显示「完成：已合回正式文件夹」。

命令行也一样：

```bash
cd 你的项目
relay auto "帮我做一份 iPhone 5s 风格的 Lightroom 滤镜（XMP 文件）"
```

## 全自动是怎么干活的

```
开始任务（建隔离副本）
  → 第 1 轮：主力干活（无人值守，读 .relay/ONBOARD.md 里的任务和规矩）
  → 交接：改动存成检查点，跑检查命令，写审计
  → 另一个 AI 审查全部改动，只给结论：通过 / 要改（逐条列问题）
  → 要改：意见写进下一轮的上岗说明，主力接着改（最多 3 轮，可调）
  → 通过：自动合回正式文件夹
```

- **谁干活、谁审查**：默认编程工具优先（Claude Code → Codex → Cursor Agent → ZCode …），接口模型（DeepSeek …）排在后面兜底。审查总挑一个和干活的**不是同一个**的。可以在「设置 → 全自动设置」里改顺序。
- **出错了会换人**：主力没做出改动（没登录、额度用完、报错）就自动换下一位；审查员出错也换下一位。
- **检查没过不算通过**：项目配了检查命令（如 `npm test`）时，检查没过，审查员说通过也算「要改」。
- **停下来交给你**的几种情况：改满轮数还没通过；没人能审查；正式文件夹里有没提交的改动挡着合回；桌面 App 工人还在岗没交接。页面会写清楚原因。
- **随时能停、能接着跑**：点「停止」（或终端里按一次 Ctrl-C），正在干活的工具会被结束；之后点「继续全自动」，它从交接记录推出下一步接着做。接力台被关掉时留下的工具进程，下次开始前会先结束掉。

### 两个权限档位

| 档位 | 意思 |
|---|---|
| 安全档（默认） | 工具只能改隔离副本里的文件；要跑的命令放进工具自己的沙箱（只能写当前文件夹）。Claude Code 用 `acceptEdits` + 沙箱，Codex 用 `workspace-write`，Cursor Agent 用 `--sandbox enabled`。 |
| 完全放开 | 工具不再拦任何操作（`--dangerously-skip-permissions` 之类）。能装依赖、能联网，但出事风险自负。Antigravity 只有这一档才能无人值守干活。 |

## 自动识别

接力台启动时自动识别一次（之后每 12 小时或点「重新识别」再来）。能认出：

| 编程工具 | 无人值守的调用方式 | 实测 |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json`（提示词从标准输入） | ✓ |
| Codex | `codex exec --json -o 文件 -` | ✓ |
| Cursor Agent | `agent -p --output-format stream-json --force`（快捷命令被 Cursor 编辑器顶替时直接调程序本体） | ✓ |
| ZCode | ZCode 桌面版自带的命令行内核 `zcode.cjs -p … --mode edit` | 按官方参数，未实测 |
| Antigravity | `agy -p … --output-format stream-json` | 部分 |
| Gemini CLI、Qwen Code、OpenCode、Factory Droid、Copilot CLI、Grok CLI | 各自的非交互参数 | 未实测 |

- **登录**：只看各工具自己的登录状态 / 凭据文件（`claude auth status`、`codex login status`、`agent status`……），不花钱。
- **模型**：读各工具自己的配置（Claude Code 的 `~/.claude/settings.json`、Codex 的 `config.toml`、Cursor 的 `cli-config.json`、ZCode 的配置），只读模型相关的字段，**密钥一律不碰**。
- **模型接口**：扫你在 shell 里配的密钥（`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`MOONSHOT_API_KEY`、`DASHSCOPE_API_KEY`、`ZHIPUAI_API_KEY` ……），调接口的「列出模型」（免费）确认能用、挑一个模型。本机的 Ollama / LM Studio 也会认。
- **要用别的工具保存的密钥时必须你同意**：比如小米 MiMo 桌面版里配的 Token Plan。识别结果里会出现「同意使用」按钮（或 `relay detect --use mimocode:xiaomi-token-plan-cn`）；同意后只记下「密钥在哪」，调用时才读进内存，不复制到任何地方。
- **只有接口的模型也能干活**：接力台内置一个小代理，让模型通过「列文件 / 读文件 / 写文件 / 精确替换 / 搜索 / 跑检查命令」这几个工具改隔离副本（安全档不能跑任意命令）。
- **桌面 App**（Cursor、ZCode、MiMo、ChatGPT、Claude……）没有无人值守的接口，只能在「手动模式」里用。
- 接力台从某个 AI 工具（比如 Claude Code 桌面版）里启动时，会继承那个工具的会话凭据。接力台会把这些变量**全部去掉**再去调别的工具，也不会把它们当成你的密钥。

## 手动模式（原来的接力）

不想全自动时，任务页下面照样能「让谁上岗 → 交接 → 合回」：桌面 App 会打开隔离副本并把上岗那句话复制好；终端工具会开一个终端窗口。全自动和手动可以混着用：手动干了一段，再点「继续全自动」，它会先审查你手动的那段。

## 命令行速查

| 命令 | 作用 |
|---|---|
| `relay ui` | 打开接力台网页 |
| `relay auto "要做什么"` | 全自动做完一件事。常用选项：`--work codex,claude`、`--review cursor-agent`、`--rounds 5`、`--no-merge`、`--full` |
| `relay auto` | 接着跑当前任务 |
| `relay auto --status` / `--stop` / `--team` | 看进度 / 叫停 / 看会派谁 |
| `relay detect` | 重新识别；`--use <编号>` 同意使用某个接口；`--offline` 不连网 |
| `relay start "要做什么"` | 只开始任务（手动模式） |
| `relay run <工人>` | 让一个工人上岗（终端工具在这里运行；桌面 App 打开窗口） |
| `relay handoff -m "留言"` | 交接：存检查点、跑检查、写审计 |
| `relay merge` | 合回正式文件夹 |
| `relay status` | 看看现在怎么样了 |
| `relay rollback [检查点]` | 退回到某次交接（只动隔离副本） |
| `relay sync` | 把正式文件夹后来的提交同步进任务 |
| `relay take` | AI 开错了文件夹、改到了正式文件夹时，把改动收进任务 |
| `relay abandon` | 放弃任务（接力分支留底） |
| `relay talk "问题" --ask claude,codex` | 几个 AI 轮流发言讨论（只说话不改文件） |
| `relay workers list / add / edit / remove` | 管理工人名单；`edit codex --model gpt-6-astra --effort low` 指定模型和思考强度 |
| `relay doctor` | 体检 |

## 设置放在哪

| 位置 | 内容 |
|---|---|
| `~/.relay/agents.json` | 工人名单（全机通用）。自动识别加进来的条目带 `"detected": true`；第一次改动前备份为 `agents.json.bak-before-detect` |
| `~/.relay/auto.json` | 全自动设置：干活 / 审查的顺序、最多几轮、是否自动合回、权限档位、时限 |
| `~/.relay/detected.json` | 上次自动识别的结果 |
| 项目里的 `.relay/config.json` | 这个项目的检查命令、不许改的文件、审计模型（唯一进项目主线的接力文件，不写密钥） |

工人条目里和全自动有关的字段：`harness`（绑定哪个编程工具）、`model`（指定模型，不填用工具自己的默认）、`effort`（思考强度，如 Codex 的 `low`）。

## 数据放在哪

| 位置 | 内容 |
|---|---|
| `~/.relay/worktrees/<项目>/<分支>` | 任务的隔离副本 |
| `relay/<任务>-<编号>` 分支 | 任务说明、交接记录（journal）、审计报告、审查意见、每一段的检查点 |
| `~/.relay/projects/<项目>/session.json` | 进行中任务的指针 |
| `~/.relay/projects/<项目>/auto.json`、`auto-logs/` | 全自动的进度和每一步的日志 |

## 常见问题

- **页面说「没找到能全自动干活的 AI 工具」**：装好并登录 Claude Code / Codex / Cursor Agent 之一，去「设置」点「重新识别」。`relay doctor` 会列出每个工具的问题。
- **审查一直不通过**：到轮数上限会停下交给你。看审查意见（任务页「经过」里有每一轮的意见），可以手动合回，或「继续全自动」再给几轮。
- **想换主力 / 审查员**：「设置 → 全自动设置」里填名字顺序，或命令行 `--work` / `--review`。
- **模型改名下架了**（比如 DeepSeek 已经没有 `deepseek-chat`）：审计会按识别到的模型自动换一个便宜的；工人条目里的模型重新识别或手动改一下。
- **全自动在跑时手动按钮是灰的**：为了不打架。先停止全自动。

## 安装与开发

需要 Node ≥ 20 和 git。

```bash
cd agent-relay
npm install
npm run build
npm link        # 以后在任何地方都能用 relay 命令
relay doctor
```

```bash
npm test        # 编译 + 全部测试
```

测试用假的 claude / codex 程序（参数和输出格式跟真的一样）和假的模型接口，覆盖：自动识别、全自动通过 / 返工 / 轮数用完 / 换人 / 叫停后继续 / 残留进程清理、内置小代理、网页接口和安全检查，以及手动模式的全部流程。

## 更新记录

- **1.1.0**：全自动（`relay auto`、网页「全自动完成」）；自动识别编程工具和模型接口（`relay detect`，接力台启动时自动跑）；审查 / 返工循环；内置小代理让接口模型也能干活；讨论可以直接用识别到的工具；审计模型下架时自动换；Cursor 打不开的旧命令自动修好。
- **1.0.0**：整体重构：隔离副本 + 交接记录 + 合回；桌面 / 终端工人；讨论；中文路径；兼容旧数据。
