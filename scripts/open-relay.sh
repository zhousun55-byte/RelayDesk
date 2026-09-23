#!/bin/zsh
# 桌面「接力台」小程序调用的脚本。
#   open-relay.sh           接力台没在运行就启动它，然后用默认浏览器打开网页；最后打印端口号。
#   open-relay.sh --check   接力台在运行就返回 0（小程序每隔几秒问一次，接力台关了它也跟着退出）。
#   open-relay.sh --quit    请接力台正常关闭（小程序退出时调用）。
# 不弹「终端」窗口。接力台的输出记在 ~/.relay/ui.log；出错时把原因写到标准错误，由小程序弹窗告诉你。
# 设了 RELAY_NO_BROWSER=1 时不开浏览器（测试用）。

DIR="${0:A:h:h}"
RELAY_DIR="${RELAY_HOME:-$HOME/.relay}"
LOG="$RELAY_DIR/ui.log"

fail() {
  print -u2 -r -- "$1"
  exit 1
}

notify() {
  osascript -e "display notification \"$1\" with title \"接力台\"" >/dev/null 2>&1 || true
}

# 正在运行的接力台在哪个端口（7388 被别的程序占着时它会往后顺延，最多 10 个）。
running_port() {
  local p
  for p in {7388..7397}; do
    if curl -s -m 1 "http://127.0.0.1:$p/api/ping" 2>/dev/null | grep -q '"app":"relay"'; then
      print -r -- "$p"
      return 0
    fi
  done
  return 1
}

open_page() {
  [[ -n "${RELAY_NO_BROWSER:-}" ]] || open "http://127.0.0.1:$1/"
  print -r -- "$1"
}

case "${1:-}" in
  --check)
    running_port >/dev/null
    exit $?
    ;;
  --quit)
    if port=$(running_port); then
      curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/quit" >/dev/null 2>&1
    fi
    exit 0
    ;;
esac

# 已经在运行：直接打开网页。
if port=$(running_port); then
  open_page "$port"
  exit 0
fi

# 找 Node.js（登录环境里没有时，看看常见的安装位置）。
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
    [[ -x "$p/node" ]] && export PATH="$p:$PATH" && break
  done
fi
command -v node >/dev/null 2>&1 || fail "找不到 Node.js（需要 20 或更新的版本）。先到 https://nodejs.org 安装，再双击「接力台」。"

cd "$DIR" 2>/dev/null || fail "找不到接力台的程序文件夹：$DIR"
mkdir -p "$RELAY_DIR"
# 日志太大就换一个新文件，旧的留一份。
if [[ -f "$LOG" && $(stat -f %z "$LOG") -gt 2000000 ]]; then
  mv -f "$LOG" "$LOG.old"
fi

if [[ ! -d node_modules ]]; then
  notify "第一次运行：正在安装依赖，要一两分钟……"
  npm install --no-audit --no-fund >>"$LOG" 2>&1 || fail "安装依赖失败。详情见 $LOG"
fi

# 没编译过、或者源码比编译结果新：先编译。
if [[ ! -f dist/src/cli.js || -n "$(find src package.json -newer dist/src/cli.js -print -quit 2>/dev/null)" ]]; then
  notify "正在准备接力台……"
  npm run build >>"$LOG" 2>&1 || fail "编译失败。在 agent-relay 文件夹里执行 npm run build 看看原因。"
fi

# 在家目录启动：接力台会打开上次用过的项目。
cd "$HOME"
print -r -- "" >>"$LOG"
print -r -- "==== $(date '+%Y-%m-%d %H:%M:%S') 从桌面「接力台」启动 ====" >>"$LOG"
# 放进独立的进程组启动，不跟着这个脚本的进程组走。
# 注意：从桌面双击时，小程序一退出，系统会把它带起来的进程全部结束，所以小程序要一直开着（见 make-desktop-app.sh）。
node -e '
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [cli, log] = process.argv.slice(1);
const out = fs.openSync(log, "a");
spawn(process.execPath, [cli, "ui", "--no-open"], { detached: true, stdio: ["ignore", out, out] }).unref();
' "$DIR/dist/src/cli.js" "$LOG" || fail "启动接力台失败。详情见 $LOG"

for i in {1..60}; do
  sleep 0.5
  if port=$(running_port); then
    open_page "$port"
    exit 0
  fi
done
fail "接力台没能启动。最后几行记录：
$(tail -n 8 "$LOG")"
