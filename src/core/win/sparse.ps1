# LanzadorAPK sparse-file helper (ASCII only).
# The Android data partition (userdata-qemu.img) is a raw disk image of 4-16 GB.
# Grown with qemu-img on NTFS it is fully allocated even though most of it is
# zeros, so the user sees many GB disappear on the first start.
#   flag  : mark the file sparse (do this BEFORE growing it, so the growth costs no disk)
#   punch : mark sparse and give back every 1 MB block that is all zeros
#           (FSCTL_SET_ZERO_DATA on bytes that are already zero: the content never changes)
# Prints one JSON line: {"ok":..,"next":..,"done":..,"before":..,"after":..}
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [ValidateSet('flag', 'punch')][string]$Mode = 'punch',
  [long]$Start = 0,
  [int]$MaxSeconds = 60
)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LzSparse
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, int inSize,
        IntPtr outBuf, int outSize, out int returned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetCompressedFileSizeW(string name, out uint high);

    const uint FSCTL_SET_SPARSE = 0x000900C4;
    const uint FSCTL_SET_ZERO_DATA = 0x000980C8;

    public static long OnDisk(string path)
    {
        uint high;
        uint low = GetCompressedFileSizeW(path, out high);
        if (low == 0xFFFFFFFF && Marshal.GetLastWin32Error() != 0) return -1;
        return ((long)high << 32) | low;
    }

    static bool SetSparse(FileStream fs)
    {
        int r;
        return DeviceIoControl(fs.SafeFileHandle, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out r, IntPtr.Zero);
    }

    static bool ZeroRange(FileStream fs, long from, long to)
    {
        IntPtr p = Marshal.AllocHGlobal(16);
        try
        {
            Marshal.WriteInt64(p, 0, from);
            Marshal.WriteInt64(p, 8, to);
            int r;
            return DeviceIoControl(fs.SafeFileHandle, FSCTL_SET_ZERO_DATA, p, 16, IntPtr.Zero, 0, out r, IntPtr.Zero);
        }
        finally { Marshal.FreeHGlobal(p); }
    }

    static bool AllZero(byte[] b, int n)
    {
        int i = 0;
        for (; i + 8 <= n; i += 8) if (BitConverter.ToInt64(b, i) != 0) return false;
        for (; i < n; i++) if (b[i] != 0) return false;
        return true;
    }

    public static string Run(string path, string mode, long start, int maxSeconds)
    {
        long before = OnDisk(path);
        // FileShare.None: if the emulator still has the image open we do nothing (never touch a disk in use)
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 1 << 16))
        {
            if (!SetSparse(fs)) return "{\"ok\":false,\"error\":\"set-sparse " + Marshal.GetLastWin32Error() + "\"}";
            if (mode == "flag")
                return "{\"ok\":true,\"next\":0,\"done\":true,\"before\":" + before + ",\"after\":" + before + "}";
            const int CH = 1 << 20;
            byte[] buf = new byte[CH];
            long len = fs.Length;
            long pos = Math.Max(0, start - (start % CH));
            long run = -1;
            Stopwatch sw = Stopwatch.StartNew();
            while (pos < len)
            {
                if (sw.Elapsed.TotalSeconds > maxSeconds) break;
                fs.Position = pos;
                int want = (int)Math.Min(CH, len - pos);
                int got = 0;
                while (got < want)
                {
                    int r = fs.Read(buf, got, want - got);
                    if (r <= 0) break;
                    got += r;
                }
                if (got <= 0) break;
                if (AllZero(buf, got)) { if (run < 0) run = pos; }
                else if (run >= 0) { ZeroRange(fs, run, pos); run = -1; }
                pos += got;
            }
            if (run >= 0) ZeroRange(fs, run, pos);
            fs.Flush();
            bool done = pos >= len;
            fs.Close();
            long after = OnDisk(path);
            return "{\"ok\":true,\"next\":" + (done ? 0 : pos) + ",\"done\":" + (done ? "true" : "false")
                + ",\"before\":" + before + ",\"after\":" + after + "}";
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $src -Language CSharp
  [Console]::Out.WriteLine([LzSparse]::Run($Path, $Mode, $Start, $MaxSeconds))
} catch {
  $msg = ($_.Exception.Message -replace '[\r\n"\\]', ' ')
  [Console]::Out.WriteLine('{"ok":false,"error":"' + $msg + '"}')
}
