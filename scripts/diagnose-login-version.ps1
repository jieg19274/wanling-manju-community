param(
  [ValidateRange(1024, 65535)][int]$Port = 5780,
  [string]$ReportDirectory = (Split-Path -Parent $PSScriptRoot),
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$expectedEntry = '/assets/index-CrMBJadB.js'
$expectedHash = 'ee33a5c71baa1b1911bbd2d083bfbe2890f189efc77ff979c079812c93626d6e'
$diagnosticOrigin = 'http://127.0.0.1:' + $Port
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$report = [ordered]@{ toolVersion = '0.4.7'; at = (Get-Date).ToString('o'); port = $Port; serviceReachable = $false }
function Get-LocalBytes([string]$RelativePath) {
  if ($RelativePath -notmatch '^/(?:api/health|assets/[A-Za-z0-9_.-]+\.js)?(?:\?.*)?$') { throw '诊断路径无效' }
  $request = [System.Net.HttpWebRequest]::Create($diagnosticOrigin + $RelativePath)
  $request.Proxy = $null
  $request.Timeout = 6000
  $request.ReadWriteTimeout = 6000
  $request.Headers['Cache-Control'] = 'no-cache'
  $response = $request.GetResponse()
  $buffer = New-Object System.IO.MemoryStream
  try { $response.GetResponseStream().CopyTo($buffer); return ,$buffer.ToArray() }
  finally { $buffer.Dispose(); $response.Close() }
}
function Bytes-Hash([byte[]]$Bytes) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Normalize-Directory([string]$Directory) { return [IO.Path]::GetFullPath($Directory).TrimEnd('\').ToLowerInvariant() }
try {
  $health = [Text.Encoding]::UTF8.GetString((Get-LocalBytes ('/api/health?login_diagnostic=' + $stamp))) | ConvertFrom-Json
  if (-not $health.ok -or $health.application -ne 'wanling-manju') { throw '该端口不是万灵漫剧服务' }
  $report.serviceReachable = $true
  $installation = [string]$health.installationRoot
  $report.runningInstallation = $installation
  if ($installation -notmatch '^[A-Za-z]:[\\/]' -or -not (Test-Path -LiteralPath $installation -PathType Container)) { throw '运行目录无效；请确认在运行万灵漫剧的同一台电脑上检查' }
  $packageFile = Join-Path $installation 'package.json'
  $report.diskPackageVersion = if (Test-Path -LiteralPath $packageFile) { (Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { '缺少package.json' }
  $html = [Text.Encoding]::UTF8.GetString((Get-LocalBytes ('/?login_diagnostic=' + $stamp)))
  $entry = [regex]::Match($html, 'src="(/assets/[A-Za-z0-9_.-]+\.js)"').Groups[1].Value
  if (-not $entry) { throw '没有找到软件前端入口' }
  $report.servedFrontend = $entry
  $bytes = Get-LocalBytes ($entry + '?login_diagnostic=' + $stamp)
  $script = [Text.Encoding]::UTF8.GetString($bytes)
  $report.servedFrontendSha256 = Bytes-Hash $bytes
  $report.matchesV047PatchedFrontend = ($entry -eq $expectedEntry -and $report.servedFrontendSha256 -eq $expectedHash)
  $report.samePageLoginCodePresent = ($script.Contains('正在打开木木登录') -and $script.Contains('点击登录后将进入木木网页'))
  $diskHtml = Join-Path $installation 'dist\index.html'
  $report.diskFrontend = if (Test-Path -LiteralPath $diskHtml) { [regex]::Match((Get-Content -LiteralPath $diskHtml -Raw -Encoding UTF8), 'src="(/assets/[A-Za-z0-9_.-]+\.js)"').Groups[1].Value } else { '缺少dist/index.html' }
  try {
    $linkFile = Join-Path ([Environment]::GetFolderPath('Desktop')) '万灵漫剧.lnk'
    if (Test-Path -LiteralPath $linkFile) {
      $link = (New-Object -ComObject WScript.Shell).CreateShortcut($linkFile)
      $report.desktopShortcutDirectory = $link.WorkingDirectory
      $report.shortcutMatchesRunningInstallation = if ($link.WorkingDirectory) { (Normalize-Directory $link.WorkingDirectory) -eq (Normalize-Directory $installation) } else { $false }
    }
  } catch { $report.shortcutCheck = '快捷方式信息未能读取' }
  if ($report.matchesV047PatchedFrontend) {
    $report.conclusion = '当前服务提供的是v0.4.7登录修复代码；接下来从新打开的页面重试登录，以排除旧页面缓存。'
    $report.nextStep = '若仍闪退或报错，请提供本报告及登录页面的错误文字，再检查授权流程。'
  } elseif ($report.samePageLoginCodePresent) {
    $report.conclusion = '当前页面包含新版同页登录逻辑，但与v0.4.7补丁文件不完全一致。'
    $report.nextStep = '确认补丁覆盖到报告中的运行目录；从新页面重试，并保留报告中的版本信息。'
  } else {
    $report.conclusion = '当前服务仍提供旧登录代码，未加载v0.4.7补丁的登录修复。'
    $report.nextStep = '关闭万灵漫剧启动窗口，将补丁内容合并覆盖到报告中的运行目录，保留runtime，再从该目录双击启动试用.cmd。'
  }
} catch {
  $report.error = $_.Exception.Message
  $report.conclusion = if ($report.serviceReachable) { '诊断未能完成，请提供报告中的错误。' } else { '没有连接到本机万灵漫剧；先启动客户正在使用的软件，再运行此工具。' }
}
$directory = [IO.Path]::GetFullPath($ReportDirectory)
if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw '报告目录不存在' }
$jsonFile = Join-Path $directory '登录版本诊断.json'
$textFile = Join-Path $directory '登录版本诊断.txt'
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonFile -Encoding UTF8
$lines = New-Object 'System.Collections.Generic.List[string]'
$lines.Add('万灵漫剧登录版本诊断')
$lines.Add('结论：' + $report.conclusion)
foreach ($key in $report.Keys) { if ($key -ne 'conclusion') { $lines.Add($key + '：' + [string]$report[$key]) } }
$lines.Add('本工具只读取软件版本、运行目录和前端程序文件；未读取项目、账户、API Key或提交授权。')
$lines | Set-Content -LiteralPath $textFile -Encoding UTF8
Write-Output ($lines -join [Environment]::NewLine)
Write-Output ('报告已保存：' + $textFile)
if (-not $NoOpen -and $report.servedFrontend) {
  Start-Process -FilePath ($diagnosticOrigin + '/?login_check=' + $stamp)
}
