# Builds ManStudioStore.exe (one file) into desktop\dist.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File "D:\my app\game-store\desktop\BUILD_EXE.ps1"
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

python -m pip install pywebview pillow pyinstaller -q --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

python make_icon.py
if ($LASTEXITCODE -ne 0) { throw "icon failed" }

python -m PyInstaller --noconfirm --clean --onefile --windowed `
  --name ManStudioStore --icon store.ico --add-data "store.ico;." `
  store_app.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed - the lines above say why" }

$exe = Join-Path $here "dist\ManStudioStore.exe"
# the site serves the download from game-store\downloads (commit + push to publish it)
$dl = Join-Path (Split-Path $here -Parent) "downloads"
New-Item -ItemType Directory -Force $dl | Out-Null
Copy-Item $exe (Join-Path $dl "ManStudioStore.exe") -Force
"{0}  ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB)
