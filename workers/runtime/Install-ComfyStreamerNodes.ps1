[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern("^[A-Za-z0-9._-]+$")]
    [string]$Distro,
    [Parameter(Mandatory=$true)]
    [ValidatePattern("^/home/[A-Za-z0-9._/-]+$")]
    [string]$ComfyRoot,
    [Parameter(Mandatory=$true)]
    [ValidateSet("generation", "upscale")]
    [string]$Role,
    [string]$ComfyPython,
    [switch]$InstallComfyUI,
    [switch]$InstallDependencies,
    [switch]$DownloadModels,
    [string]$FastVideoRevision
)

$ErrorActionPreference = "Stop"
if ($DownloadModels) {
    if ($Role -ne "generation") { throw "FastH3 generator models are only used by the generation role." }
    if ($FastVideoRevision -notmatch "^[0-9a-fA-F]{40}$") { throw "Pass a reviewed 40-character FastVideo model revision." }
    $InstallDependencies = $true
}
if ($InstallComfyUI) {
    $InstallDependencies = $true
    if (-not $ComfyPython) { $ComfyPython = "$ComfyRoot/.venv/bin/python" }
    if ($ComfyPython -ne "$ComfyRoot/.venv/bin/python") { throw "-InstallComfyUI creates and uses $ComfyRoot/.venv/bin/python; choose that ComfyPython path or install dependencies into an existing ComfyUI checkout separately." }
}
if ($env:OS -ne "Windows_NT") { throw "Run this installer from Windows PowerShell." }
$Wsl = Join-Path $env:WINDIR "System32\wsl.exe"
$RuntimeArchive = Join-Path $PSScriptRoot "ComfyStreamer-Wsl-runtime.zip"
if (-not (Test-Path -LiteralPath $RuntimeArchive -PathType Leaf)) { throw "ComfyStreamer-Wsl-runtime.zip is missing from this bundle." }
if (-not (Test-Path -LiteralPath $Wsl -PathType Leaf)) { throw "wsl.exe is missing." }
if ($ComfyRoot.Contains("..")) { throw "ComfyRoot may not contain parent-directory components." }
if ($InstallDependencies) {
    if (-not $ComfyPython -or $ComfyPython -notmatch "^$([regex]::Escape($ComfyRoot))/[A-Za-z0-9._/-]+$" -or $ComfyPython.Contains("..")) {
        throw "Pass -ComfyPython as the Linux Python executable ComfyUI uses, under ComfyRoot."
    }
}

function Invoke-Wsl([string[]]$Arguments) {
    $output = & $Wsl @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($output -join ' ')" }
    return ($output -join "`n").Trim()
}

function Invoke-WslInteractive([string[]]$Arguments) {
    & $Wsl @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Interactive WSL setup command failed; no GPU job was started." }
}

