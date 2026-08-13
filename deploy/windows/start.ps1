. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady
Assert-ForgeXConfiguration
Invoke-ForgeXCompose @("up", "-d")
$port = Get-ForgeXPublishedWebPort
Wait-ForgeXHealth -Port $port
