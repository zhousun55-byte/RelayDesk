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
# 包标识：9-29 从 local.relay.desktop 换成 local.relay.app（新版 macOS 的启动台按旧标识一直缓存着第一版图标，换标识它才当新程序重取）
BUNDLE_ID="local.relay.app"
ALL_IDS=("$BUNDLE_ID" "local.relay.desktop")
AGENT_LABEL="local.relay.login"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
LAUNCHER="$DIR/scripts/open-relay.sh"
OLD_APP="$HOME/Desktop/接力台.app"

# 是不是我们生成的小程序（按包标识认，别动名字碰巧一样的别的程序）。
ours() {
  [[ -d "$1" ]] && (( ${ALL_IDS[(Ie)$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null)]} ))
}

# 挪进废纸篓（不直接删；名字后面加上时间，免得和废纸篓里的重名）。
trash() {
  local name="${1:t:r}"
  mv "$1" "$HOME/.Trash/${name}-$(date +%Y%m%d-%H%M%S).app"
}

# 正在运行的小程序：请它退出（它会先请接力台正常关闭），等它真的退出。
quit_app() {
  local id
  for id in $ALL_IDS; do
    osascript -e "if application id \"$id\" is running then tell application id \"$id\" to quit" >/dev/null 2>&1 || true
  done
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

# 默认放进系统的「应用程序」文件夹（/Applications，没有写权限才放 ~/Applications）。
# 新版 macOS 的启动台按程序的位置缓存图标，同一个位置换了图标也一直显示旧的；9-29 起从 ~/Applications 挪到 /Applications。
if [[ -n "${1:-}" ]]; then
  DEST="$1"
elif [[ -w /Applications ]]; then
  DEST=/Applications
else
  DEST="$HOME/Applications"
fi
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
# 下载包里是编译好的（没有 src）：不编译。
if [[ -d "$DIR/src" ]]; then
  print "编译……"
  (cd "$DIR" && npm run build >/dev/null) || { print -u2 "编译失败：在 $DIR 里执行 npm run build 看看原因。"; exit 1; }
fi
[[ -f "$DIR/dist/src/cli.js" ]] || { print -u2 "找不到 $DIR/dist/src/cli.js：重新下载一份接力台。"; exit 1; }

# 0. 旧的先退出；放在别处的旧副本（桌面上的、另一个「应用程序」文件夹里的）挪进废纸篓，并注销登记。
quit_app
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for other in "$OLD_APP" "$HOME/Applications/接力台.app" "/Applications/接力台.app"; do
  if [[ "$other" != "$APP" ]] && ours "$other"; then
    "$LSR" -u "$other" >/dev/null 2>&1 || true
    trash "$other"
    print "以前放在 ${other:h} 的「接力台」挪进废纸篓了。"
  fi
done

# 1. 小程序本体：一小段一直在后台开着的 AppleScript，调用启动脚本；手动打开时出错会弹窗说原因。
#    RELAY_AT_LOGIN=1（登录时由系统带起来）：只在后台启动接力台，不打开网页。
#    每 10 秒看一眼：接力台没了就在后台重新拉起（拉不起来就过 5 分钟再试）；你在网页上点了「关闭」，它也退出。
# 记下旧图标，装完对比：换了图标才去刷新程序坞的图标缓存
icon_sig() { cat "$APP/Contents/Resources/relay.icns" "$APP/Contents/Resources/Assets.car" 2>/dev/null | shasum | cut -d' ' -f1; /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null; }
OLD_ICON="$( [[ -d "$APP" ]] && icon_sig || true)"
esc="${LAUNCHER//\\/\\\\}"
esc="${esc//\"/\\\"}"
# 先在临时文件夹里把整个程序做好（图标、签名都弄完），最后一下子放进「应用程序」：
# 启动台第一次看到一个位置的程序时就把图标记下、以后不再换，放进去的那一刻必须已经是最终的样子。
BUILD="$TMP/接力台.app"
osacompile -s -o "$BUILD" \
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

PLIST="$BUILD/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 接力台" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string 接力台" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 接力台" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 接力台" "$PLIST"
# 英文系统上叫 RelayDesk（启动台里认得出、聚焦搜索搜得到），中文系统上还是接力台；程序的文件名不变
/usr/libexec/PlistBuddy -c "Set :LSHasLocalizedDisplayName true" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :LSHasLocalizedDisplayName bool true" "$PLIST"
for loc in en zh-Hans; do
  mkdir -p "$BUILD/Contents/Resources/$loc.lproj"
  [[ $loc == en ]] && shown=RelayDesk || shown=接力台
  printf '"CFBundleName" = "%s";\n"CFBundleDisplayName" = "%s";\n' "$shown" "$shown" >"$BUILD/Contents/Resources/$loc.lproj/InfoPlist.strings"
done
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST"
# 不在程序坞里挂图标、没有菜单栏：它只是在后台看着接力台。
/usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"

# 2. 图标：把 scripts/icon.png（1024 像素、透明底，由 scripts/icon.svg 画出来）缩成各种尺寸，做成 icns（启动台和聚焦搜索里看得到）。
#    不在这里现画 SVG：快速查看画出来是白底，图标四角会是白的。做不出来就用系统默认图标。
if [[ -f "$DIR/scripts/icon.png" ]]; then
  ICONSET="$TMP/applet.iconset"
  mkdir "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$DIR/scripts/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$DIR/scripts/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD/Contents/Resources/relay.icns"
  rm -f "$BUILD/Contents/Resources/Assets.car" "$BUILD/Contents/Resources/applet.icns"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PLIST" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile relay" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string relay" "$PLIST"
  # 新版 macOS（26 起）的图标：scripts/AppIcon.icon（纸一层、点和圈一层，圆角、玻璃边、阴影由系统加）编成 Assets.car。
  # 只给旧格式的 icns 时，新系统会把它缩小、套上一圈白底。装了 Xcode 就现编，没装用仓库里编好的；旧系统照样用上面的 icns。
  CAR="$DIR/scripts/Assets.car"
  if xcrun --find actool >/dev/null 2>&1 && xcrun actool "$DIR/scripts/AppIcon.icon" --compile "$TMP" --platform macosx --minimum-deployment-target 11.0 --app-icon AppIcon --output-partial-info-plist "$TMP/icon.plist" >/dev/null 2>&1 && [[ -f "$TMP/Assets.car" ]]; then
    CAR="$TMP/Assets.car"
  fi
  if [[ -f "$CAR" ]]; then
    cp "$CAR" "$BUILD/Contents/Resources/Assets.car"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIconName AppIcon" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string AppIcon" "$PLIST"
  fi
else
  print "（没能生成图标，先用系统默认的。）"
fi

# 3. 每次装都换一个版本号：系统的图标缓存按「同一个 App、同一个版本」认，版本不变，换了图标启动台还显示旧的。
V="$(date +%Y%m%d%H%M%S)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $V" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $V" "$PLIST"
# 改过里面的文件，重新做一次本机签名；再让系统重新登记它、刷新图标。
codesign --force --deep --sign - "$BUILD" >/dev/null 2>&1 || true
rm -rf "$APP"
mv "$BUILD" "$APP"
touch "$APP"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# 系统里还登记着同一个包标识的别的副本（废纸篓里的、试装的）时，启动台可能拿到它的旧图标：先注销这些登记，文件不动。
"$LSR" -dump 2>/dev/null | awk -v ids="${(j: :)ALL_IDS}" 'BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 } /^path:/ { p = $0; sub(/^path:[ ]+/, "", p); sub(/ \(0x[0-9a-f]+\)$/, "", p) } /^identifier:/ && ($2 in want) { print p }' |
  while IFS= read -r other; do
    [[ "$other" -ef "$APP" ]] || "$LSR" -u "$other" >/dev/null 2>&1 || true
  done
# 登记这一份要放在注销之后：注销在后时，启动台把接力台整个从列表里拿掉了。
"$LSR" -f "$APP" >/dev/null 2>&1 || true
# 启动台、程序坞自己还存着一份图标缓存，版本号变了也不一定重读：图标换了就把那份缓存挪进废纸篓、让程序坞重开（一两秒）。
NEW_ICON="$(icon_sig)"
if [[ -n "$OLD_ICON" && "$OLD_ICON" != "$NEW_ICON" ]]; then
  DOCK_CACHE="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null)com.apple.dock.iconcache"
  [[ -f "$DOCK_CACHE" ]] && mv "$DOCK_CACHE" "$HOME/.Trash/com.apple.dock.iconcache-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
  killall Dock >/dev/null 2>&1 || true
  mdimport "$APP" >/dev/null 2>&1 || true
fi

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
