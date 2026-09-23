#!/bin/zsh
# 在桌面生成「接力台.app」：双击它，接力台没在运行就在后台启动，然后用默认浏览器打开网页。
# 小程序在接力台运行期间一直开着（程序坞里能看到它）：
#   - 再点一下它（或再双击桌面图标），就重新打开网页；
#   - 在程序坞里退出它，接力台就正常关闭（正在跑的全自动会先停下）；
#   - 在网页里点「关闭接力台」，它也会在 10 秒内自己退出。
# 之所以要一直开着：从桌面双击的程序一退出，系统会把它带起来的进程全部结束。
# 用法：zsh scripts/make-desktop-app.sh [放到哪个文件夹，默认桌面]
# 接力台的程序文件夹挪了位置之后，重新执行一次这个脚本就行。

set -e
DIR="${0:A:h:h}"
DEST="${1:-$HOME/Desktop}"
APP="$DEST/接力台.app"
LAUNCHER="$DIR/scripts/open-relay.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[[ -f "$LAUNCHER" ]] || { print -u2 "找不到 $LAUNCHER"; exit 1; }
chmod +x "$LAUNCHER"

# 1. 小程序本体：一小段一直开着的 AppleScript，调用启动脚本；出错时弹窗说原因。
esc="${LAUNCHER//\\/\\\\}"
esc="${esc//\"/\\\"}"
rm -rf "$APP"
osacompile -s -o "$APP" \
  -e 'on launcherPath()' \
  -e "  return \"$esc\"" \
  -e 'end launcherPath' \
  -e 'on openRelay()' \
  -e '  try' \
  -e '    do shell script "/bin/zsh -l " & quoted form of launcherPath()' \
  -e '  on error errMsg number errNum' \
  -e '    if errNum is not -128 then display dialog errMsg with title "接力台" buttons {"好"} default button 1 with icon caution' \
  -e '    quit' \
  -e '  end try' \
  -e 'end openRelay' \
  -e 'on run' \
  -e '  openRelay()' \
  -e 'end run' \
  -e 'on reopen' \
  -e '  openRelay()' \
  -e 'end reopen' \
  -e 'on idle' \
  -e '  try' \
  -e '    do shell script "/bin/zsh " & quoted form of launcherPath() & " --check"' \
  -e '  on error' \
  -e '    quit' \
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
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.relay.desktop" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.relay.desktop" "$PLIST"

# 2. 图标：把 scripts/icon.svg 画成各种尺寸，做成 icns。做不出来就用系统默认图标。
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
print "已生成：$APP"
print "双击它就能打开接力台。"
