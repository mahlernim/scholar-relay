param(
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist')
)

$ErrorActionPreference = 'Stop'
$extensionRoot = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$runtimeFiles = @(
    'background.js',
    'content.js',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'LICENSE',
    'manifest.json',
    'notebooklm-api.js',
    'offscreen.html',
    'offscreen.js',
    'pdf-metadata.js',
    'popup.html',
    'popup.js',
    'runtime-policy.js',
    'site-permissions.js'
)

foreach ($relativePath in $runtimeFiles) {
    $sourcePath = Join-Path $extensionRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required runtime file is missing: $relativePath"
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = Join-Path $OutputDirectory "scholar-relay-v$($manifest.version)-store.zip"
$legacyOutputPath = Join-Path $OutputDirectory "chrome-pdf-to-notebooklm-v$($manifest.version)-store.zip"
if (Test-Path -LiteralPath $legacyOutputPath) {
    Remove-Item -LiteralPath $legacyOutputPath -Force
}
if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::CreateNew)
$archive = [System.IO.Compression.ZipArchive]::new(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
)

try {
    foreach ($relativePath in $runtimeFiles) {
        $sourcePath = Join-Path $extensionRoot $relativePath
        $entryName = $relativePath.Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $sourcePath,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
    $stream.Dispose()
}

Write-Output $outputPath
