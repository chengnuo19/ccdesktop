<#
  悬浮标 —— Windows 能力层助手。

  由 Electron 主进程以子进程方式常驻启动，通过 stdin/stdout 的 JSON 行协议通信。
  之所以不用原生 Node 模块：node-gyp 在 Windows 上的编译链太脆，
  而这里需要的全部能力（窗口定位、焦点切换、模拟按键、UIA 树查询）
  用 P/Invoke + UIAutomationClient 都能拿到，且零编译依赖。

  协议：每行一个 JSON 请求，每行一个 JSON 响应，靠 id 对应。
  中文文本一律用 base64 传输，避免任何一层的编码问题。
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$nativeSource = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

public class Xfb {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  // 剪贴板内容每变一次，这个序号就自增。读它不需要打开剪贴板，是零成本的，
  // 因此可以高频轮询——这是判断「剪贴板变没变」唯一划算的办法。
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowsHookEx(int hookId, LowLevelMouseProc callback, IntPtr module, uint threadId);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string moduleName);
  public delegate IntPtr LowLevelMouseProc(int code, IntPtr message, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Point; public uint MouseData, Flags, Time; public UIntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public POINT Point; public uint LPrivate; }

  public const int SW_RESTORE = 9;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_MENU = 0x12;
  public const byte VK_V = 0x56;
  public const byte VK_RETURN = 0x0D;
  public const int WH_MOUSE_LL = 14;
  public const int WM_MOUSEMOVE = 0x0200;
  public const int WM_LBUTTONDOWN = 0x0201;
  public const int WM_LBUTTONUP = 0x0202;
  public const uint WM_QUIT = 0x0012;

  // Tokri-style activation gesture: while the left button is held, three quick
  // horizontal direction changes reveal the basket. The thresholds mirror Tokri's
  // HorizontalShakeDetector (MIT): 8..100 px movements, at most 200 ms apart.
  private sealed class HorizontalShakeDetector {
    private int lastDirection;
    private int flips;
    private uint lastTime;

    public bool Feed(int dx, uint time) {
      int distance = Math.Abs(dx);
      if (distance < 8 || distance > 100 || dx == 0) return false;

      int direction = dx > 0 ? 1 : -1;
      if (lastDirection == 0 || unchecked(time - lastTime) > 200) {
        lastDirection = direction;
        flips = 0;
        lastTime = time;
        return false;
      }

      if (direction != lastDirection) {
        flips++;
        lastDirection = direction;
        lastTime = time;
        if (flips >= 3) {
          Reset();
          return true;
        }
      } else {
        lastTime = time;
      }
      return false;
    }

    public void Reset() {
      lastDirection = 0;
      flips = 0;
      lastTime = 0;
    }
  }

  private static readonly object ShakeLock = new object();
  private static readonly HorizontalShakeDetector ShakeDetector = new HorizontalShakeDetector();
  private static readonly LowLevelMouseProc ShakeCallback = ShakeMouseProc;
  private static Thread shakeThread;
  private static ManualResetEventSlim shakeReady;
  private static IntPtr shakeHook = IntPtr.Zero;
  private static uint shakeThreadId;
  private static bool leftButtonDown;
  private static int lastMouseX;
  private static int shakeSignal;
  private static int shakeHookEvents;
  private static int shakeDragMoves;
  private static int shakeQualifyingMoves;
  private static int shakeDirectionChanges;
  private static int shakeObservedDirection;
  private static int shakeLastDx;

  public static bool StartShakeWatcher() {
    lock (ShakeLock) {
      if (shakeThread != null && shakeThread.IsAlive) return shakeHook != IntPtr.Zero;
      shakeReady = new ManualResetEventSlim(false);
      shakeThread = new Thread(ShakeLoop) { IsBackground = true, Name = "XfbShakeWatcher" };
      shakeThread.Start();
    }
    shakeReady.Wait(2000);
    return shakeHook != IntPtr.Zero;
  }

  private static void ShakeLoop() {
    shakeThreadId = GetCurrentThreadId();
    shakeHook = SetWindowsHookEx(WH_MOUSE_LL, ShakeCallback, GetModuleHandle(null), 0);
    shakeReady.Set();
    if (shakeHook == IntPtr.Zero) return;

    MSG message;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
    UnhookWindowsHookEx(shakeHook);
    shakeHook = IntPtr.Zero;
  }

  private static IntPtr ShakeMouseProc(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      Interlocked.Increment(ref shakeHookEvents);
      int kind = message.ToInt32();
      if (kind == WM_LBUTTONDOWN) {
        leftButtonDown = true;
        lastMouseX = 0;
        shakeObservedDirection = 0;
        ShakeDetector.Reset();
      } else if (kind == WM_LBUTTONUP) {
        leftButtonDown = false;
        lastMouseX = 0;
        ShakeDetector.Reset();
      } else if (kind == WM_MOUSEMOVE && leftButtonDown) {
        Interlocked.Increment(ref shakeDragMoves);
        MSLLHOOKSTRUCT mouse = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(MSLLHOOKSTRUCT));
        int dx = lastMouseX == 0 ? 0 : mouse.Point.X - lastMouseX;
        lastMouseX = mouse.Point.X;
        shakeLastDx = dx;
        if (Math.Abs(dx) >= 8 && Math.Abs(dx) <= 100) {
          Interlocked.Increment(ref shakeQualifyingMoves);
          int direction = dx > 0 ? 1 : -1;
          if (shakeObservedDirection != 0 && direction != shakeObservedDirection) {
            Interlocked.Increment(ref shakeDirectionChanges);
          }
          shakeObservedDirection = direction;
        }
        if (dx != 0 && ShakeDetector.Feed(dx, mouse.Time)) {
          Interlocked.Exchange(ref shakeSignal, 1);
        }
      }
    }
    return CallNextHookEx(shakeHook, code, message, data);
  }

  public static bool ConsumeShake() {
    return Interlocked.Exchange(ref shakeSignal, 0) == 1;
  }

  public static int ShakeHookEvents { get { return Volatile.Read(ref shakeHookEvents); } }
  public static int ShakeDragMoves { get { return Volatile.Read(ref shakeDragMoves); } }
  public static int ShakeQualifyingMoves { get { return Volatile.Read(ref shakeQualifyingMoves); } }
  public static int ShakeDirectionChanges { get { return Volatile.Read(ref shakeDirectionChanges); } }
  public static int ShakeLastDx { get { return Volatile.Read(ref shakeLastDx); } }

  public static void StopShakeWatcher() {
    uint threadId = shakeThreadId;
    if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
  }

  public static bool ShakeSelfTest() {
    HorizontalShakeDetector detector = new HorizontalShakeDetector();
    bool tooSlow = detector.Feed(20, 100) || detector.Feed(-20, 400);
    detector.Reset();
    bool jitter = detector.Feed(4, 100) || detector.Feed(-4, 140) || detector.Feed(4, 180) || detector.Feed(-4, 220);
    detector.Reset();
    bool detected = detector.Feed(20, 100) || detector.Feed(-20, 140) || detector.Feed(20, 180) || detector.Feed(-20, 220);
    return !tooSlow && !jitter && detected;
  }

  // 把目标窗口拉到前台。
  //
  // Windows 只允许「拥有前台权限」的进程切换前台窗口，否则 SetForegroundWindow
  // 会静默失败（返回 false，什么也不做）。这个助手是被主程序 spawn 的后台子进程，
  // 默认不具备该权限，所以需要两手准备：
  //   1. 模拟一次 Alt 的按下抬起，让系统认为本进程刚刚收到用户输入而授予权限；
  //   2. 把自己的输入队列挂到当前前台线程上，借它的权限完成切换。
  // 两者都是公认的做法，单用任意一个在某些场景下都会失败。
  public static bool ForceForeground(IntPtr hwnd) {
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    if (GetForegroundWindow() == hwnd) return true;

    // 先走一次无副作用的直路。调用方本来就有前台权限时（比如刚响应完自己注册
    // 的全局快捷键），这一下就够了。
    // 下面那个 Alt 技巧并非没有代价：单独的 Alt 按下抬起会激活窗口菜单，
    // 可能把刚拿到的焦点又弄丢，所以只在真的需要时才用。
    BringWindowToTop(hwnd);
    if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return true;

    for (int attempt = 0; attempt < 3; attempt++) {
      keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
      keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

      IntPtr fg = GetForegroundWindow();
      uint dummy;
      uint fgThread = GetWindowThreadProcessId(fg, out dummy);
      uint myThread = GetCurrentThreadId();
      bool attached = false;
      if (fgThread != 0 && fgThread != myThread) {
        attached = AttachThreadInput(myThread, fgThread, true);
      }

      BringWindowToTop(hwnd);
      bool ok = SetForegroundWindow(hwnd);

      if (attached) AttachThreadInput(myThread, fgThread, false);

      // 以实际结果为准：SetForegroundWindow 的返回值并不总是可信。
      if (GetForegroundWindow() == hwnd) return true;
      if (ok) return true;
      System.Threading.Thread.Sleep(60);
    }
    return false;
  }

  public static void KeyCombo(byte modifier, byte key) {
    keybd_event(modifier, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    keybd_event(modifier, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }

  public static void KeyTap(byte key) {
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

Add-Type -TypeDefinition $nativeSource

function Write-Response($id, $payload) {
  $obj = @{ id = $id } + $payload
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

function ConvertFrom-B64($s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($s))
}

function Set-FileDropClipboard($encodedPaths) {
  $files = New-Object System.Collections.Specialized.StringCollection
  foreach ($encodedPath in @($encodedPaths)) {
    $candidate = ConvertFrom-B64 $encodedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { continue }
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    $null = $files.Add($resolved)
  }
  if ($files.Count -eq 0) { return $false }
  [System.Windows.Forms.Clipboard]::SetFileDropList($files)
  return $true
}

# 按进程名 + 窗口类名定位主窗口。
# 三个目标应用的窗口类名全是 Chrome_WidgetWin_1，所以进程名才是有效的区分依据。
# 同一进程可能有多个可见窗口（比如 ChatGPT 的主窗口和 Companion 小窗），
# 这里取面积最大的那个，它基本就是主对话窗。
function Find-TargetWindow($processName, $windowClass) {
  $procIds = @{}
  Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $procIds[[uint32]$_.Id] = $true }
  if ($procIds.Count -eq 0) { return $null }

  $found = New-Object System.Collections.ArrayList
  $cb = [Xfb+EnumProc]{
    param($h, $l)
    $owner = 0
    [Xfb]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    if (-not $procIds.ContainsKey([uint32]$owner)) { return $true }
    if (-not [Xfb]::IsWindowVisible($h)) { return $true }
    $cn = New-Object System.Text.StringBuilder 256
    [Xfb]::GetClassName($h, $cn, 256) | Out-Null
    if ($windowClass -and $cn.ToString() -ne $windowClass) { return $true }
    $r = New-Object Xfb+RECT
    [Xfb]::GetWindowRect($h, [ref]$r) | Out-Null
    $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
    if ($area -le 0) { return $true }
    $tb = New-Object System.Text.StringBuilder 512
    [Xfb]::GetWindowTextW($h, $tb, 512) | Out-Null
    $found.Add([PSCustomObject]@{ Hwnd = $h.ToInt64(); Area = $area; Title = $tb.ToString() }) | Out-Null
    return $true
  }
  [Xfb]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($found.Count -eq 0) { return $null }
  return ($found | Sort-Object Area -Descending | Select-Object -First 1)
}

# 投递一条消息。
# 全过程：记住当前前台窗口 -> 备份剪贴板 -> 写入文本 -> 闪切到目标
# -> Ctrl+V -> Enter -> 立刻把焦点还回去 -> 恢复剪贴板。
# 焦点归还是关键：用户要的是「发完就别打扰我」。
function Invoke-Deliver($hwnd, $text, $restoreFocus) {
  $target = [IntPtr]$hwnd
  $previous = [Xfb]::GetForegroundWindow()

  # 只备份文本型剪贴板。若原本是图片等其它格式，这里无法保留，
  # 属于已知取舍——换取实现的简单与可靠。
  $clipBackup = $null
  try { $clipBackup = Get-Clipboard -Format Text -Raw -ErrorAction SilentlyContinue } catch { }

  Set-Clipboard -Value $text

  if (-not [Xfb]::ForceForeground($target)) {
    if ($clipBackup) { Set-Clipboard -Value $clipBackup }
    return @{ ok = $false; reason = 'foreground-failed' }
  }

  # 等目标窗口真的拿到焦点再敲键，否则按键会打到旧的前台窗口上。
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ([Xfb]::GetForegroundWindow() -eq $target) { $ready = $true; break }
    Start-Sleep -Milliseconds 15
  }
  if (-not $ready) {
    if ($clipBackup) { Set-Clipboard -Value $clipBackup }
    return @{ ok = $false; reason = 'foreground-timeout' }
  }

  Start-Sleep -Milliseconds 60
  [Xfb]::KeyCombo([Xfb]::VK_CONTROL, [Xfb]::VK_V)
  Start-Sleep -Milliseconds 120
  [Xfb]::KeyTap([Xfb]::VK_RETURN)
  Start-Sleep -Milliseconds 80

  $returned = $false
  if ($restoreFocus -and $previous -ne [IntPtr]::Zero -and $previous -ne $target) {
    $returned = [Xfb]::ForceForeground($previous)
  }

  if ($clipBackup) {
    Start-Sleep -Milliseconds 50
    try { Set-Clipboard -Value $clipBackup } catch { }
  }

  return @{ ok = $true; focusReturned = $returned }
}

# 唤醒 Chromium 的可访问性树。
# Chromium 默认不构建 a11y 树，只有收到辅助技术客户端的信号才会启用。
# 实测对 ChatGPT Classic 有效（节点数 8 -> 245）；对 Gemini 无效。
function Invoke-WakeAccessibility($hwnd) {
  # WM_GETOBJECT = 0x003D, OBJID_CLIENT = -4
  [Xfb]::SendMessageW([IntPtr]$hwnd, 0x003D, [IntPtr]::Zero, [IntPtr](-4)) | Out-Null
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if ($null -ne $el) {
      $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | Out-Null
    }
  } catch { }
}

