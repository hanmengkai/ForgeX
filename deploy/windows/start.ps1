. (Join-Path $PSScriptRoot "common.ps1")

Assert-DockerReady
Assert-ForgeXConfiguration
Invoke-ForgeXCompose @("up", "-d")
$port = [int](Get-ForgeXEnvValue -Name "FORGEX_HTTP_PORT")
Wait-ForgeXHealth -Port $port
