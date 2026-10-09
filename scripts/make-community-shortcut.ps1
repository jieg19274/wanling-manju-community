param([string]$ShortcutDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $ShortcutDirectory '万灵漫剧社区版.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'launch-community.ps1') + '"'
$shortcut.WorkingDirectory = $appRoot
$shortcut.Description = '万灵漫剧社区版；首次启动自动准备本机环境。'
$shortcut.IconLocation = (Join-Path $appRoot 'dist\wanling.ico') + ',0'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Host '万灵漫剧社区版快捷方式已创建。'
