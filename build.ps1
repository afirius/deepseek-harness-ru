param(
    [string]$ProjectRoot = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$LauncherDir = Join-Path $ProjectRoot 'launcher'
$ToolsDir = Join-Path $ProjectRoot 'tools'
$PayloadDir = Join-Path $ProjectRoot 'payload'
$DistDir = Join-Path $ProjectRoot 'dist'
$BundleZip = Join-Path $LauncherDir 'payload.zip'
$ExePath = Join-Path $DistDir 'DeepSeek-Harness-RU.exe'
$Compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Не найден компилятор .NET Framework: $Compiler" }
if (-not (Test-Path -LiteralPath $ToolsDir -PathType Container)) { throw "Не найдена папка tools: $ToolsDir" }
if (-not (Test-Path -LiteralPath $PayloadDir -PathType Container)) { throw "Не найдена папка payload: $PayloadDir" }
foreach ($tool in @('installer.mjs', 'shell-asar.mjs', 'shell-patch.mjs', 'renderer-patch.mjs', 'patch-structure.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ToolsDir $tool) -PathType Leaf)) { throw "Не найден tools\$tool." }
}
if (-not (Test-Path -LiteralPath (Join-Path $LauncherDir 'Program.cs') -PathType Leaf)) { throw 'Не найден launcher\Program.cs.' }

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
if (Test-Path -LiteralPath $BundleZip) { Remove-Item -LiteralPath $BundleZip -Force }
try {
    Compress-Archive -Path $ToolsDir, $PayloadDir -DestinationPath $BundleZip -CompressionLevel Optimal
    $compilerArgs = @(
        '/nologo',
        '/target:winexe',
        '/platform:x64',
        '/optimize+',
        '/codepage:65001',
        ('/out:' + $ExePath),
        ('/resource:' + $BundleZip + ',DeepSeekHarnessRu.payload.zip'),
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.IO.Compression.dll',
        '/reference:System.IO.Compression.FileSystem.dll',
        (Join-Path $LauncherDir 'Program.cs')
    )
    & $Compiler @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw "Компиляция завершилась с кодом $LASTEXITCODE." }
    Write-Host "Создано: $ExePath"
}
finally {
    if (Test-Path -LiteralPath $BundleZip) { Remove-Item -LiteralPath $BundleZip -Force }
}
