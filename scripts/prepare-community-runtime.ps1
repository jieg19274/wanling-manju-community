param([string]$AppRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
$runtimeRoot = Join-Path $AppRoot 'runtime'
$setupRoot = Join-Path $runtimeRoot 'setup'
$cacheRoot = Join-Path $setupRoot 'cache'
$toolsRoot = Join-Path $AppRoot 'tools'
[void][IO.Directory]::CreateDirectory($cacheRoot)
[void][IO.Directory]::CreateDirectory($toolsRoot)
$config = Get-Content -LiteralPath (Join-Path $AppRoot 'scripts\community-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-VerifiedArchive($Spec, [string]$Name) {
    if ($Spec.url -notmatch '^https://(nodejs\.org/download/release/|github\.com/GyanD/codexffmpeg/releases/download/)' -or $Spec.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw '运行环境来源配置无效。'
    }
    $archive = Join-Path $cacheRoot $Name
    if ((Test-Path -LiteralPath $archive) -and (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Spec.sha256) {
        return $archive
    }
    $partial = $archive + '.partial'
    Write-Host ('正在从官方渠道下载 ' + $Name + '，请保持网络连接。')
    Invoke-WebRequest -UseBasicParsing -Uri $Spec.url -OutFile $partial -TimeoutSec 900
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Spec.sha256) {
        Remove-Item -LiteralPath $partial -Force
        throw ($Name + ' 下载校验失败；未运行该文件。请检查网络后重试。')
    }
    Move-Item -LiteralPath $partial -Destination $archive -Force
    return $archive
}

function Remove-SetupDirectory([string]$Directory) {
    $resolved = (Resolve-Path -LiteralPath $Directory).Path
    if (-not $resolved.StartsWith($setupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '临时目录超出运行环境准备目录。'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Install-OfficialArchive($Spec, [string]$Name, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) {
        throw ('已有不同版本的运行工具目录：' + $Destination + '。请先关闭软件，备份后核对该目录。')
    }
    $archive = Get-VerifiedArchive $Spec $Name
    $extract = Join-Path $setupRoot ([Guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $extract
        $source = Join-Path $extract $Spec.directory
        if (-not (Test-Path -LiteralPath (Join-Path $source 'LICENSE'))) { throw '官方运行包缺少许可证。' }
        $resolvedSource = (Resolve-Path -LiteralPath $source).Path
        $resolvedDestination = [IO.Path]::GetFullPath($Destination)
        if (-not $resolvedSource.StartsWith($extract + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
            -not $resolvedDestination.StartsWith($toolsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw '运行工具的移动路径超出本次准备目录。'
        }
        # A just-extracted executable can briefly be held by the Windows scanner.
        # Rename only this verified directory; do not alter ACLs or security settings.
        for ($moveAttempt = 0; $moveAttempt -lt 10; $moveAttempt++) {
            try { [IO.Directory]::Move($resolvedSource, $resolvedDestination); break }
            catch {
                if ($moveAttempt -eq 9) { throw }
                Start-Sleep -Milliseconds 300
            }
        }
    } finally {
        if (Test-Path -LiteralPath $extract) { Remove-SetupDirectory $extract }
    }
}

$lockFile = Join-Path $setupRoot 'preparation.lock'
$lockStream = $null
try {
    try { $lockStream = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw '另一窗口正在准备运行环境。请等待该窗口完成后再打开软件。' }
    Write-Host '万灵漫剧社区版：准备本机运行环境。'
    $nodeRoot = Join-Path $toolsRoot 'node'
    $nodeExe = Join-Path $nodeRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        Install-OfficialArchive $config.node 'node-v24.21.0-win-x64.zip' $nodeRoot
    }
    $nodeVersion = & $nodeExe --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion.Trim() -ne ('v' + $config.node.version)) { throw 'Node.js 版本不符合社区版运行环境配置。' }
    $npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
    $dependencyHash = (Get-FileHash -LiteralPath (Join-Path $AppRoot 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $stateFile = Join-Path $setupRoot 'dependencies.json'
    $previousHash = ''
    if (Test-Path -LiteralPath $stateFile) {
        try { $previousHash = (Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json).lockSHA256 } catch {}
    }
    $previousPath = $env:PATH
    $env:PATH = $nodeRoot + ';' + $previousPath
    Push-Location -LiteralPath $AppRoot
    try {
        if ($previousHash -ne $dependencyHash -or -not (Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules\sharp\package.json'))) {
            Write-Host '正在从 npm 官方仓库安装锁定的图片依赖。'
            $npmConfig = Join-Path $setupRoot 'npmrc'
            [IO.File]::WriteAllText($npmConfig, '')
            & $nodeExe $npmCli ci --omit=dev --include=optional --ignore-scripts --no-fund --no-audit --registry=https://registry.npmjs.org/ ('--userconfig=' + $npmConfig)
            if ($LASTEXITCODE -ne 0) { throw '图片依赖安装失败；请检查网络后重新打开软件。' }
        }
        & $nodeExe (Join-Path $AppRoot 'scripts\verify-community-runtime.mjs')
        if ($LASTEXITCODE -ne 0) { throw '图片依赖验证失败；没有标记准备完成。' }
        @{lockSHA256 = $dependencyHash; at = [DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    } finally {
        Pop-Location
        $env:PATH = $previousPath
    }
    $ffRoot = Join-Path $toolsRoot 'ffmpeg'
    $ffExe = Join-Path $ffRoot 'bin\ffmpeg.exe'
    $probeExe = Join-Path $ffRoot 'bin\ffprobe.exe'
    if (-not (Test-Path -LiteralPath $ffExe)) {
        Install-OfficialArchive $config.ffmpeg 'ffmpeg-9.0.2-essentials_build.zip' $ffRoot
    }
    if (-not (Test-Path -LiteralPath $probeExe)) { throw '视频工具缺少 ffprobe。' }
    $ffVersion = (& $ffExe -version | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $ffVersion -notmatch '^ffmpeg version 9\.0\.2(?:-|\s)') { throw '视频工具版本不符合社区版配置。' }
    & $probeExe -version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '视频探测工具无法运行。' }
    @{at = [DateTime]::UtcNow.ToString('o'); node = $config.node; ffmpeg = $config.ffmpeg; npmLockSHA256 = $dependencyHash} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $setupRoot 'provenance.json') -Encoding UTF8
    Write-Host '运行环境准备完成。'
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
