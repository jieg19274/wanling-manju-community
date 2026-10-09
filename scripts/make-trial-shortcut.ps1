param(
 [string]$ShortcutDirectory = [Environment]::GetFolderPath('Desktop'),
 [switch]$OnlyIfNeeded
)
$ErrorActionPreference = 'Stop'
$trialRoot = Split-Path -Parent $PSScriptRoot
$trialNode = Join-Path $trialRoot 'tools\node\node.exe'
if (-not (Test-Path -LiteralPath $trialNode)) {
 $trialNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
}
$trialNodeVersion = & $trialNode --version
if ($LASTEXITCODE -ne 0 -or $trialNodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
 throw '需要 Node.js 24 或更高版本。'
}
$trialShell = New-Object -ComObject WScript.Shell
$trialDesktop = (Resolve-Path -LiteralPath $ShortcutDirectory).Path
$trialLinkPath = Join-Path $trialDesktop '万灵漫剧.lnk'
$trialLink = $trialShell.CreateShortcut($trialLinkPath)
$trialArguments = '"' + (Join-Path $trialRoot 'scripts\trial-start.mjs') + '"'
if ($OnlyIfNeeded -and (Test-Path -LiteralPath $trialLinkPath) -and
    $trialLink.TargetPath -eq $trialNode -and $trialLink.Arguments -eq $trialArguments -and
    $trialLink.WorkingDirectory -eq $trialRoot -and $trialLink.WindowStyle -eq 7) {
 Write-Output '桌面快捷方式已存在。'
 exit 0
}
$trialLink.TargetPath = $trialNode
$trialLink.Arguments = $trialArguments
$trialLink.WorkingDirectory = $trialRoot
$trialLink.IconLocation = (Join-Path $trialRoot 'dist\wanling.ico') + ',0'
$trialLink.Description = '万灵漫剧创作工作台；Agent接管请读取工作目录内AGENT_START.md'
$trialLink.WindowStyle = 7
$trialLink.Save()
Write-Output '桌面快捷方式已创建。移动软件文件夹后请重新创建。'
