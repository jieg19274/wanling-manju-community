param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$releaseRoot = (Resolve-Path -LiteralPath $Root).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($releaseRoot + '.zip')
$issues = @()
$entries = 0
$manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'package-manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
try {
 foreach ($entry in $zip.Entries) {
  if ($entry.FullName.EndsWith('/')) { continue }
  $entries++
  $relative = ($entry.FullName -split '/',2)[1]
  $disk = Join-Path $releaseRoot $relative
  $stream = $entry.Open()
  try { $sha = [Security.Cryptography.SHA256]::Create(); $zipHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', ''); $sha.Dispose() } finally { $stream.Dispose() }
  if (!(Test-Path -LiteralPath $disk) -or $zipHash -ne (Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash) { $issues += "hash:$relative" }
  if ($relative -match '(?i)(\.db$|\.sqlite|\.log$|\.env$|direct-provider\.json|provider-account\.json|budget-profile|^runtime)') { $issues += "excluded:$relative" }
  if ($relative -match '(?i)style-thumbs' -and $manifest.userAssetsAuthorized -ne $true) { $issues += "unauthorized-preview:$relative" }
  if ($relative -match '(?i)\.(js|mjs|json|md|html|cmd)$') {
   $content = Get-Content -LiteralPath $disk -Raw -Encoding utf8
   if ($content -match 'Sentinel_[0-9a-f]{20,}|f2fac0fb-28b6-441a-8146-e3dfa073daf0|(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_-]{20,}') { $issues += "identifier:$relative" }
   if ($relative.StartsWith('dist/') -and $content -match '/style-thumbs/' -and $manifest.userAssetsAuthorized -ne $true) { $issues += "unauthorized-preview-reference:$relative" }
  }
 }
 foreach ($file in Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'catalog') -Filter '*.json') {
  $catalog = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json
  if ($catalog.effects.Count -ne 0 -and $manifest.userAssetsAuthorized -ne $true) { $issues += "unauthorized-catalog:$($file.Name)" }
 }
 foreach ($item in $manifest.files) {
  $disk = Join-Path $releaseRoot $item.file
  if (!(Test-Path -LiteralPath $disk) -or (Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { $issues += "manifest:$($item.file)" }
 }
 if ($manifest.bundledNativeDependencies -eq $false -and ($zip.Entries.FullName -match 'node_modules/|\.(dll|node|exe)$')) { $issues += 'unexpected-vendor-binary' }
 if ($manifest.shareReady -eq $true) {
  $acceptance = Get-Content -LiteralPath (Join-Path $releaseRoot 'trial-acceptance.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if ($manifest.bundledNativeDependencies -ne $false -or $acceptance.independentNpmInstallation -ne $true -or $acceptance.videoPreviewAndReturnPassed -ne $true -or $acceptance.noProducerCredentials -ne $true) { $issues += 'trial-acceptance-incomplete' }
 }
 $result = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); zip=($releaseRoot+'.zip'); entries=$entries; passed=($issues.Count -eq 0); issues=$issues; shareReady=($manifest.shareReady -eq $true -and $issues.Count -eq 0); readinessScope=$manifest.readinessScope; blocker=$manifest.releaseBlocker; bundledNativeDependencies=$manifest.bundledNativeDependencies }
 $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($releaseRoot+'.audit.json') -Encoding utf8
 $result | ConvertTo-Json -Depth 5
 if ($issues.Count -gt 0) { throw 'Candidate audit failed' }
} finally { $zip.Dispose() }