function Test-IdenticalTree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { return $false }
    $sourceFiles = @(Get-ChildItem -LiteralPath $Source -Recurse -File -Force | Sort-Object FullName)
    $targetFiles = @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Force | Sort-Object FullName)
    if ($sourceFiles.Count -ne $targetFiles.Count) { return $false }
    for ($index = 0; $index -lt $sourceFiles.Count; $index++) {
        if (($sourceFiles[$index].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($targetFiles[$index].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to compare a custom-node tree containing a reparse point."
        }
        $sourceRelative = $sourceFiles[$index].FullName.Substring($Source.Length).TrimStart([char]92, [char]47)
        $targetRelative = $targetFiles[$index].FullName.Substring($Destination.Length).TrimStart([char]92, [char]47)
        if ($sourceRelative -ne $targetRelative) { return $false }
        if ((Get-FileHash -LiteralPath $sourceFiles[$index].FullName -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $targetFiles[$index].FullName -Algorithm SHA256).Hash) { return $false }
    }
    return $true
}

$runtimeExtract = Join-Path $env:TEMP "sloptogether-comfy-runtime-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $runtimeExtract | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($RuntimeArchive)
    try {
        $expandedBytes=0L
        foreach ($entry in $zip.Entries) {
            $parts = $entry.FullName -split "[/\\]"
            if ([IO.Path]::IsPathRooted($entry.FullName) -or $parts -contains ".." -or $entry.FullName.Contains(":")) {
                throw "Runtime archive contains an unsafe path."
            }
            if ($entry.FullName -match "(?i)\.(safetensors|ckpt|pt|pth)$") { throw "ComfyStreamer runtime archives must not contain model weights." }
            $expandedBytes += $entry.Length
            if ($expandedBytes -gt 67108864) { throw "ComfyStreamer runtime archive exceeds the 64 MiB setup limit." }
            $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixMode -eq 0xA000) { throw "Runtime archive symlinks are forbidden." }
        }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($RuntimeArchive, $runtimeExtract)
    } finally { $zip.Dispose() }

    $manifestPath = Join-Path $runtimeExtract "worker-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Runtime archive manifest is missing." }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schema -ne "comfystream-worker-artifact/1" -or $manifest.profile -ne "vast") { throw "Runtime archive profile is unsupported." }
    $comfyRef = [string]$manifest.runtime.comfyui_ref
    if ($comfyRef -notmatch "^[0-9a-f]{40}$") { throw "Runtime manifest has an invalid ComfyUI pin." }
    if ($InstallComfyUI) {
        $prerequisiteCheck = "command -v git >/dev/null && command -v python3.12 >/dev/null && python3.12 -c 'import venv' && command -v ffmpeg >/dev/null"
        try { $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc", $prerequisiteCheck) }
        catch {
            Write-Host "Installing WSL packages required by pinned ComfyUI; sudo may ask for the Linux user password."
            Invoke-WslInteractive @("--distribution", $Distro, "--exec", "bash", "-lc",
                "sudo apt-get update && sudo apt-get install -y git curl python3.12 python3.12-venv python3.12-dev ffmpeg libgl1 libglib2.0-0")
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc", $prerequisiteCheck)
        }
    } else {
        $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "--version")
    }
    $comfyState = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc",
        "if test -f '$ComfyRoot/main.py' && test -d '$ComfyRoot/.git'; then git -C '$ComfyRoot' rev-parse HEAD; elif test -e '$ComfyRoot'; then echo conflict; else echo missing; fi")
    if ($comfyState -eq "missing") {
        if (-not $InstallComfyUI) { throw "ComfyUI is missing. Use -InstallComfyUI to install the pinned source and Python environment." }
        $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "--version")
        $temporaryComfy = "$ComfyRoot.sloptogether-$([Guid]::NewGuid().ToString('N'))"
        try {
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "clone", "--depth", "1", "--no-checkout", "--filter=blob:none",
                "https://github.com/Comfy-Org/ComfyUI.git", $temporaryComfy)
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "-C", $temporaryComfy, "fetch", "--depth", "1", "origin", $comfyRef)
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "-C", $temporaryComfy, "checkout", "--detach", $comfyRef)
            $actualComfyRef = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "-C", $temporaryComfy, "rev-parse", "HEAD")
            if ($actualComfyRef -ne $comfyRef) { throw "Pinned ComfyUI checkout digest mismatch." }
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "mv", "--", $temporaryComfy, $ComfyRoot)
        } catch {
            try { $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "rm", "-rf", "--", $temporaryComfy) } catch { }
            throw
        }
        $comfyState = $comfyRef
    }
    if ($comfyState -eq "conflict") { throw "ComfyRoot exists but is not a Git checkout of ComfyUI; setup will not overwrite it." }
    if ($comfyState -ne $comfyRef) { throw "ComfyUI must be checked out at pinned commit $comfyRef." }
    $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "mkdir", "-p", "$ComfyRoot/custom_nodes", "$ComfyRoot/input", "$ComfyRoot/output")
    if ($InstallDependencies) {
        $venvState = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc",
            "if test -x '$ComfyPython'; then echo ready; elif test -e '$ComfyPython'; then echo conflict; else echo missing; fi")
        if ($venvState -eq "conflict") { throw "ComfyPython exists but is not executable; setup will not replace it." }
        if ($venvState -eq "missing") {
            if (-not $InstallComfyUI) { throw "ComfyPython is missing. Use the Python 3.12 virtual environment that launches this ComfyUI." }
            $venvDirectoryState = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc",
                "if test -e '$ComfyRoot/.venv'; then echo present; else echo missing; fi")
            if ($venvDirectoryState -ne "missing") { throw "ComfyUI's .venv folder exists but has no worker Python; inspect or remove it manually before retrying." }
            $pythonVersion = Invoke-Wsl @("--distribution", $Distro, "--exec", "python3.12", "--version")
            if ($pythonVersion -notmatch "^Python 3\.12\.") { throw "Python 3.12 is required for the pinned ComfyUI runtime." }
            try { $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "python3.12", "-m", "venv", "$ComfyRoot/.venv") }
            catch { throw "Could not create the ComfyUI virtual environment. Install python3.12-venv in WSL and retry." }
        }
        $pythonStatus = Invoke-Wsl @("--distribution", $Distro, "--exec", $ComfyPython, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}|{int(sys.prefix != sys.base_prefix)}')")
        if ($pythonStatus -notmatch "^3\.12\|1$") { throw "ComfyPython must be a Python 3.12 virtual environment; found $pythonStatus." }
    }
    $clipProjTarget = "$ComfyRoot/custom_nodes/ComfyUI-ClipProj"
    $clipProjState = "not-required"
    if ($Role -eq "generation") {
        $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "--version")
        $clipProjState = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc",
            "if test -d '$clipProjTarget/.git'; then git -C '$clipProjTarget' rev-parse HEAD; elif test -e '$clipProjTarget'; then echo conflict; else echo missing; fi")
        if ($clipProjState -eq "conflict") { throw "ComfyUI-ClipProj exists but is not a Git checkout; setup will not overwrite it." }
    }
    $manifestFiles = @($manifest.files.PSObject.Properties)
    $expectedNames = @($manifestFiles | ForEach-Object { $_.Name }) + "worker-manifest.json"
    $actualNames = @(Get-ChildItem -LiteralPath $runtimeExtract -Recurse -File -Force | ForEach-Object {
        $_.FullName.Substring($runtimeExtract.Length).TrimStart([char]92, [char]47).Replace("\", "/")
    })
    if ((Compare-Object ($expectedNames | Sort-Object) ($actualNames | Sort-Object))) { throw "Runtime archive file set does not match its manifest." }
    foreach ($entry in $manifestFiles) {
        if ($entry.Value.sha256 -notmatch "^[0-9a-f]{64}$") { throw "Runtime manifest has an invalid file digest." }
        $relative = $entry.Name.Replace("/", "\")
        $path = Join-Path $runtimeExtract $relative
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value.sha256) {
            throw "Runtime source digest mismatch: $($entry.Name)"
        }
    }
    $clipProjRef = [string]$manifest.runtime.clipproj_node_ref
    if ($Role -eq "generation" -and $clipProjRef -notmatch "^[0-9a-f]{40}$") { throw "Runtime manifest has an invalid ClipProj pin." }

    $nodeNames = if ($Role -eq "generation") {
        @("fasth3_deploy", "comfystream_drama3", "comfystream_worker_identity")
    } else {
        @("comfystream_sol_refiner_h3", "comfystream_worker_identity")
    }
    $sourceNodeRoot = Join-Path $runtimeExtract "deploy/custom_nodes"
    $customNodesWindows = Join-Path (($ComfyRoot.Replace("/", "\"))) "custom_nodes"
    foreach ($name in $nodeNames) {
        $source = Join-Path $sourceNodeRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Pinned node source is missing: $name" }
        $target = Join-Path $customNodesWindows $name
        if ((Test-Path -LiteralPath $target) -and -not (Test-IdenticalTree $source $target)) {
            throw "ComfyUI custom node $name already exists with different files; back it up and resolve it manually."
        }
    }

    $runtimeTargetWindows = Join-Path (($ComfyRoot.Replace("/", "\"))) ".sloptogether-runtime"
    if ((Test-Path -LiteralPath $runtimeTargetWindows) -and -not (Test-IdenticalTree $runtimeExtract $runtimeTargetWindows)) {
        throw "Existing .sloptogether-runtime differs from this bundle; setup will not overwrite it."
    }
    $clipTargetHead = if ($Role -ne "generation" -or $clipProjState -eq "missing") { $null } else { $clipProjState }
    if ($Role -eq "generation" -and $clipTargetHead -and $clipTargetHead -ne $clipProjRef) { throw "Existing ComfyUI-ClipProj checkout is not the pinned commit $clipProjRef." }
    if ($Role -eq "generation" -and -not $clipTargetHead) {
        $temporaryClone = "$ComfyRoot/custom_nodes/.ComfyUI-ClipProj-$([Guid]::NewGuid().ToString('N'))"
        try {
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "clone", "--no-checkout", "--filter=blob:none",
                "https://github.com/nicolab28/ComfyUI-ClipProj.git", $temporaryClone)
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "-C", $temporaryClone, "fetch", "--depth", "1", "origin", $clipProjRef)
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "-C", $temporaryClone, "checkout", "--detach", $clipProjRef)
            $actualRef = Invoke-Wsl @("--distribution", $Distro, "--exec", "git", "-C", $temporaryClone, "rev-parse", "HEAD")
            if ($actualRef -ne $clipProjRef) { throw "ComfyUI-ClipProj checkout digest mismatch." }
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "mv", "--", $temporaryClone, $clipProjTarget)
        } catch {
            try { $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "rm", "-rf", "--", $temporaryClone) } catch { }
            throw
        }
    }

    if (-not (Test-Path -LiteralPath $runtimeTargetWindows)) { Copy-Item -LiteralPath $runtimeExtract -Destination $runtimeTargetWindows -Recurse }
    New-Item -ItemType Directory -Path $customNodesWindows -Force | Out-Null
    foreach ($name in $nodeNames) {
        $source = Join-Path $sourceNodeRoot $name
        $target = Join-Path $customNodesWindows $name
        if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $source -Destination $target -Recurse }
    }
    if ($InstallDependencies) {
        $pythonVersion = Invoke-Wsl @("--distribution", $Distro, "--exec", $ComfyPython, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        if ($pythonVersion -ne "3.12") { throw "Pinned Comfy dependencies require Python 3.12; ComfyPython reports $pythonVersion." }
        $lockPath = "$ComfyRoot/.sloptogether-runtime/deploy/vast/requirements.lock"
        $null = Invoke-Wsl @("--distribution", $Distro, "--exec", $ComfyPython, "-m", "pip", "install", "--require-hashes", "-r", $lockPath)
        if ($Role -eq "upscale") {
            $solInstaller = "$ComfyRoot/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh"
            $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "env", "PYTHON_BIN=$ComfyPython", "bash", $solInstaller)
        }
    }
    if ($DownloadModels) {
        $hasHfToken = Invoke-Wsl @("--distribution", $Distro, "--exec", $ComfyPython, "-c", "from huggingface_hub import get_token; print('yes' if get_token() else 'no')")
        if ($hasHfToken -ne "yes") { throw "Log in to Hugging Face inside WSL, accept required model access, then retry -DownloadModels." }
        $modelScript = "$ComfyRoot/.sloptogether-runtime/scripts/download_fasth3_models.sh"
        $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "env",
            "COMFYUI_ROOT=$ComfyRoot", "COMFYSTREAM_ROOT=$ComfyRoot/.sloptogether-runtime",
            "HF_REVISION_FASTVIDEO=$FastVideoRevision", "PYTHON_BIN=$ComfyPython", "FASTH3_TRIM_ONLY=1",
            "bash", $modelScript)
    }
    if ($Role -eq "generation") { Write-Host "Installed pinned generation nodes and ClipProj $clipProjRef." }
    else { Write-Host "Installed pinned SoL upscale node source." }
    Write-Host "Pinned Python requirements and model download instructions are in .sloptogether-runtime/deploy/vast/README.md."
    if (-not $InstallDependencies) { Write-Host "Use -InstallDependencies -ComfyPython <ComfyUI Python> to install the hash-locked runtime." }
    Write-Host "Dependency lock: $ComfyRoot/.sloptogether-runtime/deploy/vast/requirements.lock"
} finally {
    Remove-Item -LiteralPath $runtimeExtract -Recurse -Force -ErrorAction SilentlyContinue
}
