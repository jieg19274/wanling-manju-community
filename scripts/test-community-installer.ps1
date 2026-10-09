param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$validationRoot = Join-Path $repoRoot '.test-temp\installer-validation'
$installRoot = Join-Path $validationRoot 'installed community test'
[void][IO.Directory]::CreateDirectory($validationRoot)
if (Test-Path -LiteralPath $installRoot) { throw 'Installer test directory already exists; use a fresh isolated checkout.' }
if (Get-ItemProperty -LiteralPath 'HKCU:\Software\WanlingManjuCommunity' -Name InstallationRoot -ErrorAction SilentlyContinue) {
    throw 'A community edition is already installed for this user. Run this test on an isolated Windows runner.'
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
$installed = $false
$result = @{installerSHA256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant(); passed = $false}
try {
    $installLog = Join-Path $validationRoot 'install.log'
    $process = Start-Process -FilePath $msiexec -ArgumentList @('/i',('"'+$Installer+'"'),'/qn','/norestart',('INSTALLFOLDER="'+$installRoot+'"'),'/l*v',('"'+$installLog+'"')) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw ('MSI install failed: '+$process.ExitCode+'; '+$installLog) }
    $installed = $true
    $manifest = Get-Content -LiteralPath (Join-Path $installRoot 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($file in $manifest.files) {
        if ((Get-FileHash -LiteralPath (Join-Path $installRoot $file.file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
            throw ('Installed file hash mismatch: '+$file.file)
        }
    }
    $result.filesVerified = $manifest.files.Count
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '万灵漫剧社区版.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if (-not (Test-Path -LiteralPath $shortcutPath) -or $shortcut.Arguments -notlike ('*'+$installRoot+'\scripts\launch-community.ps1*')) {
        $desktopProperty = (Select-String -LiteralPath $installLog -Pattern 'DesktopFolder = ' | Select-Object -Last 2 | ForEach-Object { $_.Line }) -join '; '
        throw ('Desktop shortcut does not reference this installed community edition. Expected: '+$shortcutPath+'; actual arguments: '+$shortcut.Arguments+'; MSI desktop: '+$desktopProperty)
    }
    $result.desktopShortcut = $true
    $expectedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($shortcut.TargetPath -ne $expectedPowerShell -or -not (Test-Path -LiteralPath $shortcut.TargetPath)) { throw 'Desktop shortcut has an invalid PowerShell target.' }
    $menuShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) '万灵漫剧社区版\万灵漫剧社区版.lnk'
    $menuShortcut = $shell.CreateShortcut($menuShortcutPath)
    if (-not (Test-Path -LiteralPath $menuShortcutPath) -or $menuShortcut.TargetPath -ne $expectedPowerShell -or $menuShortcut.Arguments -notlike ('*'+$installRoot+'\scripts\launch-community.ps1*')) { throw 'Start menu shortcut is missing or points to a different installation.' }
    $result.startMenuShortcut = $true
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installRoot 'scripts\launch-community.ps1') -PrepareOnly
    if ($LASTEXITCODE -ne 0) { throw 'First-run runtime preparation failed.' }
    $result.firstRunPreparation = $true
    $node = Join-Path $installRoot 'tools\node\node.exe'
    & $node (Join-Path $repoRoot 'scripts\smoke-source.mjs') $installRoot
    if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke check failed.' }
    $result.installedApplicationSmoke = $true
    $ffmpeg = Join-Path $installRoot 'tools\ffmpeg\bin\ffmpeg.exe'
    $probe = Join-Path $installRoot 'tools\ffmpeg\bin\ffprobe.exe'
    $video = Join-Path $validationRoot 'encoded-sample.mp4'
    & $ffmpeg -hide_banner -loglevel error -f lavfi -i 'color=c=blue:s=64x64:r=24' -f lavfi -i 'sine=frequency=440:sample_rate=44100' -t 0.25 -c:v libx264 -pix_fmt yuv420p -c:a aac -y $video
    if ($LASTEXITCODE -ne 0) { throw 'Downloaded FFmpeg cannot encode H.264/AAC.' }
    $mediaInfo = (& $probe -v error -show_streams -of json $video | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or @($mediaInfo.streams | Where-Object codec_name -eq 'h264').Count -ne 1 -or @($mediaInfo.streams | Where-Object codec_name -eq 'aac').Count -ne 1) {
        throw 'Downloaded media tools produced an invalid sample.'
    }
    $result.mediaEncodeAndProbe = $true
    $retainedFile = Join-Path $installRoot 'runtime\user-data-preservation-check.txt'
    [IO.File]::WriteAllText($retainedFile, 'User data must survive application uninstall.')
    $uninstallLog = Join-Path $validationRoot 'uninstall.log'
    $uninstall = Start-Process -FilePath $msiexec -ArgumentList @('/x',('"'+$Installer+'"'),'/qn','/norestart','/l*v',('"'+$uninstallLog+'"')) -WindowStyle Hidden -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw ('MSI uninstall failed: '+$uninstall.ExitCode+'; '+$uninstallLog) }
    $installed = $false
    if (-not (Test-Path -LiteralPath $retainedFile)) { throw 'Uninstall deleted runtime user data.' }
    if (Test-Path -LiteralPath (Join-Path $installRoot 'scripts\launch-community.ps1')) { throw 'Uninstall left an installed application file.' }
    if (Test-Path -LiteralPath $shortcutPath) { throw 'Uninstall left the installed desktop shortcut.' }
    $result.uninstallPreservesUserData = $true
    $result.uninstallRemovesApplicationAndShortcut = $true
    $result.paidModelCalls = 0
    $result.passed = $true
} finally {
    if ($installed) {
        $cleanup = Start-Process -FilePath $msiexec -ArgumentList @('/x',('"'+$Installer+'"'),'/qn','/norestart') -WindowStyle Hidden -Wait -PassThru
        $result.cleanupExitCode = $cleanup.ExitCode
    }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $validationRoot 'result.json') -Encoding UTF8
}
$result | ConvertTo-Json -Depth 8
