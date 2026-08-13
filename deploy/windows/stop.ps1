. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady
Assert-ForgeXConfiguration
Invoke-ForgeXCompose @("stop")
Write-Host "ForgeX stopped. The PostgreSQL volume was preserved." -ForegroundColor Green
