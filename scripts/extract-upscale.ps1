param([Parameter(Mandatory=$true)][string]$ArchivePath,[Parameter(Mandatory=$true)][string]$DestinationDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$upscaleExtractRoot=[IO.Path]::GetFullPath($DestinationDirectory).TrimEnd('\')
if ((Split-Path -Leaf $upscaleExtractRoot) -notmatch '^\.extract-[A-Za-z0-9]+$') { throw 'Invalid extraction directory' }
$upscaleArchive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
try {
  foreach($entry in $upscaleArchive.Entries){
    $upscaleEntryPath=[IO.Path]::GetFullPath([IO.Path]::Combine($upscaleExtractRoot,$entry.FullName))
    if (-not $upscaleEntryPath.StartsWith($upscaleExtractRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path outside extraction directory' }
  }
} finally { $upscaleArchive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($ArchivePath),$upscaleExtractRoot)
