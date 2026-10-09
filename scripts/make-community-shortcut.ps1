param([string]$ShortcutDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
# WScript's shortcut file loader uses the system ANSI code page. Use the
# native Unicode interface so Chinese filenames also work on English Windows.
if (-not ('WanlingCommunity.UnicodeShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace WanlingCommunity {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal sealed class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr value);
        void SetIDList(IntPtr value);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetHotkey(out ushort value);
        void SetHotkey(ushort value);
        void GetShowCmd(out int value);
        void SetShowCmd(int value);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
    }
    public static class UnicodeShortcut {
        public static void Write(string filename, string target, string arguments, string directory, string icon) {
            object instance = new ShellLink();
            try {
                IShellLinkW link = (IShellLinkW)instance;
                link.SetPath(target);
                link.SetArguments(arguments);
                link.SetWorkingDirectory(directory);
                link.SetDescription("万灵漫剧社区版；首次启动自动准备本机环境。");
                link.SetIconLocation(icon, 0);
                link.SetShowCmd(7);
                ((IPersistFile)instance).Save(filename, true);
            } finally {
                Marshal.FinalReleaseComObject(instance);
            }
        }
    }
}
'@
}
[void][IO.Directory]::CreateDirectory($ShortcutDirectory)
[WanlingCommunity.UnicodeShortcut]::Write(
    (Join-Path $ShortcutDirectory '万灵漫剧 社区版.lnk'),
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
    ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'launch-community.ps1') + '"'),
    $appRoot,
    (Join-Path $appRoot 'dist\wanling.ico'))
Write-Host '万灵漫剧社区版快捷方式已创建。'
