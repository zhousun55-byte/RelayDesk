#!/bin/zsh
# 在访达里双击这个文件，就把「接力台」装进「应用程序」（和执行 zsh scripts/make-desktop-app.sh 一样，不用自己输入路径）。
# 不想要了：打开「终端」，输入 zsh 和一个空格，把这个文件拖进去，再输入空格和 --remove，回车。
cd "${0:A:h}" || exit 1
echo "正在安装接力台……"
echo "Installing RelayDesk..."
echo
if zsh scripts/make-desktop-app.sh "$@"; then
  echo
  echo "装好了。以后在启动台里点「接力台」就行。这个窗口可以关掉。"
  echo "Done. Open RelayDesk from Launchpad from now on. You can close this window."
else
  echo
  echo "没装成，原因在上面几行。解决不了可以到这里提问题：https://github.com/zhousun55-byte/RelayDesk/issues"
  echo "Installation failed. The reason is in the lines above. If you get stuck: https://github.com/zhousun55-byte/RelayDesk/issues"
fi
