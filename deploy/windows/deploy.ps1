[CmdletBinding()]
param(
  [ValidateSet("local", "production")][string] $Mode = "local",
  [string] $PublicOrigin = "",
  [ValidateRange(1, 65535)][int] $HttpPort = 8080,
  [ValidatePattern("^[A-Za-z0-9._-]+$")][string] $AdminUsername = "super.admin",
  [ValidateLength(1, 100)][ValidatePattern("^[^\r\n=]+$")][string] $AdminName = "ForgeX Administrator"
)

. (Join-Path $PSScriptRoot "common.ps1")

if ($Mode -eq "production") {
  $origin = $null
  if (-not [Uri]::TryCreate($PublicOrigin, [UriKind]::Absolute, [ref] $origin) -or
    $origin.Scheme -ne "https" -or
    $origin.PathAndQuery -ne "/" -or
    $origin.Fragment -or
    $origin.UserInfo) {
    throw "Production mode requires a path-free HTTPS -PublicOrigin, for example https://forgex.example.com."
  }
} elseif ($PublicOrigin) {
  throw "Local mode does not accept -PublicOrigin. It uses the loopback browser origin."
}

Assert-DockerReady

$environmentExists = Test-ForgeXRegularFile -Path $script:EnvironmentFile
$configExists = Test-ForgeXRegularFile -Path $script:RuntimeConfigFile
if ($environmentExists -xor $configExists) {
  throw "deploy/.env and deploy/config/control-plane.json must either both exist or both be absent."
}

$bootstrapPassword = $null
if (-not $environmentExists) {
  Copy-Item -LiteralPath $script:EnvironmentExampleFile -Destination $script:EnvironmentFile
  $databasePassword = Get-RandomHex -ByteCount 32
  $bootstrapPassword = Get-RandomHex -ByteCount 24
  Set-ForgeXEnvValue -Name "FORGEX_POSTGRES_PASSWORD" -Value $databasePassword
  Set-ForgeXEnvValue -Name "FORGEX_DATABASE_URL" -Value "postgresql://forgex:$databasePassword@postgres:5432/forgex"
  Set-ForgeXEnvValue -Name "FORGEX_BOOTSTRAP_ADMIN_USERNAME" -Value $AdminUsername
  Set-ForgeXEnvValue -Name "FORGEX_BOOTSTRAP_ADMIN_NAME" -Value $AdminName
  Set-ForgeXEnvValue -Name "FORGEX_BOOTSTRAP_ADMIN_PASSWORD" -Value $bootstrapPassword
  Set-ForgeXEnvValue -Name "FORGEX_HTTP_PORT" -Value $HttpPort.ToString()

  $templateName = if ($Mode -eq "production") {
    "control-plane.production.example.json"
  } else {
    "control-plane.example.json"
  }
  $templatePath = Join-Path $script:DeployDirectory "config\$templateName"
  $config = Get-Content -Raw -LiteralPath $templatePath -Encoding UTF8 | ConvertFrom-Json
  $config.publicOrigin = if ($Mode -eq "production") { $PublicOrigin.TrimEnd("/") } else { "http://localhost:$HttpPort" }
  $config.sessionCookieSecure = $Mode -eq "production"
  $config.projectKey = [Guid]::NewGuid().ToString()
  $config.repositoryKey = [Guid]::NewGuid().ToString()
  $config.sessions[0].principal.actorKey = [Guid]::NewGuid().ToString()
  $config.sessions[0].principal.tenantKey = [Guid]::NewGuid().ToString()
  $config.sessions[0].principal.actorName = $AdminName
  $config.sessions[0].principal.username = $AdminUsername
  $json = $config | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($script:RuntimeConfigFile, "$json`n", [Text.UTF8Encoding]::new($false))

  $configHash = (Get-FileHash -LiteralPath $script:RuntimeConfigFile -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-ForgeXEnvValue -Name "FORGEX_CONTROL_PLANE_CONFIG_SHA256" -Value $configHash
  Protect-ForgeXPrivateFile -Path $script:EnvironmentFile
  Protect-ForgeXPrivateFile -Path $script:RuntimeConfigFile
} else {
  Write-Host "Existing deployment configuration found; preserving secrets, identifiers, and public origin." -ForegroundColor Yellow
}

Assert-ForgeXConfiguration
Invoke-ForgeXCompose @("config", "--quiet")
Invoke-ForgeXCompose @("up", "--build", "-d")
$port = [int](Get-ForgeXEnvValue -Name "FORGEX_HTTP_PORT")
Wait-ForgeXHealth -Port $port

if ($bootstrapPassword) {
  Write-Host "Initial administrator: $AdminUsername" -ForegroundColor Cyan
  Write-Host "Initial password: $bootstrapPassword" -ForegroundColor Cyan
  Write-Warning "Save this password, sign in, and change it immediately. After bootstrap, clear FORGEX_BOOTSTRAP_ADMIN_PASSWORD in deploy/.env."
}
Write-Host "ForgeX deployment completed: http://localhost:$port" -ForegroundColor Green
$configuredOrigin = (Get-Content -Raw -LiteralPath $script:RuntimeConfigFile -Encoding UTF8 | ConvertFrom-Json).publicOrigin
Write-Host "Configured browser origin: $configuredOrigin" -ForegroundColor Green
