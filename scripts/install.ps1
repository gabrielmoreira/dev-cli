$ErrorActionPreference = "Stop"

$Version = "__DEV_VERSION__"
$ReleasesUrl = if ($env:DEV_RELEASES_URL) {
    $env:DEV_RELEASES_URL.TrimEnd("/")
} else {
    "https://github.com/gabrielmoreira/dev-cli/releases"
}
$TempDir = $null
$StagedBinary = $null

function Write-Info([string]$Message) {
    Write-Host "dev installer: $Message"
}

function Get-NativeArchitecture {
    try {
        $Architecture = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment").PROCESSOR_ARCHITECTURE
    } catch {
        $Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }

    switch ($Architecture.ToUpperInvariant()) {
        "ARM64" { return "arm64" }
        "AMD64" { return "x64" }
        "X64" { return "x64" }
        default { throw "Unsupported architecture: $Architecture" }
    }
}

function Get-InstallDirectory {
    if ($env:DEV_INSTALL_DIR) {
        return $env:DEV_INSTALL_DIR
    }
    if ($env:XDG_BIN_HOME) {
        return $env:XDG_BIN_HOME
    }
    return Join-Path $HOME ".local\bin"
}

function Get-ExpectedChecksum([string]$ChecksumFile, [string]$Asset) {
    $Pattern = "^([0-9a-fA-F]{64})  $([regex]::Escape($Asset))$"
    foreach ($Line in Get-Content -LiteralPath $ChecksumFile) {
        if ($Line -match $Pattern) {
            return $Matches[1].ToLowerInvariant()
        }
    }
    throw "No checksum published for $Asset"
}

function Assert-Checksum([string]$Archive, [string]$ChecksumFile, [string]$Asset) {
    $Expected = Get-ExpectedChecksum $ChecksumFile $Asset
    $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        throw "Checksum mismatch for $Asset"
    }
}

function Assert-Binary([string]$Binary) {
    $Reported = (& $Binary --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Downloaded binary could not be executed"
    }
    if ($Reported -ne "dev v$Version") {
        throw "Downloaded binary reported '$Reported', expected 'dev v$Version'"
    }
}

function Install-Binary([string]$Binary, [string]$InstallDir) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $Destination = Join-Path $InstallDir "dev.exe"
    $script:StagedBinary = Join-Path $InstallDir ".dev.new.$PID.exe"
    Copy-Item -LiteralPath $Binary -Destination $script:StagedBinary -Force
    Move-Item -LiteralPath $script:StagedBinary -Destination $Destination -Force
    $script:StagedBinary = $null
    Write-Info "Installed dev v$Version to $Destination"
}

function Add-ToUserPath([string]$InstallDir) {
    $CurrentEntries = @($env:Path -split ";" | Where-Object { $_ })
    if ($CurrentEntries.Where({ $_.TrimEnd("\") -ieq $InstallDir.TrimEnd("\") }).Count -gt 0) {
        return
    }

    if ($env:DEV_INSTALL_DIR -or $env:DEV_NO_MODIFY_PATH -eq "1") {
        Write-Info "Add $InstallDir to PATH before running dev"
        return
    }

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $UserEntries = @($UserPath -split ";" | Where-Object { $_ })
    if ($UserEntries.Where({ $_.TrimEnd("\") -ieq $InstallDir.TrimEnd("\") }).Count -eq 0) {
        $UpdatedPath = (@($UserEntries) + $InstallDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")
        Write-Info "Added $InstallDir to the user PATH"
    }
    $env:Path = "$InstallDir;$env:Path"
    Write-Info "Open a new terminal, then run: dev init"
}

try {
    $Machine = Get-NativeArchitecture
    $Asset = "dev-windows-$Machine.zip"
    $InstallDir = Get-InstallDirectory
    $ReleaseUrl = "$ReleasesUrl/download/v$Version"
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "dev-installer-$([guid]::NewGuid())"
    $Archive = Join-Path $TempDir $Asset
    $ChecksumFile = Join-Path $TempDir "SHA256SUMS"
    $Extracted = Join-Path $TempDir "extracted"

    New-Item -ItemType Directory -Force -Path $Extracted | Out-Null
    Write-Info "Downloading dev v$Version (windows-$Machine)"
    Invoke-WebRequest -Uri "$ReleaseUrl/$Asset" -OutFile $Archive
    Invoke-WebRequest -Uri "$ReleaseUrl/SHA256SUMS" -OutFile $ChecksumFile
    Assert-Checksum $Archive $ChecksumFile $Asset
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force

    $Binary = Join-Path $Extracted "dev.exe"
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
        throw "$Asset does not contain dev.exe"
    }
    Assert-Binary $Binary
    Install-Binary $Binary $InstallDir
    Add-ToUserPath $InstallDir
} catch {
    Write-Error "dev installer: $($_.Exception.Message)"
    exit 1
} finally {
    if ($TempDir -and (Test-Path -LiteralPath $TempDir)) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
    if ($StagedBinary -and (Test-Path -LiteralPath $StagedBinary)) {
        Remove-Item -LiteralPath $StagedBinary -Force
    }
}
