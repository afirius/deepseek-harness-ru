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
$ruLinks=@((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $shortcutName),(Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName))
$backupDir=Join-Path $launcherDir 'shortcut-backups'
$indexPath=Join-Path $backupDir 'index.json'
$standardLinks=@(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek Harness.lnk'),
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'DeepSeek Harness.lnk'),
    (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\DeepSeek Harness.lnk')
)
$shell=New-Object -ComObject WScript.Shell
function Quote-Argument([string]$Value) {
    if($Value.Contains('"')) { throw 'Недопустимый символ в пути.' }
    return '"'+($Value -replace '(\\+)$','$1$1')+'"'
}
function Get-LinkKey([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path).ToLowerInvariant()
    $hasher=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($full)))).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}
function Read-Index {
    if(Test-Path -LiteralPath $indexPath -PathType Leaf) {
        $raw=[IO.File]::ReadAllText($indexPath,[Text.Encoding]::UTF8)
        if($raw.Trim()) {
            $parsed=ConvertFrom-Json -InputObject $raw
            $result=@{}
            foreach($property in $parsed.PSObject.Properties) {
                $entry=$property.Value
                $storedPath=[string]$entry.Path
                $expectedKey=if($storedPath) { Get-LinkKey $storedPath } else { '' }
                if(-not ($standardLinks | Where-Object { [string]::Equals($_,$storedPath,[StringComparison]::OrdinalIgnoreCase) }) -or
                    $property.Name -ne $expectedKey -or [string]$entry.Backup -ne ($expectedKey+'.lnk')) {
                    throw 'Недопустимая запись резервной копии ярлыка.'
                }
                $result[$property.Name]=$entry
            }
            return $result
        }
    }
    return @{}
}
function Replace-FileAtomically([string]$Source,[string]$Destination) {
    if(Test-Path -LiteralPath $Destination) {
        $replaceBackup=Join-Path ([IO.Path]::GetDirectoryName($Destination)) ('.'+[IO.Path]::GetFileName($Destination)+'.'+[guid]::NewGuid().ToString('N')+'.replace-backup')
        try { [IO.File]::Replace($Source,$Destination,$replaceBackup) }
        finally { if(Test-Path -LiteralPath $replaceBackup) { Remove-Item -LiteralPath $replaceBackup -Force } }
    } else { [IO.File]::Move($Source,$Destination) }
}
function Write-Index($Index) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $tmp=Join-Path $backupDir ('index-'+[guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::WriteAllText($tmp,(ConvertTo-Json -InputObject $Index -Depth 5),[Text.UTF8Encoding]::new($false))
        Replace-FileAtomically $tmp $indexPath
    } finally { if(Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
}
function Backup-Original([string]$Path,$Index) {
    $linkKey=Get-LinkKey $Path
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backupName=$linkKey+'.lnk'
    $backupPath=Join-Path $backupDir $backupName
    $tmp=Join-Path $backupDir ($linkKey+'.'+[guid]::NewGuid().ToString('N')+'.tmp.lnk')
    try {
        Copy-Item -LiteralPath $Path -Destination $tmp
        Replace-FileAtomically $tmp $backupPath
    } finally { if(Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
    $Index[$linkKey]=@{ Path=[IO.Path]::GetFullPath($Path); Backup=$backupName }
    Write-Index $Index
}
try {
    if($Mode -eq 'Remove') {
        $index=Read-Index
        foreach($entry in @($index.Values)) {
            $linkPath=[string]$entry.Path
            $backupPath=Join-Path $backupDir ([string]$entry.Backup)
            if(-not (Test-Path -LiteralPath $linkPath -PathType Leaf) -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) { continue }
            $current=$shell.CreateShortcut($linkPath)
            if(-not [string]::IsNullOrWhiteSpace($current.TargetPath) -and [string]::Equals([IO.Path]::GetFullPath($current.TargetPath),$targetExe,[StringComparison]::OrdinalIgnoreCase)) {
                $restoreTmp=Join-Path ([IO.Path]::GetDirectoryName($linkPath)) ('.'+[IO.Path]::GetFileNameWithoutExtension($linkPath)+'.'+[guid]::NewGuid().ToString('N')+'.restore.lnk')
                try {
                    Copy-Item -LiteralPath $backupPath -Destination $restoreTmp
                    Replace-FileAtomically $restoreTmp $linkPath
                    $index.Remove((Get-LinkKey $linkPath))
                    Write-Index $index
                } finally { if(Test-Path -LiteralPath $restoreTmp) { Remove-Item -LiteralPath $restoreTmp -Force } }
            }
        }
        foreach($linkPath in $ruLinks) {
            if(Test-Path -LiteralPath $linkPath) {
                $existing=$shell.CreateShortcut($linkPath)
                if(-not [string]::IsNullOrWhiteSpace($existing.TargetPath) -and [string]::Equals([IO.Path]::GetFullPath($existing.TargetPath),$targetExe,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $linkPath -Force }
            }
        }
        Write-Output 'Перенаправленные штатные ярлыки восстановлены, собственные русские ярлыки удалены.'
        return
    }
    if(-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) { throw 'Не найден EXE русификатора.' }
    if(-not (Test-Path -LiteralPath $originalExe -PathType Leaf)) { throw 'Не найден DeepSeek Harness.exe.' }
    foreach($linkPath in $ruLinks) {
        if(Test-Path -LiteralPath $linkPath) {
            $existing=$shell.CreateShortcut($linkPath)
            if([string]::IsNullOrWhiteSpace($existing.TargetPath) -or
                -not [string]::Equals([IO.Path]::GetFullPath($existing.TargetPath),$targetExe,[StringComparison]::OrdinalIgnoreCase)) {
                throw "Ярлык уже принадлежит другой установке: $linkPath"
            }
        }
    }
    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    if(-not [string]::Equals($SourceExe,$targetExe,[StringComparison]::OrdinalIgnoreCase)) {
        $next=Join-Path $launcherDir ('launcher-'+[guid]::NewGuid().ToString('N')+'.tmp')
        try { Copy-Item -LiteralPath $SourceExe -Destination $next; Move-Item -LiteralPath $next -Destination $targetExe -Force }
        finally { if(Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force } }
    }
    $index=Read-Index
    $launchArgs='--launch --install-dir '+(Quote-Argument $InstallDir)+' --dsh-home '+(Quote-Argument $DshHome)
    foreach($linkPath in $standardLinks) {
        if(-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) { continue }
        $link=$shell.CreateShortcut($linkPath)
        if([string]::IsNullOrWhiteSpace($link.TargetPath)) { continue }
        $linkKey=Get-LinkKey $linkPath
        $pointsToWrapper=[string]::Equals([IO.Path]::GetFullPath($link.TargetPath),$targetExe,[StringComparison]::OrdinalIgnoreCase)
        if($pointsToWrapper -and $index.ContainsKey($linkKey)) { continue }
        $pointsToApp=[string]::Equals([IO.Path]::GetFullPath($link.TargetPath),$originalExe,[StringComparison]::OrdinalIgnoreCase)
        if(-not $pointsToApp -or -not [string]::IsNullOrWhiteSpace($link.Arguments)) { continue }
        Backup-Original $linkPath $index
        $tmp=Join-Path ([IO.Path]::GetDirectoryName($linkPath)) ('.'+[IO.Path]::GetFileNameWithoutExtension($linkPath)+'.'+[guid]::NewGuid().ToString('N')+'.tmp.lnk')
        try {
            Copy-Item -LiteralPath $linkPath -Destination $tmp
            $staged=$shell.CreateShortcut($tmp)
            $staged.TargetPath=$targetExe
            $staged.Arguments=$launchArgs
            $staged.Save()
            Replace-FileAtomically $tmp $linkPath
        } finally { if(Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
    }
    foreach($linkPath in $ruLinks) {
        $link=$shell.CreateShortcut($linkPath)
        $link.TargetPath=$targetExe
        $link.Arguments=$launchArgs
        $link.WorkingDirectory=$InstallDir
        $link.IconLocation=$originalExe+',0'
        $link.Description='Восстанавливает русскую локализацию перед запуском DeepSeek Harness.'
        $link.Save()
    }
    Write-Output ('Штатные ярлыки перенаправлены; созданы ярлыки «DeepSeek Harness — Русский». Программа запуска: '+$targetExe)
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
