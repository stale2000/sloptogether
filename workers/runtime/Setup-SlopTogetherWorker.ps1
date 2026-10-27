[CmdletBinding()]
param(
    [ValidateSet("generation", "upscale")]
    [string]$Role = "generation",
    [ValidatePattern("^[A-Za-z0-9._-]+$")]
    [string]$Distro = "Ubuntu-24.04",
    [string]$ComfyRoot,
    [switch]$InstallWsl,
    [switch]$InstallComfyUI,
    [switch]$InstallNodes,
    [switch]$InstallDependencies,
    [switch]$DownloadModels,
    [string]$FastVideoRevision,
    [string]$ComfyPython,
    [switch]$Check,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
if ($InstallComfyUI) {
    $InstallDependencies = $true
    $InstallNodes = $true
    if (-not $ComfyPython -and $ComfyRoot) { $ComfyPython = "$ComfyRoot/.venv/bin/python" }
}
if ($DownloadModels) {
    if ($Role -ne "generation") { throw "FastH3 model downloads apply only to the generation role." }
    if ($FastVideoRevision -notmatch "^[0-9a-fA-F]{40}$") { throw "Pass a reviewed 40-character FastVideo model revision." }
    $InstallNodes = $true
    $InstallDependencies = $true
}
if ($InstallDependencies) { $InstallNodes = $true }

if ($env:OS -ne "Windows_NT") { throw "Run this setup script from Windows PowerShell." }
$Wsl = Join-Path $env:WINDIR "System32\wsl.exe"
$Executable = Join-Path $PSScriptRoot "SlopTogetherWorker.exe"
$Template = Join-Path $PSScriptRoot "worker.wsl.example.toml"
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "SlopTogetherWorker.exe is missing from this folder." }
if (-not (Test-Path -LiteralPath $Template -PathType Leaf)) { throw "worker.wsl.example.toml is missing from this folder." }

function Start-WslInstall {
    if (-not $InstallWsl) {
        throw "WSL is not installed. Rerun with -InstallWsl from an Administrator PowerShell, then finish the Linux user setup and rerun this script."
    }
    if (-not (Test-Path -LiteralPath $Wsl -PathType Leaf)) { throw "wsl.exe is missing. Update Windows and enable the WSL optional feature before continuing." }
    Start-Process -FilePath $Wsl -ArgumentList @("--install", "--distribution", $Distro) -Verb RunAs -Wait
    Write-Host "Finish the WSL distribution setup (and reboot if Windows requests it), then rerun this script."
}

if (-not (Test-Path -LiteralPath $Wsl -PathType Leaf)) { Start-WslInstall; return }
$rawDistros = & $Wsl --list --quiet 2>$null
if ($LASTEXITCODE -ne 0) { Start-WslInstall; return }
$installedDistros = @($rawDistros | ForEach-Object { ($_ -replace "\x00", "").Trim() } | Where-Object { $_ })
if ($installedDistros -notcontains $Distro) { Start-WslInstall; return }

function Invoke-Wsl([string[]]$Arguments) {
    $output = & $Wsl @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($output -join ' ')" }
    return ($output -join "`n").Trim()
}

