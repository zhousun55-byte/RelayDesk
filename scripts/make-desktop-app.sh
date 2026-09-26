#!/bin/zsh
# 生成「接力台.app」，放进你的「应用程序」文件夹（默认 ~/Applications），并让它登录电脑时自己在后台启动。
# 它不在桌面、不在程序坞里挂图标，也不弹终端窗口：
#   - 在启动台或聚焦搜索（⌘ 空格）里打开「接力台」：接力台没在运行就在后台启动，然后用默认浏览器打开网页；
#   - 接力台意外退出、或者有了新版本，它几秒内在后台重新拉起，不用你开关；
#   - 在网页「设置」里点「关闭接力台」，它也跟着退出；下次打开「接力台」或重新登录电脑时再自己启动。
# 之所以要一直在后台开着：小程序一退出，系统会把它带起来的进程全部结束。
# 以前放在桌面上的「接力台.app」会先退出、挪进废纸篓。
# 用法：zsh scripts/make-desktop-app.sh [放到哪个文件夹]
#       zsh scripts/make-desktop-app.sh --remove    不要了：退出小程序、不再登录时启动、把它挪进废纸篓
# 接力台的程序文件夹挪了位置之后，重新执行一次这个脚本就行。

set -e
DIR="${0:A:h:h}"
BUNDLE_ID="local.relay.desktop"
AGENT_LABEL="local.relay.login"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
LAUNCHER="$DIR/scripts/open-relay.sh"
OLD_APP="$HOME/Desktop/接力台.app"

# 是不是我们生成的小程序（按包标识认，别动名字碰巧一样的别的程序）。
ours() {
  [[ -d "$1" ]] && [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null)" == "$BUNDLE_ID" ]]
}

# 挪进废纸篓（不直接删；名字后面加上时间，免得和废纸篓里的重名）。
trash() {
  local name="${1:t:r}"
  mv "$1" "$HOME/.Trash/${name}-$(date +%Y%m%d-%H%M%S).app"
}

# 正在运行的小程序：请它退出（它会先请接力台正常关闭），等它真的退出。
quit_app() {
  osascript -e "if application id \"$BUNDLE_ID\" is running then tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  local i
  for i in {1..40}; do
    pgrep -f '/接力台\.app/Contents/MacOS/applet' >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  print -u2 "「接力台」小程序 20 秒内没有退出，先接着往下做。"
}

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
  rm -f "$AGENT_PLIST"
  quit_app
  for app in "$HOME/Applications/接力台.app" "/Applications/接力台.app" "$OLD_APP"; do
    if ours "$app"; then
      trash "$app"
      print "挪进废纸篓了：$app"
    fi
  done
  print "已经不再登录时启动。以后要用，重新执行：zsh $DIR/scripts/make-desktop-app.sh"
  exit 0
fi

DEST="${1:-$HOME/Applications}"
APP="$DEST/接力台.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[[ -f "$LAUNCHER" ]] || { print -u2 "找不到 $LAUNCHER"; exit 1; }
chmod +x "$LAUNCHER"
mkdir -p "$DEST"

# 先装依赖、编译好（第一次要一两分钟），小程序一启动接力台马上就能用。
command -v node >/dev/null 2>&1 || { print -u2 "找不到 Node.js（需要 20 或更新的版本）。先到 https://nodejs.org 安装，再执行一次这个脚本。"; exit 1; }
if [[ ! -d "$DIR/node_modules" ]]; then
  print "安装依赖……"
  (cd "$DIR" && npm install --no-audit --no-fund >/dev/null) || { print -u2 "安装依赖失败：在 $DIR 里执行 npm install 看看原因。"; exit 1; }
fi
print "编译……"
(cd "$DIR" && npm run build >/dev/null) || { print -u2 "编译失败：在 $DIR 里执行 npm run build 看看原因。"; exit 1; }

# 0. 旧的先退出；以前放在桌面上的挪进废纸篓。
quit_app
if [[ "$OLD_APP" != "$APP" ]] && ours "$OLD_APP"; then
  trash "$OLD_APP"
  print "桌面上以前的「接力台」挪进废纸篓了。"
fi

