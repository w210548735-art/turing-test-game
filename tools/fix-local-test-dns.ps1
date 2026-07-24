[CmdletBinding()]
param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$managedIp = "203.0.113.10"
$managedHost = "203-0-113-10.sslip.io"
$managedMarker = "turing-test-game-managed"
$managedLine = "$managedIp`t$managedHost`t# $managedMarker"
$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$administrator = [Security.Principal.WindowsBuiltInRole]::Administrator
if (-not $principal.IsInRole($administrator)) {
  throw "Administrator privileges are required."
}

if (-not (Test-Path -LiteralPath $hostsPath -PathType Leaf)) {
  throw "Windows hosts file was not found: $hostsPath"
}

$lines = [System.IO.File]::ReadAllLines($hostsPath)
$escapedHost = [Regex]::Escape($managedHost)
$escapedIp = [Regex]::Escape($managedIp)
$escapedMarker = [Regex]::Escape($managedMarker)
$hostPattern = "(?i)(^|\s)$escapedHost(\s|$)"
$managedPattern =
  "(?i)^\s*$escapedIp\s+$escapedHost\s+#\s*$escapedMarker\s*$"

$managedEntries = @($lines | Where-Object { $_ -match $managedPattern })
$conflictingEntries = @(
  $lines |
    Where-Object {
      $_ -match $hostPattern -and $_ -notmatch $managedPattern
    }
)

if (-not $Remove -and $conflictingEntries.Count -gt 0) {
  throw "An unmanaged hosts entry already exists for this hostname."
}

$updatedLines = @($lines | Where-Object { $_ -notmatch $managedPattern })
if (-not $Remove) {
  if ($updatedLines.Count -gt 0 -and $updatedLines[-1] -ne "") {
    $updatedLines += ""
  }
  $updatedLines += $managedLine
}

$contentChanged =
  $updatedLines.Count -ne $lines.Count -or
  (Compare-Object -ReferenceObject $lines -DifferenceObject $updatedLines)

if ($contentChanged) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$hostsPath.turing-test-game.$timestamp.bak"
  Copy-Item -LiteralPath $hostsPath -Destination $backupPath

  $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllLines(
    $hostsPath,
    [string[]]$updatedLines,
    $utf8WithoutBom
  )

  Write-Output "HOSTS_BACKUP=$backupPath"
}
else {
  Write-Output "HOSTS_ALREADY_DESIRED_STATE=true"
}

Clear-DnsClientCache

if ($Remove) {
  Write-Output "DNS_OVERRIDE_REMOVED=true"
  exit 0
}

$resolvedAddresses = @(
  [System.Net.Dns]::GetHostAddresses($managedHost) |
    ForEach-Object { $_.IPAddressToString }
)
if ($managedIp -notin $resolvedAddresses) {
  throw "The hostname does not resolve to the managed IP after update."
}

Write-Output "DNS_OVERRIDE_APPLIED=true"
Write-Output "HOST=$managedHost"
Write-Output "IP=$managedIp"
