param(
    [Parameter(Mandatory=$true)][string]$SourceExe,
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [Parameter(Mandatory=$true)][string]$DshHome,
    [ValidateSet('Install','Remove')][string]$Mode='Install'
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$InstallDir=[IO.Path]::GetFullPath($InstallDir)
$DshHome=[IO.Path]::GetFullPath($DshHome)
$SourceExe=[IO.Path]::GetFullPath($SourceExe)
$sha=[Security.Cryptography.SHA256]::Create()
try {
    $pathBytes=[Text.Encoding]::UTF8.GetBytes($InstallDir.ToLowerInvariant())
    $hashBytes=$sha.ComputeHash($pathBytes)
    $key=([BitConverter]::ToString($hashBytes)).Replace('-','').ToLowerInvariant().Substring(0,16)
} finally { $sha.Dispose() }
$launcherDir=Join-Path $DshHome ('localization\ru-launcher\'+$key)
$targetExe=Join-Path $launcherDir 'DeepSeek-Harness-RU.exe'
$originalExe=Join-Path $InstallDir 'DeepSeek Harness.exe'
$shortcutName='DeepSeek Harness — Русский.lnk'
$links=@((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $shortcutName),(Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName))
$shell=New-Object -ComObject WScript.Shell
function Quote-Argument([string]$Value) {
    if($Value.Contains('"')) { throw 'Недопустимый символ в пути.' }
    return '"'+($Value -replace '(\\+)$','$1$1')+'"'
}
try {
    # Only touch our dedicated shortcuts, never the official app shortcuts.
    foreach($linkPath in $links) {
        if(Test-Path -LiteralPath $linkPath) {
            $existing=$shell.CreateShortcut($linkPath)
            if(-not [string]::Equals($existing.TargetPath,$targetExe,[StringComparison]::OrdinalIgnoreCase)) {
                if($Mode -eq 'Remove') { continue }
                throw "Ярлык уже принадлежит другой установке: $linkPath"
            }
            if($Mode -eq 'Remove') { Remove-Item -LiteralPath $linkPath -Force }
        }
    }
    if($Mode -eq 'Remove') { Write-Output 'Ярлыки автоматического восстановления удалены.'; return }
    if(-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) { throw 'Не найден EXE русификатора.' }
    if(-not (Test-Path -LiteralPath $originalExe -PathType Leaf)) { throw 'Не найден DeepSeek Harness.exe.' }
    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    if(-not [string]::Equals($SourceExe,$targetExe,[StringComparison]::OrdinalIgnoreCase)) {
        $next=Join-Path $launcherDir ('launcher-'+[guid]::NewGuid().ToString('N')+'.tmp')
        try { Copy-Item -LiteralPath $SourceExe -Destination $next; Move-Item -LiteralPath $next -Destination $targetExe -Force }
        finally { if(Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force } }
    }
    foreach($linkPath in $links) {
        $link=$shell.CreateShortcut($linkPath)
        $link.TargetPath=$targetExe
        $link.Arguments='--launch --install-dir '+(Quote-Argument $InstallDir)+' --dsh-home '+(Quote-Argument $DshHome)
        $link.WorkingDirectory=$InstallDir
        $link.IconLocation=$originalExe+',0'
        $link.Description='Восстанавливает русскую локализацию перед запуском DeepSeek Harness.'
        $link.Save()
    }
    Write-Output ('Созданы ярлыки «DeepSeek Harness — Русский». Программа запуска: '+$targetExe)
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
