$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:DeployDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:EnvironmentFile = Join-Path $script:DeployDirectory ".env"
$script:EnvironmentExampleFile = Join-Path $script:DeployDirectory ".env.example"
$script:ComposeFile = Join-Path $script:DeployDirectory "compose.yaml"
$script:RuntimeConfigFile = Join-Path $script:DeployDirectory "config\control-plane.json"

function Assert-DockerReady {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker was not found. Install and start Docker Desktop first."
  }

  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose v2 is unavailable. Update Docker Desktop first."
  }

  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Engine is not running. Start Docker Desktop first."
  }
}

function Assert-ForgeXConfiguration {
  foreach ($path in @($script:EnvironmentFile, $script:RuntimeConfigFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Deployment file is missing: $path. Run deploy.cmd first."
    }
  }

  $expectedHash = Get-ForgeXEnvValue -Name "FORGEX_CONTROL_PLANE_CONFIG_SHA256"
  $actualHash = (Get-FileHash -LiteralPath $script:RuntimeConfigFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $expectedHash -or $expectedHash -ne $actualHash) {
    throw "control-plane.json does not match FORGEX_CONTROL_PLANE_CONFIG_SHA256."
  }
}

function Invoke-ForgeXCompose {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

  $prefix = @("-p", "forgex", "--env-file", $script:EnvironmentFile, "-f", $script:ComposeFile)
  & docker compose @prefix @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE."
  }
}

function Get-ForgeXEnvValue {
  param([Parameter(Mandatory = $true)][string] $Name)

  if (-not (Test-Path -LiteralPath $script:EnvironmentFile)) { return $null }
  $prefix = "$Name="
  foreach ($line in [IO.File]::ReadAllLines($script:EnvironmentFile)) {
    if ($line.StartsWith($prefix, [StringComparison]::Ordinal)) {
      return $line.Substring($prefix.Length)
    }
  }
  return $null
}

function Set-ForgeXEnvValue {
  param(
    [Parameter(Mandatory = $true)][string] $Name,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value
  )

  $lines = [Collections.Generic.List[string]]::new()
  $updated = $false
  foreach ($line in [IO.File]::ReadAllLines($script:EnvironmentFile)) {
    if ($line.StartsWith("$Name=", [StringComparison]::Ordinal)) {
      $lines.Add("$Name=$Value")
      $updated = $true
    } else {
      $lines.Add($line)
    }
  }
  if (-not $updated) { $lines.Add("$Name=$Value") }
  [IO.File]::WriteAllLines(
    $script:EnvironmentFile,
    $lines,
    [Text.UTF8Encoding]::new($false)
  )
}

function Get-RandomHex {
  param([ValidateRange(1, 1024)][int] $ByteCount)

  $bytes = [byte[]]::new($ByteCount)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return ([BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
}

function Protect-ForgeXPrivateFile {
  param([Parameter(Mandatory = $true)][string] $Path)

  if (-not (Get-Command icacls.exe -ErrorAction SilentlyContinue)) { return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*$($sid):(F)" *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not restrict the ACL for $Path. Limit it to the deployment account manually."
  }
}

function Wait-ForgeXHealth {
  param(
    [Parameter(Mandatory = $true)][int] $Port,
    [ValidateRange(1, 600)][int] $TimeoutSeconds = 120
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $healthUrl = "http://127.0.0.1:$Port/healthz"
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq "ok") {
        Write-Host "ForgeX is ready: $healthUrl" -ForegroundColor Green
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }

  & docker compose -p forgex --env-file $script:EnvironmentFile -f $script:ComposeFile ps
  throw "ForgeX did not become healthy within $TimeoutSeconds seconds. Review the container status above."
}
