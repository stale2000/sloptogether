$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = $env:SLOPTOGETHER_PYTHON
if (-not $Python) {
    $Python = "py"
}

Push-Location $Root
try {
    if (Test-Path .venv-build) {
        $BuildEnvironment = Get-Item -Force .venv-build
        if ($BuildEnvironment.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Build environment cannot be a reparse point." }
        Remove-Item -Recurse -Force .venv-build
    }
    if ($Python -eq "py") {
        & py -3.12 -m venv .venv-build
        if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed." }
    } else {
        & $Python -m venv .venv-build
        if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed." }
    }
    $VenvPython = Join-Path $Root ".venv-build/Scripts/python.exe"
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "Build environment update failed." }
    & $VenvPython -m pip install -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) { throw "Build dependencies installation failed." }
    & $VenvPython -m pip install --no-deps .
    if ($LASTEXITCODE -ne 0) { throw "Worker package installation failed." }
    & $VenvPython -m PyInstaller --clean --onefile --console --name SlopTogetherWorkerCli `
        --collect-all sloptogether_worker `
        launcher.py
    if ($LASTEXITCODE -ne 0) { throw "Windows worker CLI packaging failed." }
    & $VenvPython -m PyInstaller --clean --onefile --windowed --name SlopTogetherWorker `
        --collect-all sloptogether_worker `
        launcher.py
    if ($LASTEXITCODE -ne 0) { throw "Windows worker packaging failed." }
    Copy-Item worker.example.toml dist/worker.example.toml -Force
    Copy-Item worker.wsl.example.toml dist/worker.wsl.example.toml -Force
    Copy-Item Setup-SlopTogetherWorker.ps1 dist/Setup-SlopTogetherWorker.ps1 -Force
    Copy-Item Install-ComfyStreamerNodes.ps1 dist/Install-ComfyStreamerNodes.ps1 -Force
    Copy-Item README.md dist/README.txt -Force
    & $VenvPython package_comfy_wsl_runtime.py --output (Join-Path $Root "dist/ComfyStreamer-Wsl-runtime.zip")
    if ($LASTEXITCODE -ne 0) { throw "Pinned ComfyStreamer WSL runtime packaging failed." }
    & $VenvPython package_worker_bundle.py --root $Root
    if ($LASTEXITCODE -ne 0) { throw "Windows worker bundle creation failed." }
    Write-Output "Worker executable: $Root/dist/SlopTogetherWorker.exe"
} finally {
    Pop-Location
}
