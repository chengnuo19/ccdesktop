$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

$helperPath = Join-Path $PSScriptRoot '..\apps\desktop\resources\win32-helper.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "xfb-basket-copy-$([guid]::NewGuid().ToString('N'))"
$testFile = Join-Path $testRoot '复制测试.txt'
[System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
[System.IO.File]::WriteAllText($testFile, 'basket copy test', [System.Text.Encoding]::UTF8)

$clipboardBackup = [System.Windows.Forms.Clipboard]::GetDataObject()
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = 'powershell.exe'
$startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helperPath`""
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$null = $process.Start()

try {
  $ready = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if ($ready.type -ne 'helper-ready') {
    throw "helper did not become ready: $($ready | ConvertTo-Json -Compress)"
  }

  $encodedPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($testFile))
  $request = @{ id = 1; cmd = 'clipboard-files'; paths = @($encodedPath) } | ConvertTo-Json -Compress
  $process.StandardInput.WriteLine($request)
  $process.StandardInput.Flush()
  $response = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if (-not $response.ok) {
    throw "file copy command failed: $($response | ConvertTo-Json -Compress)"
  }

  $copied = [System.Windows.Forms.Clipboard]::GetFileDropList()
  if ($copied.Count -ne 1 -or $copied[0] -ne $testFile) {
    throw "clipboard did not contain the expected file: $($copied -join ', ')"
  }

  $missing = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Join-Path $testRoot 'missing.txt')))
  $invalidRequest = @{ id = 2; cmd = 'clipboard-files'; paths = @($missing) } | ConvertTo-Json -Compress
  $process.StandardInput.WriteLine($invalidRequest)
  $process.StandardInput.Flush()
  $invalidResponse = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if ($invalidResponse.ok) {
    throw 'missing file was unexpectedly copied'
  }

  Write-Output 'PASS: basket file copy uses the Windows file-drop clipboard format'
} finally {
  if ($null -ne $clipboardBackup) {
    [System.Windows.Forms.Clipboard]::SetDataObject($clipboardBackup, $true)
  } else {
    [System.Windows.Forms.Clipboard]::Clear()
  }
  if (-not $process.HasExited) {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(2000)) { $process.Kill() }
  }
  $process.Dispose()
  if ([System.IO.Directory]::Exists($testRoot)) {
    [System.IO.Directory]::Delete($testRoot, $true)
  }
}
