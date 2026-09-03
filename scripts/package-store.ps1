param(
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist')
)

$ErrorActionPreference = 'Stop'
$extensionRoot = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$runtimeFiles = @(
    '_locales/en/messages.json',
    '_locales/ko/messages.json',
    'background.js',
    'content.js',
    'detection-policy.js',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'LICENSE',
    'manifest.json',
    'notebooklm-api.js',
    'offscreen.html',
    'offscreen.js',
    'pdf-file-policy.js',
    'pdf-metadata.js',
    'popup.html',
    'popup.js',
    'runtime-policy.js',
    'source-import.js',
    'site-permissions.js'
)

foreach ($relativePath in $runtimeFiles) {
    $sourcePath = Join-Path $extensionRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required runtime file is missing: $relativePath"
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = Join-Path $OutputDirectory "scholar-relay-v$($manifest.version).zip"
$checksumPath = "$outputPath.sha256"
$obsoletePaths = @(
    (Join-Path $OutputDirectory "scholar-relay-v$($manifest.version)-store.zip"),
    (Join-Path $OutputDirectory "chrome-pdf-to-notebooklm-v$($manifest.version)-store.zip"),
    $outputPath,
    $checksumPath
)
foreach ($obsoletePath in $obsoletePaths) {
    if (Test-Path -LiteralPath $obsoletePath) {
        Remove-Item -LiteralPath $obsoletePath -Force
    }
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

$sha256 = [Security.Cryptography.SHA256]::Create()
$zipStream = [IO.File]::OpenRead($outputPath)
try {
    $hashBytes = $sha256.ComputeHash($zipStream)
}
finally {
    $zipStream.Dispose()
    $sha256.Dispose()
}
$hash = [BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
$checksumLine = "$hash  $([IO.Path]::GetFileName($outputPath))`n"
[IO.File]::WriteAllText($checksumPath, $checksumLine, [Text.UTF8Encoding]::new($false))

Write-Output $outputPath
Write-Output $checksumPath
