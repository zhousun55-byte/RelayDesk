#!/bin/zsh
# 网页版和终端版共用一份核心（记账、快照、调度、复核、群聊投票、各家工具的适配），以终端版为准。
# 改核心：先在终端版里改好、npm test 过了，再在网页版里运行本脚本，把共用的文件拷过来，然后 npm test。
#
#   zsh scripts/sync-core.sh [终端版的文件夹]            拷过来
#   zsh scripts/sync-core.sh --check [终端版的文件夹]    只比对：不一样的列出来，有就退出码 1
#
# 终端版的文件夹默认是 RELAY_CLI_DIR，没设就是 ~/接力台CLI。
set -e
cd "${0:A:h}/.."
check=0
[[ "$1" == --check ]] && { check=1; shift; }
CLI="${1:-${RELAY_CLI_DIR:-$HOME/接力台CLI}}"
[[ -f "$CLI/src/ops/go.ts" ]] || { print -u2 "找不到终端版：$CLI"; exit 2; }

# 共用的文件（src/core 整个目录，只有网页版的文件面板 files.ts 例外）
shared=(src/core/*.ts(N:t) ${(f)"$(cd "$CLI" && print -l src/core/*.ts(N:t))"})
files=()
for f in ${(u)shared}; do [[ "$f" == files.ts ]] || files+=("src/core/$f"); done
files+=(src/ops/{autodetect,go,init,rollback,track,view,watch}.ts src/commands/{detect,print}.ts
  test/{helpers,fakes,names}.ts test/{accept,auto-unit,members,selfcheck,unit}.test.ts)

differ=()
for f in $files; do
  if [[ ! -f "$CLI/$f" ]]; then
    print -u2 "终端版没有 $f：它删掉了的话，网页版这边也删掉"
    differ+=("$f")
  elif ! cmp -s "$CLI/$f" "$f"; then
    differ+=("$f")
    (( check )) || cp "$CLI/$f" "$f"
  fi
done
if (( check )); then
  (( ${#differ} )) && { print "和终端版不一样：${(j:、:)differ}"; exit 1; }
  print "和终端版一样（${#files} 个文件）"
else
  print "拷过来了 ${#differ} 个文件${differ:+：${(j:、:)differ}}"
fi
