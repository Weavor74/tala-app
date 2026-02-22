param (
    [string]$Action,
    [string]$Text,
    [int]$X,
    [int]$Y
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Move-Mouse {
    param([int]$x, [int]$y)
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
}

function Click-Mouse {
    param([string]$button = "left")
    # This requires user32.dll calls which is complex in pure PS without C# signature
    # Falling back to WScript.Shell for SendKeys, but mouse click is hard.
    # Actually, let's use a C# inline block for robust mouse/keyboard.
}

$code = @"
    using System;
    using System.Runtime.InteropServices;
    using System.Windows.Forms;
    using System.Threading;

    public class Input {
        [DllImport("user32.dll")]
        public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
        
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        private const int MOUSEEVENTF_LEFTDOWN = 0x02;
        private const int MOUSEEVENTF_LEFTUP = 0x04;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x08;
        private const int MOUSEEVENTF_RIGHTUP = 0x10;

        public static void Click() {
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            Thread.Sleep(50);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        }

        public static void Move(int x, int y) {
            SetCursorPos(x, y);
        }

        public static void Send(string keys) {
            SendKeys.SendWait(keys);
        }
    }
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms

switch ($Action) {
    "move" { [Input]::Move($X, $Y); Write-Output "Moved to $X, $Y" }
    "click" { [Input]::Click(); Write-Output "Clicked" }
    "type" { [Input]::Send($Text); Write-Output "Typed $Text" }
    "move_click" { [Input]::Move($X, $Y); Start-Sleep -Milliseconds 100; [Input]::Click(); Write-Output "Moved to $X, $Y and Clicked" }
}
