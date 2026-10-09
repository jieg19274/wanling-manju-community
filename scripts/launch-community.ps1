param([switch]$PrepareOnly, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $appRoot 'runtime\logs'
[void][IO.Directory]::CreateDirectory($logRoot)
$logFile = Join-Path $logRoot ('launch-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
$transcribing = $false
try {
    Start-Transcript -LiteralPath $logFile -ErrorAction SilentlyContinue | Out-Null
    $transcribing = $true
    & (Join-Path $PSScriptRoot 'prepare-community-runtime.ps1') -AppRoot $appRoot
    if ($PrepareOnly) { exit 0 }
    $nodeExe = Join-Path $appRoot 'tools\node\node.exe'
    $arguments = @((Join-Path $PSScriptRoot 'trial-start.mjs'), '--no-shortcut')
    if ($NoOpen) { $arguments += '--no-open' }
    & $nodeExe @arguments
    if ($LASTEXITCODE -ne 0) { throw '软件启动失败，请查看本窗口和日志。' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ('日志：' + $logFile)
    if (-not $PrepareOnly) { [void](Read-Host '按回车关闭窗口；修复后可再次启动') }
    exit 1
} finally {
    if ($transcribing) { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null }
}
