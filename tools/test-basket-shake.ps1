$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class BasketShakeTestInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public static void MoveRelative(int dx, int dy) {
    mouse_event(MOUSEEVENTF_MOVE, unchecked((uint)dx), unchecked((uint)dy), 0, UIntPtr.Zero);
  }
}
"@

$helperPath = Join-Path $PSScriptRoot '..\apps\desktop\resources\win32-helper.ps1'
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

  $process.StandardInput.WriteLine('{"id":1,"cmd":"shake-selftest"}')
  $process.StandardInput.Flush()
  $response = $process.StandardOutput.ReadLine() | ConvertFrom-Json

  if (-not $response.ok) {
    throw "shake self-test failed: $($response | ConvertTo-Json -Compress)"
  }

  $process.StandardInput.WriteLine('{"id":2,"cmd":"shake-start"}')
  $process.StandardInput.Flush()
  $start = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if (-not $start.ok) {
    throw "mouse hook did not start: $($start | ConvertTo-Json -Compress)"
  }

  $originalCursor = New-Object BasketShakeTestInput+POINT
  [BasketShakeTestInput]::GetCursorPos([ref]$originalCursor) | Out-Null
  try {
    [BasketShakeTestInput]::SetCursorPos(900, 100) | Out-Null
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    foreach ($dx in @(6, -10, 10, -10, 10)) {
      Start-Sleep -Milliseconds 55
      [BasketShakeTestInput]::MoveRelative($dx, 0)
    }
    Start-Sleep -Milliseconds 55
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  } finally {
    [BasketShakeTestInput]::SetCursorPos($originalCursor.X, $originalCursor.Y) | Out-Null
  }

  $process.StandardInput.WriteLine('{"id":3,"cmd":"shake-take"}')
  $process.StandardInput.Flush()
  $take = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if (-not $take.ok) {
    throw "mouse hook did not respond: $($take | ConvertTo-Json -Compress)"
  }
  if (-not $take.detected) {
    throw "injected drag-shake did not pass through the Windows hook: $($take | ConvertTo-Json -Compress)"
  }

  Write-Output 'PASS: basket shake detector and Windows hook'
} finally {
  if (-not $process.HasExited) {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(2000)) {
      $process.Kill()
    }
  }
  $process.Dispose()
}