# 1. 小程序本体：一小段一直在后台开着的 AppleScript，调用启动脚本；手动打开时出错会弹窗说原因。
#    RELAY_AT_LOGIN=1（登录时由系统带起来）：只在后台启动接力台，不打开网页。
#    每 10 秒看一眼：接力台没了就在后台重新拉起（拉不起来就过 5 分钟再试）；你在网页上点了「关闭」，它也退出。
esc="${LAUNCHER//\\/\\\\}"
esc="${esc//\"/\\\"}"
rm -rf "$APP"
osacompile -s -o "$APP" \
  -e 'on launcherPath()' \
  -e "  return \"$esc\"" \
  -e 'end launcherPath' \
  -e 'on relay(extra)' \
  -e '  do shell script "RELAY_KEEPER=1 /bin/zsh -l " & quoted form of launcherPath() & extra' \
  -e 'end relay' \
  -e 'on openRelay()' \
  -e '  try' \
  -e '    relay("")' \
  -e '  on error errMsg number errNum' \
  -e '    if errNum is not -128 then' \
  -e '      activate' \
  -e '      display dialog errMsg with title "接力台" buttons {"好"} default button 1 with icon caution' \
  -e '    end if' \
  -e '  end try' \
  -e 'end openRelay' \
  -e 'on run' \
  -e '  if (system attribute "RELAY_AT_LOGIN") is "1" then' \
  -e '    try' \
  -e '      relay(" --background")' \
  -e '    end try' \
  -e '  else' \
  -e '    openRelay()' \
  -e '  end if' \
  -e 'end run' \
  -e 'on reopen' \
  -e '  openRelay()' \
  -e 'end reopen' \
  -e 'on idle' \
  -e '  try' \
  -e '    do shell script "/bin/zsh " & quoted form of launcherPath() & " --check"' \
  -e '  on error errMsg number errNum' \
  -e '    if errNum is 3 then' \
  -e '      quit' \
  -e '      return 10' \
  -e '    end if' \
  -e '    try' \
  -e '      relay(" --background")' \
  -e '    on error' \
  -e '      return 300' \
  -e '    end try' \
  -e '  end try' \
  -e '  return 10' \
  -e 'end idle' \
  -e 'on quit' \
  -e '  try' \
  -e '    do shell script "/bin/zsh " & quoted form of launcherPath() & " --quit"' \
  -e '  end try' \
  -e '  continue quit' \
  -e 'end quit' 2> >(grep -v 'replacing existing signature' >&2)

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 接力台" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string 接力台" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST"
# 不在程序坞里挂图标、没有菜单栏：它只是在后台看着接力台。
/usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"

# 2. 图标：把 scripts/icon.svg 画成各种尺寸，做成 icns（启动台和聚焦搜索里看得到）。做不出来就用系统默认图标。
if qlmanage -t -s 1024 -o "$TMP" "$DIR/scripts/icon.svg" >/dev/null 2>&1 && [[ -f "$TMP/icon.svg.png" ]]; then
  ICONSET="$TMP/applet.iconset"
  mkdir "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.svg.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$TMP/icon.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
  # 新版系统优先用 Assets.car 里的图标；去掉它，让上面的 icns 生效。
  rm -f "$APP/Contents/Resources/Assets.car"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PLIST" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile applet" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string applet" "$PLIST"
else
  print "（没能生成图标，先用系统默认的。）"
fi

# 3. 改过里面的文件，重新做一次本机签名；再让访达刷新图标。
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"

# 4. 登录电脑时，由系统在后台把它带起来（不打开网页）。「系统设置 → 通用 → 登录项」里能看到、能关掉。
xml() { print -r -- "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
mkdir -p "${AGENT_PLIST:h}"
cat >"$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>-j</string>
    <string>--env</string>
    <string>RELAY_AT_LOGIN=1</string>
    <string>$(xml "$APP")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AssociatedBundleIdentifiers</key>
  <string>$BUNDLE_ID</string>
</dict>
</plist>
EOF

# 5. 现在就在后台启动一次（和登录时一样）。
launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"

# 6. 等它在后台起来，打开网页（第一次打开会先识别这台电脑上装了哪些 AI，十几秒）。
url=
for i in {1..60}; do
  for p in {7388..7397}; do
    if curl -s -m 1 "http://127.0.0.1:$p/api/ping" 2>/dev/null | grep -q '"app":"relay"'; then
      url="http://127.0.0.1:$p/"
      break 2
    fi
  done
  sleep 1
done
print "已生成：$APP"
if [[ -n "$url" ]]; then
  print "接力台已经在后台运行，以后登录电脑时也会自己启动；桌面和程序坞上都不会有它的图标。"
  [[ -n "${RELAY_NO_BROWSER:-}" ]] || open "$url"
  print "网页：$url （以后在启动台或聚焦搜索里打开「接力台」就行）"
else
  print -u2 "接力台一分钟内没有起来，记录在 ${RELAY_HOME:-$HOME/.relay}/ui.log。在启动台里打开「接力台」再试一次。"
fi
