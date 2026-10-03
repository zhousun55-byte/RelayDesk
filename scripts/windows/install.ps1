# 接力台（RelayDesk）在 Windows 上的安装：双击接力台文件夹里的 install-windows.cmd，它调这个脚本。
#   没有 Node.js / Git 就用 winget 装；从源码装的还要装依赖、编译（下载包里是编好的）；开始菜单里放一个「接力台」，登录电脑时在后台启动；最后打开网页。
#   以后不弹黑窗口、不在桌面放图标。对应 Mac 上的 make-desktop-app.sh。
#   install-windows.cmd --remove   去掉开始菜单和登录启动里的「接力台」（挪进回收站），关闭正在运行的接力台。
#                                  接力台文件夹和 %USERPROFILE%\.relay 里的记录都不动。
# 这个文件存成带 BOM 的 UTF-8：Windows 自带的 PowerShell 5 没有 BOM 会把中文读成乱码。

$Win = $PSScriptRoot
$Dir = Split-Path -Parent (Split-Path -Parent $Win)
# 开始菜单里叫什么：中文系统叫「接力台」，别的语言叫「RelayDesk」（英文版 Windows 的开始菜单里一串汉字认不出来）
$Name = if ((Get-UICulture).Name -like 'zh*') { '接力台' } else { 'RelayDesk' }
$Folders = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup'))
$Menu = Join-Path $Folders[0] "$Name.lnk"
$Boot = Join-Path $Folders[1] "$Name.lnk"

function Die($why) {
  Write-Host ''
  Write-Host $why -ForegroundColor Red
  Read-Host "按回车键关闭这个窗口 / Press Enter to close this window"
  exit 1
}

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if ($args -contains '--remove') {
  if (Has node) { & node (Join-Path $Win 'launch.js') --quit }
  Add-Type -AssemblyName Microsoft.VisualBasic
  # 两种名字都看：换过系统语言、装过旧版的，留下的可能是另一个名字
  foreach ($folder in $Folders) {
    foreach ($n in @('接力台', 'RelayDesk')) {
      $p = Join-Path $folder "$n.lnk"
      if (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    }
  }
  Write-Host "已去掉开始菜单和登录启动里的「$Name」。`nRemoved $Name from the Start menu and startup."
  Start-Sleep 3
  exit 0
}

# 没装的用 winget 装（Windows 10/11 自带；会弹出安装程序或管理员确认）。装完把新的 PATH 读进来。
function Need($cmd, $id, $name, $url) {
  if (Has $cmd) { return }
  if (Has winget) {
    Write-Host "没找到 $name，用 winget 安装……`n$name not found, installing it with winget..."
    winget install -e --id $id
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Has $cmd)) { Die "没找到 $name。先到 $url 安装，再双击一次 install-windows.cmd。`n$name not found. Install it from $url, then double-click install-windows.cmd again." }
}
Need node 'OpenJS.NodeJS.LTS' 'Node.js' 'https://nodejs.org'
Need git 'Git.Git' 'Git' 'https://git-scm.com/download/win'
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Die "Node.js 是 $(& node -v)，要 20 或更新的版本。到 https://nodejs.org 装新版，再双击一次 install-windows.cmd。`nNode.js $(& node -v) is too old: 20 or newer is needed. Install a newer one from https://nodejs.org, then double-click install-windows.cmd again." }

Set-Location $Dir
# 从网上下载、解压出来的文件带着「来自网络」的标记，开始菜单里的接力台每次打开都会弹安全警告：装的时候一次去掉。
Get-ChildItem -LiteralPath $Dir -Recurse -File | Unblock-File
# 下载包里是编译好的、带着依赖（没有 src）：不装依赖、不编译。从源码装（git clone 下来的）才要。
if (Test-Path (Join-Path $Dir 'src')) {
  Write-Host "安装依赖（第一次要一两分钟）……`nInstalling dependencies (a minute or two the first time)..."
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "安装依赖失败，原因在上面几行。`nInstalling dependencies failed. The reason is in the lines above." }
  Write-Host "编译……`nBuilding..."
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die "编译失败，原因在上面几行。`nThe build failed. The reason is in the lines above." }
} elseif (-not (Test-Path (Join-Path $Dir 'node_modules'))) {
  & npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "安装依赖失败，原因在上面几行。`nInstalling dependencies failed. The reason is in the lines above." }
}

# 快捷方式指向 wscript + relaydesk.vbs：点开不弹黑窗口。
# WScript.Shell 存快捷方式时会把文件名转成系统的代码页：英文版 Windows 上「接力台.lnk」变成「???.lnk」，存不下。
# 先用英文名存好，再用 .NET（认 Unicode）改成要的名字；存不下就说出来，不说「装好了」。
$shell = New-Object -ComObject WScript.Shell
function Link($path, $arg) {
  $tmp = Join-Path (Split-Path -Parent $path) 'RelayDesk-new.lnk'
  try {
    $l = $shell.CreateShortcut($tmp)
    $l.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $l.Arguments = ('//B //Nologo "{0}" {1}' -f (Join-Path $Win 'relaydesk.vbs'), $arg).Trim()
    $l.WorkingDirectory = $Dir
    $l.IconLocation = (Join-Path $Win 'icon.ico') + ',0'
    $l.Description = 'RelayDesk'
    $l.Save()
    Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Die "没能在 $(Split-Path -Parent $path) 里放「$Name」：$($_.Exception.Message)`nCould not create the $Name shortcut in $(Split-Path -Parent $path)."
  }
}
# 换过系统语言、装过旧版的：另一个名字的快捷方式去掉，免得开始菜单里有两个
foreach ($folder in $Folders) {
  foreach ($n in @('接力台', 'RelayDesk')) {
    if ($n -ne $Name) { Remove-Item -LiteralPath (Join-Path $folder "$n.lnk") -Force -ErrorAction SilentlyContinue }
  }
}
Link $Menu ''
Link $Boot '--background'

Write-Host "打开接力台……`nOpening RelayDesk..."
& node (Join-Path $Win 'launch.js')
if ($LASTEXITCODE -ne 0) { Die "接力台没能启动。记录在 $env:USERPROFILE\.relay\ui.log，最后几行写了原因。`nRelayDesk did not start. The last lines of $env:USERPROFILE\.relay\ui.log say why." }
Write-Host ''
Write-Host "装好了。以后从开始菜单打开「$Name」；登录电脑时它会在后台启动。这个窗口 5 秒后自己关掉。`nDone. Open $Name from the Start menu from now on; it starts in the background when you sign in. This window closes in 5 seconds." -ForegroundColor Green
Start-Sleep 5
