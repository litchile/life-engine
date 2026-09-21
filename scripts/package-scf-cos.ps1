$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot ".scf-cos-build"
$esbuild = Join-Path $projectRoot "node_modules\@esbuild\win32-x64\esbuild.exe"

if (Test-Path -LiteralPath $buildRoot) {
  Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $buildRoot | Out-Null
Push-Location $projectRoot

try {
  foreach ($target in @("ingress", "processor")) {
    $targetDir = Join-Path $buildRoot $target
    New-Item -ItemType Directory -Path $targetDir | Out-Null
    $entryFile = Join-Path $projectRoot "scf-runtime\$target\index.js"
    $outFile = Join-Path $targetDir "index.js"
    & $esbuild $entryFile --bundle --platform=node --target=node18 --format=cjs "--outfile=$outFile"
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed for $target" }
    Set-Content -LiteralPath (Join-Path $targetDir "package.json") -Encoding utf8 -Value '{"name":"agent-scf-runtime","private":true,"version":"0.1.0"}'
    $zipPath = Join-Path $projectRoot "scf-$target.zip"
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $targetDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  }
} finally {
  Pop-Location
}

Write-Output "Created scf-ingress.zip and scf-processor.zip"
