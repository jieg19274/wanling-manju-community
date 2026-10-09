$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverFile = Join-Path $studioRoot 'dist-server\server\index.js'
if (-not (Test-Path -LiteralPath $serverFile)) { throw '请先在新软件目录执行 npm run build' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$url = 'http://127.0.0.1:5698/'

$lines = @(netstat -ano -p tcp | Select-String '^\s*TCP\s+127\.0\.0\.1:5698\s+\S+\s+LISTENING\s+(\d+)')
if ($lines.Count -gt 1) { throw '5698 端口有多个监听进程' }
if ($lines.Count -eq 1) {
  $ownerId = [int]$lines[0].Matches[0].Groups[1].Value
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
  $actual = ([string]$processInfo.CommandLine).Replace('\', '/')
  $expected = $serverFile.Replace('\', '/')
  if (-not $processInfo -or $processInfo.Name -ne 'node.exe' -or
      $actual -notmatch [regex]::Escape($expected)) {
    throw "5698 端口属于其他程序（进程 $ownerId），已停止启动"
  }
  $started = (Get-Process -Id $ownerId).StartTime
  $built = (Get-Item -LiteralPath $serverFile).LastWriteTime
  if ($started -ge $built) {
    try {
      $ready = Invoke-RestMethod -Uri ($url + 'api/direct-provider') -TimeoutSec 2
      if ($null -ne $ready.configured) { Start-Process $url; return }
    } catch { }
  }
  $active = & $node (Join-Path $studioRoot 'scripts\check-studio-active.cjs') (Join-Path $studioRoot 'data\studio.db')
  if ($LASTEXITCODE -ne 0 -or [int]$active -gt 0) { throw '新软件仍有待执行任务，暂不重启' }
  Stop-Process -Id $ownerId -Force
}

Start-Process -FilePath $node -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $studioRoot -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 300
  try {
    $ready = Invoke-RestMethod -Uri ($url + 'api/direct-provider') -TimeoutSec 1
    if ($null -ne $ready.configured) {
      Start-Process $url
      Write-Host "万灵漫剧 独立版已启动：$url"
      return
    }
  } catch { }
}
throw '新软件启动超时，请检查本机 5698 端口和日志'
