# 接力台（RelayDesk）在 Windows 上的安装：双击 agent-relay 文件夹里的 install-windows.cmd，它调这个脚本。
#   没有 Node.js / Git 就用 winget 装；装依赖、编译；开始菜单里放一个「接力台」，登录电脑时在后台启动；最后打开网页。
#   以后不弹黑窗口、不在桌面放图标。对应 Mac 上的 make-desktop-app.sh。
#   install-windows.cmd --remove   去掉开始菜单和登录启动里的「接力台」（挪进回收站），关闭正在运行的接力台。
#                                  agent-relay 文件夹和 %USERPROFILE%\.relay 里的记录都不动。
# 这个文件存成带 BOM 的 UTF-8：Windows 自带的 PowerShell 5 没有 BOM 会把中文读成乱码。

$Win = $PSScriptRoot
$Dir = Split-Path -Parent (Split-Path -Parent $Win)
$Menu = Join-Path ([Environment]::GetFolderPath('Programs')) '接力台.lnk'
$Boot = Join-Path ([Environment]::GetFolderPath('Startup')) '接力台.lnk'

function Die($why) {
  Write-Host ''
  Write-Host $why -ForegroundColor Red
  Read-Host '按回车键关闭这个窗口'
  exit 1
}

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if ($args -contains '--remove') {
  if (Has node) { & node (Join-Path $Win 'launch.js') --quit }
  Add-Type -AssemblyName Microsoft.VisualBasic
  foreach ($p in @($Menu, $Boot)) {
    if (Test-Path $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  }
  Write-Host '已去掉开始菜单和登录启动里的「接力台」。'
  Start-Sleep 3
  exit 0
}

# 没装的用 winget 装（Windows 10/11 自带；会弹出安装程序或管理员确认）。装完把新的 PATH 读进来。
function Need($cmd, $id, $name, $url) {
  if (Has $cmd) { return }
  if (Has winget) {
    Write-Host "没找到 $name，用 winget 安装……"
    winget install -e --id $id
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Has $cmd)) { Die "没找到 $name。先到 $url 安装，再双击一次 install-windows.cmd。" }
}
Need node 'OpenJS.NodeJS.LTS' 'Node.js' 'https://nodejs.org'
Need git 'Git.Git' 'Git' 'https://git-scm.com/download/win'
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Die "Node.js 是 $(& node -v)，要 20 或更新的版本。到 https://nodejs.org 装新版，再双击一次 install-windows.cmd。" }

Set-Location $Dir
Write-Host '安装依赖（第一次要一两分钟）……'
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die '安装依赖失败，原因在上面几行。' }
Write-Host '编译……'
& npm run build
if ($LASTEXITCODE -ne 0) { Die '编译失败，原因在上面几行。' }

# 快捷方式指向 wscript + relaydesk.vbs：点开不弹黑窗口。
$shell = New-Object -ComObject WScript.Shell
function Link($path, $arg) {
  $l = $shell.CreateShortcut($path)
  $l.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $l.Arguments = ('//B //Nologo "{0}" {1}' -f (Join-Path $Win 'relaydesk.vbs'), $arg).Trim()
  $l.WorkingDirectory = $Dir
  $l.IconLocation = (Join-Path $Win 'icon.ico') + ',0'
  $l.Description = '接力台（RelayDesk）'
  $l.Save()
}
Link $Menu ''
Link $Boot '--background'

Write-Host '打开接力台……'
& node (Join-Path $Win 'launch.js')
if ($LASTEXITCODE -ne 0) { Die "接力台没能启动。记录在 $env:USERPROFILE\.relay\ui.log，最后几行写了原因。" }
Write-Host ''
Write-Host '装好了。以后从开始菜单打开「接力台」；登录电脑时它会在后台启动。这个窗口 5 秒后自己关掉。' -ForegroundColor Green
Start-Sleep 5
