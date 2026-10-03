#!/bin/zsh
# 「接力台」小程序调用的脚本（小程序没有图标挂在桌面和程序坞上，见 make-desktop-app.sh）。
#   open-relay.sh               接力台没在运行就启动它，然后用默认浏览器打开网页；最后打印端口号。
#   open-relay.sh --background  同上，但不打开网页（登录电脑时、接力台意外退出或换新版后，小程序用它在后台拉起）。
#   open-relay.sh --check       接力台在运行返回 0；你在网页上点了「关闭」返回 3（小程序跟着退出）；没在运行返回 1（小程序重新拉起）。
#   open-relay.sh --quit        请接力台正常关闭（小程序退出时调用）。
# 不弹「终端」窗口。接力台的输出记在 ~/.relay/ui.log；出错时把原因写到标准错误，由小程序弹窗告诉你。
# 设了 RELAY_NO_BROWSER=1 时不开浏览器、不弹通知（测试用）；RELAY_PORT 换端口（默认 7388，被占着时往后顺延）。

DIR="${0:A:h:h}"
RELAY_DIR="${RELAY_HOME:-$HOME/.relay}"
LOG="$RELAY_DIR/ui.log"
# 你在网页上点了「关闭」时，接力台留下的记号（见 src/ops/keeper.ts）。
STOPPED="$RELAY_DIR/ui-stopped"
PORT="${RELAY_PORT:-7388}"

fail() {
  print -u2 -r -- "$1"
  exit 1
}

notify() {
  [[ -n "${RELAY_NO_BROWSER:-}" ]] && return
  osascript -e "display notification \"$1\" with title \"接力台\"" >/dev/null 2>&1 || true
}

# 正在运行的接力台在哪个端口（7388 被别的程序占着时它会往后顺延，最多 10 个）。
running_port() {
  local p
  for p in {$PORT..$((PORT + 9))}; do
    if curl -s -m 1 "http://127.0.0.1:$p/api/ping" 2>/dev/null | grep -q '"app":"relay"'; then
      print -r -- "$p"
      return 0
    fi
  done
  return 1
}

BACKGROUND=
open_page() {
  [[ -n "$BACKGROUND" || -n "${RELAY_NO_BROWSER:-}" ]] || open "http://127.0.0.1:$1/"
  print -r -- "$1"
}

case "${1:-}" in
  --check)
    # 接力台忙的时候可能一两秒顾不上回答：多问几次；进程还在就算在运行。
    # 不然小程序会以为它停了，又去拉起一个。
    for i in 1 2 3; do
      running_port >/dev/null && exit 0
      sleep 1
    done
    pgrep -f "cli\\.js ui --no-open( --port $PORT)?\$" >/dev/null 2>&1 && exit 0
    [[ -f "$STOPPED" ]] && exit 3
    exit 1
    ;;
  --quit)
    if port=$(running_port); then
      curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/quit" >/dev/null 2>&1
    fi
    exit 0
    ;;
  --background)
    BACKGROUND=1
    ;;
esac

# 要接力台运行了：去掉「你关掉了」的记号。
rm -f "$STOPPED" 2>/dev/null

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
command -v node >/dev/null 2>&1 || fail "找不到 Node.js（需要 20 或更新的版本）。先到 https://nodejs.org 安装，再打开「接力台」。"

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

# 没编译过、或者源码比编译结果新：先编译。下载包里是编译好的，没有 src，不编译。
if [[ -d src && ( ! -f dist/src/cli.js || -n "$(find src package.json -newer dist/src/cli.js -print -quit 2>/dev/null)" ) ]]; then
  [[ -n "$BACKGROUND" ]] || notify "正在准备接力台……"
  npm run build >>"$LOG" 2>&1 || fail "编译失败。在接力台的文件夹里执行 npm run build 看看原因。"
fi

# 在家目录启动：接力台会打开上次用过的项目。
cd "$HOME"
print -r -- "" >>"$LOG"
print -r -- "==== $(date '+%Y-%m-%d %H:%M:%S') 由「接力台」小程序启动${BACKGROUND:+（后台）} ====" >>"$LOG"
# 放进独立的进程组启动，不跟着这个脚本的进程组走。
# 注意：小程序一退出，系统会把它带起来的进程全部结束，所以小程序要一直开着（它没有图标，见 make-desktop-app.sh）。
node -e '
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [cli, log, port] = process.argv.slice(1);
const out = fs.openSync(log, "a");
spawn(process.execPath, [cli, "ui", "--no-open", "--port", port], { detached: true, stdio: ["ignore", out, out] }).unref();
' "$DIR/dist/src/cli.js" "$LOG" "$PORT" || fail "启动接力台失败。详情见 $LOG"

for i in {1..60}; do
  sleep 0.5
  if port=$(running_port); then
    open_page "$port"
    exit 0
  fi
done
fail "接力台没能启动。最后几行记录：
$(tail -n 8 "$LOG")"