$kernel = Invoke-Wsl @("--distribution", $Distro, "--exec", "uname", "-r")
if ($kernel -notmatch "WSL2") { throw "The selected distribution is not running a WSL2 kernel. Run: wsl --set-version $Distro 2" }
$linuxUser = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc", "id -un")
if ($linuxUser -notmatch "^[a-z_][a-z0-9_-]*[$]?$") { throw "The WSL distribution returned an invalid Linux username." }
if (-not $ComfyRoot) { $ComfyRoot = "/home/$linuxUser/ComfyUI" }
if ($InstallComfyUI -and -not $ComfyPython) { $ComfyPython = "$ComfyRoot/.venv/bin/python" }
if ($ComfyRoot -notmatch "^/home/[A-Za-z0-9._/-]+$" -or $ComfyRoot.Contains("..")) {
    throw "ComfyRoot must be an absolute path below /home containing only letters, digits, dots, underscores, dashes, and slashes."
}
$gpuRows = Invoke-Wsl @("--distribution", $Distro, "--exec", "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits")
$qualifiedGpu = @($gpuRows -split "`n" | Where-Object {
    $parts = $_ -split ","
    $memory = 0
    $parts.Count -ge 2 -and [int]::TryParse($parts[1].Trim(), [ref]$memory) -and $memory -ge 24000
})
if (-not $qualifiedGpu.Count) { throw "No WSL-visible GPU with at least 24,000 MiB VRAM was found. Check the Windows NVIDIA driver and WSL GPU support." }
if ($Role -eq "upscale") {
    $ramBytes = (Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory
    if ($ramBytes -lt 128GB) { throw "The current upscale profile requires at least 128 GiB system RAM; this PC reports $([math]::Round($ramBytes / 1GB)) GiB." }
    $wslRamKbText = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc", "awk '/^MemTotal:/ {print `$2}' /proc/meminfo")
    $wslRamKb = 0L
    if (-not [long]::TryParse($wslRamKbText.Trim(), [ref]$wslRamKb) -or $wslRamKb -lt (128 * 1024 * 1024)) {
        throw "WSL is capped below the 128 GiB required by the current upscale profile. Review %UserProfile%\.wslconfig and restart WSL."
    }
}

if ($InstallNodes) {
    $nodeInstaller=Join-Path $PSScriptRoot "Install-ComfyStreamerNodes.ps1"
    if (-not (Test-Path -LiteralPath $nodeInstaller -PathType Leaf)) { throw "Install-ComfyStreamerNodes.ps1 is missing from this bundle." }
    $installerArgs=@{Distro=$Distro;ComfyRoot=$ComfyRoot;Role=$Role;InstallComfyUI=$InstallComfyUI;InstallDependencies=$InstallDependencies;DownloadModels=$DownloadModels;FastVideoRevision=$FastVideoRevision}
    if ($ComfyPython) { $installerArgs.ComfyPython=$ComfyPython }
    & $nodeInstaller @installerArgs
} elseif ($InstallComfyUI) {
    throw "-InstallComfyUI requires the pinned node bundle."
} else {
    $null = Invoke-Wsl @("--distribution", $Distro, "--exec", "bash", "-lc", "test -f '$ComfyRoot/main.py' && mkdir -p '$ComfyRoot/input' '$ComfyRoot/output'")
}

$comfyRootWindows = $ComfyRoot.Replace("/", "\")
$inputPath = "\\wsl.localhost\$Distro$comfyRootWindows\input"
$outputPath = "\\wsl.localhost\$Distro$comfyRootWindows\output"
if (-not (Test-Path -LiteralPath $inputPath -PathType Container) -or -not (Test-Path -LiteralPath $outputPath -PathType Container)) {
    $inputPath = "\\wsl$\$Distro$comfyRootWindows\input"
    $outputPath = "\\wsl$\$Distro$comfyRootWindows\output"
}
if (-not (Test-Path -LiteralPath $inputPath -PathType Container) -or -not (Test-Path -LiteralPath $outputPath -PathType Container)) {
    throw "Windows cannot access the ComfyUI input/output folders in WSL. Verify the distro is running and the paths exist."
}
$config = Get-Content -LiteralPath $Template -Raw -Encoding UTF8
$config = [regex]::Replace($config, '(?m)^role = "generation"$', "role = `"$Role`"")
$config = [regex]::Replace($config, '(?m)^comfy_input_dir = .+$', "comfy_input_dir = '$inputPath'")
$config = [regex]::Replace($config, '(?m)^comfy_output_dir = .+$', "comfy_output_dir = '$outputPath'")
if ($config -notmatch 'platform = "wsl"' -or $config -notmatch "role = `"$Role`"" -or $config -match "YOUR_USER") {
    throw "The WSL worker template could not be configured safely."
}
$configPath = Join-Path $PSScriptRoot "worker.$Role.toml"
if ((Test-Path -LiteralPath $configPath) -and -not $Force) { throw "$([IO.Path]::GetFileName($configPath)) already exists; use -Force to replace this nonsecret configuration." }
[IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))

Write-Host "WSL2 GPU detected: $($qualifiedGpu[0])"
Write-Host "Created $configPath"
Write-Host "Next, run: .\SlopTogetherWorker.exe --config .\worker.$Role.toml check"
Write-Host "Then pair the worker with Twitch: .\SlopTogetherWorker.exe --config .\worker.$Role.toml pair"
if (-not $InstallNodes) { Write-Host "Run setup with -InstallNodes to add the pinned ComfyStreamer node source and ClipProj revision." }
if ($InstallNodes -and -not $InstallDependencies) { Write-Host "Use -InstallDependencies -ComfyPython <ComfyUI Python> to install the hash-locked runtime." }
if ($InstallNodes -and -not $DownloadModels -and $Role -eq "generation") {
    Write-Host "Model weights are not bundled; use -DownloadModels -FastVideoRevision <reviewed 40-character commit> after accepting model access and logging in within WSL."
}
if ($DownloadModels) { Write-Host "Trim model files were hash-verified; no video generation job was started." }
Write-Host "Pinned runtime and model instructions: .sloptogether-runtime/deploy/vast/README.md"
Write-Host "Setup never pairs a Twitch account or starts a GPU job."
if ($Check) {
    & $Executable --config $configPath check
    if ($LASTEXITCODE -ne 0) { throw "Worker check failed; no pairing or GPU job was started." }
}