# 通过 UIA 判断目标是否正在生成回复。
# 依据：生成过程中，发送按钮会变成「停止」按钮。只要树里存在停止类按钮，
# 就认为仍在生成。同时统计节点总数，用于判断 a11y 树到底醒没醒——
# 节点数过少说明这条探测路不通，调用方应当降级到像素差分。
function Get-UiaState($hwnd) {
  $stopWords = @('停止', 'Stop')
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if ($null -eq $el) { return @{ ok = $false; reason = 'no-element' } }
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $count = $all.Count
    $streaming = $false
    foreach ($node in $all) {
      $nm = $node.Current.Name
      if ([string]::IsNullOrEmpty($nm)) { continue }
      foreach ($w in $stopWords) {
        if ($nm -like "*$w*") { $streaming = $true; break }
      }
      if ($streaming) { break }
    }
    return @{ ok = $true; nodeCount = $count; streaming = $streaming }
  } catch {
    return @{ ok = $false; reason = $_.Exception.Message }
  }
}

# ---- 主循环 ----
[Console]::Out.WriteLine('{"id":0,"type":"helper-ready"}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $reqId = 0
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.id
    switch ($req.cmd) {
      'find' {
        $w = Find-TargetWindow $req.processName $req.windowClass
        if ($null -eq $w) { Write-Response $reqId @{ ok = $false; reason = 'not-found' } }
        else { Write-Response $reqId @{ ok = $true; hwnd = $w.Hwnd; title = $w.Title } }
      }
      'deliver' {
        $restore = $true
        if ($null -ne $req.restoreFocus) { $restore = [bool]$req.restoreFocus }
        $res = Invoke-Deliver $req.hwnd (ConvertFrom-B64 $req.text) $restore
        Write-Response $reqId $res
      }
      'wake-a11y' {
        Invoke-WakeAccessibility $req.hwnd
        Write-Response $reqId @{ ok = $true }
      }
      'uia-probe' {
        Write-Response $reqId (Get-UiaState $req.hwnd)
      }
      'round-corners' {
        # Win11 只给「正常」窗口自动圆角，frameless 的窗口拿不到。
        # 输入条改走亚克力（窗口不再透明）之后，四个角就是齐齐的直角，
        # 而这条路上圆角补不了：窗口本身不透明，CSS 画的圆角
        # 只会让四个角各露出一小块底色。只能找 DWM 要。
        #
        # 33 = DWMWA_WINDOW_CORNER_PREFERENCE，2 = DWMWCP_ROUND。
        $pref = 2
        $hr = [Xfb]::DwmSetWindowAttribute([IntPtr]$req.hwnd, 33, [ref]$pref, 4)
        Write-Response $reqId @{ ok = ($hr -eq 0); hr = $hr }
      }
      'focus' {
        # 把自家窗口拉到前台。Electron 的 win.focus() 同样受前台锁定限制，
        # 在别的应用正活跃时会静默失败——输入条会显示出来却收不到键盘。
        $ok = [Xfb]::ForceForeground([IntPtr]$req.hwnd)
        Write-Response $reqId @{ ok = $ok }
      }
      'clip-state' {
        # 剪贴板的序列号。内容一变就自增，读它不需要打开剪贴板，
        # 所以可以按 700ms 的节奏一直问，没变就什么都不用做。
        Write-Response $reqId @{
          ok = $true
          seq = [int64][Xfb]::GetClipboardSequenceNumber()
        }
      }
      'clipboard-files' {
        Write-Response $reqId @{ ok = (Set-FileDropClipboard $req.paths) }
      }
      'shake-start' {
        Write-Response $reqId @{ ok = [Xfb]::StartShakeWatcher() }
      }
      'shake-take' {
        $started = [Xfb]::StartShakeWatcher()
        Write-Response $reqId @{
          ok = $started
          detected = ($started -and [Xfb]::ConsumeShake())
          hookEvents = [Xfb]::ShakeHookEvents
          dragMoves = [Xfb]::ShakeDragMoves
          qualifyingMoves = [Xfb]::ShakeQualifyingMoves
          directionChanges = [Xfb]::ShakeDirectionChanges
          lastDx = [Xfb]::ShakeLastDx
        }
      }
      'shake-selftest' {
        Write-Response $reqId @{ ok = [Xfb]::ShakeSelfTest() }
      }
      'ping' {
        Write-Response $reqId @{ ok = $true; pong = $true }
      }
      default {
        Write-Response $reqId @{ ok = $false; reason = "unknown-cmd: $($req.cmd)" }
      }
    }
  } catch {
    Write-Response $reqId @{ ok = $false; reason = $_.Exception.Message }
  }
}
