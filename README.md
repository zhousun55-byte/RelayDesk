# relay

换人干活时用的本地命令。你指定下一个工人，它负责：**隔离现场、记下改了什么、交接、主线保持干净**。

不自动换人。不看板。不读聊天记录当真相。真相是 git。

不想记命令：在项目文件夹里打开接力台，按按钮即可。

```bash
cd 你的项目仓库
relay ui
```

浏览器会打开「接力台」。四个站：**开始 → 干活 → 交接 → 合回**。黄点在哪，就点下面那颗大按钮。

也可以用命令走同一件事：

```bash
cd 你的项目仓库
relay start "用一句话说这次要干什么"
relay run claude          # 终端工人；桌面 App 用 relay open cursor
# 干完，回到项目目录
relay handoff             # 审计 + 门禁 + 检查点
relay merge               # 审查过了再合回主线
```

换人就是再来一次 `handoff`，然后 `run` / `open` 下一位。

第一次先做两件准备（每个项目 / 每台电脑各一次）：

```bash
# 电脑上登记工人（全局，做一次）
relay agents add claude --cmd claude --tier strong
relay agents add cursor --kind app --cmd 'cursor {{worktree}}' --tier strong

# 项目里初始化（每个仓库一次，把 .relay/config.json 提交进主线）
relay init
git add .relay/config.json && git commit -m "relay config"
```

看现在怎样：`relay status`  
机器能不能用：`relay doctor`

## 安装

需要 Node ≥ 20 和 git。

```bash
cd agent-relay
npm install
npm run build
npm link
relay doctor
```

审计阅读面（可选）：`export DEEPSEEK_API_KEY=sk-...`。没设也能交接，只是没有模型评论。密钥不要写进仓库。

## 工人

| 命令 | 谁 |
|---|---|
| `relay run <名>` | 终端工人（Claude CLI 等），等它退出 |
| `relay open <名>` | 桌面 App（Cursor 等）。登记时 `--kind app`，命令里必须有 `{{worktree}}` |

前任是 `tier=weak` 时，下一任上岗词会要求先 `git diff` 自审：好的留下，坏的按文件回滚，不整体回档。

## 收尾

- `relay handoff`：先把改动打进检查点，再写审计。新建文件的**内容**会出现在事实段。
- `relay merge`：squash 进主线，会话文件不进主线，接力分支留着备查。
- 桌面 App 没交接时，`merge` / `abandon` 默认拒绝；`--force` 会警告可能丢未提交改动。
- `relay rollback <检查点>`：只动隔离现场，绝不碰主线。
- `relay abandon`：不要了。坏掉的 journal 用 `abandon --force`。

## 状态放哪

| 位置 | 内容 |
|---|---|
| 项目 `.relay/config.json` | 唯一进主线的配置（门禁、保护路径、审计 API 变量名） |
| `relay/<任务>-<id>` 分支 | 任务、交接、journal、审计、业务提交 |
| `~/.relay/worktrees/...` | 隔离工作目录 |
| `~/.relay/agents.json` | 工人名单 |

## 开发

```bash
npm test
```

测试覆盖：slug / journal / 上岗词 / 交接文档 / 配置校验 / 脱敏 / 假 agent 全流程 / App 软锁 / 二次 Ctrl-C / 坏 journal 收尾。
