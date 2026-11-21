# LanzadorAPK window agent (ASCII only).
# A single long-lived helper that owns every Win32 trick we need:
#   * re-parents the Android emulator Qt window into an LanzadorAPK BrowserWindow (one clean window,
#     no emulator sidebar, no emulator title bar);
#   * hides the floating emulator toolbar window that shows the volume/camera/back rail;
#   * rotates the device with Ctrl+Left / Ctrl+Right and reports the new window size;
#   * runs an opt-in WH_MOUSE_LL hook so right click becomes Android BACK, wheel
#     becomes a coalesced swipe, and (optionally) side buttons become BACK / FORWARD.
#     Left click is deliberately left alone: Qt already maps it to a finger tap.
# Everything is P/Invoke from the .NET Framework that ships with Windows 10/11,
# so there is no native binary to compile, sign or ship.
# Protocol: TCP on 127.0.0.1, one JSON object per line. First stdout line is "PORT=<n>".
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ApkAgent
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Pt; public int MouseData; public int Flags; public int Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    // Minimal PROCESS_BASIC_INFORMATION: enough to read InheritedFromUniqueProcessId.
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr ParentPid; }

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowTextW(IntPtr h, string s);
    // Fija el icono de la ventana nativa del emulador (en modo independiente, la barra de tareas/Alt+Tab muestran el icono de la app actual)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImageW(IntPtr inst, string file, uint type, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    // Alta DPI: appwin.js envía píxeles físicos. Sin declarar conciencia de DPI, Windows los toma como lógicos y los vuelve a ampliar,
    // y la ventana del emulador incrustada queda más grande que el anfitrión (1,5 veces con escalado de 150 %) → imagen recortada a la derecha/abajo y clics desplazados (issue #40).
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr c);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    // Recorta el área visible de la ventana incrustada: quita la franja del marco que cae sobre la barra de título
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CHILD = 0x40000000;
    const uint WS_POPUP = 0x80000000;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_BORDER = 0x00800000;
    const int WS_CLIPCHILDREN = 0x02000000;
    const int WS_CLIPSIBLINGS = 0x04000000;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;

    static IntPtr _host = IntPtr.Zero;
    static IntPtr _emu = IntPtr.Zero;
    static IntPtr _chromeRender = IntPtr.Zero;
    static IntPtr _hook = IntPtr.Zero;
    static HookProc _hookProc = null;
    static Thread _hookThread = null;
    static volatile bool _hookRun = false;
    static uint _hookTid = 0;
    static readonly ManualResetEvent _hookReady = new ManualResetEvent(false);
    static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    static long _lastToolSweep = 0;
    static long _embedAt = 0;
    // Supresión persistente: activa por defecto desde el arranque; oculta la ventana principal del emulador + barra de herramientas + consolas negras.
    // A diferencia de la lógica anterior «se desactiva al terminar embed», es **persistente**: el barrido omite la ventana ya incrustada
    // en la nuestra y oculta todas las demás (incluida la ventana negra que vuelve al escritorio al salir LanzadorAPK).
    static volatile bool _quiet = true;
    static volatile bool _perfMode = false;
    static volatile bool _detachedMode = false;
    static long _bootHideSweep = 0;
    // Marca de tiempo del barrido exclusivo de consolas negras. Cuando emulator lanza qemu, Windows abre para esa consola
    // una ventana nueva (en Win11 es Windows Terminal) que solo vive 200–300 ms; la revisión principal,
    // cada 250 ms, no la atrapa con seguridad, así que durante los primeros 15 s se barren aparte, con más frecuencia, las ventanas tipo consola.
    static long _consoleSweep = 0;
    // Tiempo límite de respaldo: por si embed nunca llega (el usuario solo abrió LanzadorAPK sin abrir una app),
    // el barrido cada 120 ms no puede seguir para siempre quemando CPU. Cada vez que oculta una ventana se renueva.
    static long _bootHideUntil = 0;
    static long _bootHideStart = Environment.TickCount;
    // Límite de tiempo (TickCount) de la «guardia» tras la desconexión. Ver la rama sock == null en Serve().
    static long _lingerUntil = 0;

    // Which windows count as "ours": only those created by a process whose exe lives
    // inside one of these directories (the runtime root / bundled engine dir).
    // This is the whole fix for "LanzadorAPK conflicts with WeChat": WeChat 4.x is Qt 6
    // too (its windows are QWindowIcon / QWindowToolSaveBits), so any matching that
    // relied on window class names alone could hide or even re-parent WeChat's own
    // windows. Class names are never unique; the owning process's path is.
    static readonly System.Collections.Generic.List<string> _scopeDirs = new System.Collections.Generic.List<string>();
    static readonly System.Collections.Generic.Dictionary<uint, bool> _oursCache = new System.Collections.Generic.Dictionary<uint, bool>();
    // PID of the LanzadorAPK main process. The only window we are ever allowed to embed
    // into / swallow clicks for. Guard against a recycled HWND: if _host later belongs
    // to somebody else, the mouse hook must pass events through instead of eating them.
    static uint _appPid = 0;
    static uint _hostPid = 0;

    // Hook options. All three default to OFF: an "hook on" without options must
    // never swallow anybody's clicks. JS sends the real config on every enable.
    static volatile int _optRight = 0;
    static volatile int _optWheel = 0;
    static volatile int _optSide = 0;

    // Wheel coalescing: Qt would turn every single notch into a separate touch
    // gesture (visible stutter). We accumulate deltas for a short window and
    // hand one normalized position to the JS side, which injects a single swipe.
    static readonly object _wheelLock = new object();
    static int _wheelDx = 0, _wheelDy = 0;
    static double _wheelNx = 0.5, _wheelNy = 0.5;
    static long _wheelFirst = 0, _wheelLast = 0;

    // ------------------------------------------------------------------ ownership
    // Scope is set by the JS side before anything is hidden ("scope" command).
    // With no scope the agent refuses to touch any window: leaving one black console
    // around is a cosmetic bug, hiding a user's WeChat window is not.
    static void SetScope(string raw)
    {
        _scopeDirs.Clear();
        string[] pieces = (raw == null ? "" : raw).Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            string d = piece.Trim();
            if (d.Length == 0) continue;
            try { d = System.IO.Path.GetFullPath(d); } catch { }
            if (!d.EndsWith("\\")) d += "\\";
            _scopeDirs.Add(d.ToLowerInvariant());
        }
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static bool IsOurs(uint pid)
    {
        if (pid == 0 || _scopeDirs.Count == 0) return false;
        lock (_oursCache)
        {
            bool hit;
            if (_oursCache.TryGetValue(pid, out hit)) return hit;
        }
        bool ours = false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                string file = null;
                try { file = p.MainModule.FileName; } catch { file = null; }
                if (!string.IsNullOrEmpty(file))
                {
                    string low = file.ToLowerInvariant();
                    for (int i = 0; i < _scopeDirs.Count; i++)
                        if (low.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) { ours = true; break; }
                }
            }
        }
        catch { ours = false; }
        lock (_oursCache)
        {
            // PIDs get recycled; a bounded cache is enough (one entry per live process).
            if (_oursCache.Count > 400) _oursCache.Clear();
            _oursCache[pid] = ours;
        }
        return ours;
    }

    static uint ParentOf(uint pid)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return 0;
            PBI pbi = new PBI();
            int len;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return 0;
            return (uint)pbi.ParentPid.ToInt64();
        }
        catch { return 0; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    // Console windows belong to conhost.exe, not to the program that owns the console,
    // so the window pid is never the emulator's. Walk conhost's parents instead.
    static bool ConsoleOwnedByUs(uint pid)
    {
        uint p = ParentOf(pid);
        for (int i = 0; i < 3 && p != 0; i++)
        {
            if (IsOurs(p)) return true;
            p = ParentOf(p);
        }
        return false;
    }

    static bool IsOurConsole(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (IsOurs(pid) || ConsoleOwnedByUs(pid)) return true;
        if (_scopeDirs.Count == 0) return false;
        // Windows titles a console with the image path it launched, so the runtime
        // directory shows up verbatim. Precise enough to never match a stray terminal.
        string title = TitleOf(h).ToLowerInvariant();
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (title.IndexOf(_scopeDirs[i], StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // ------------------------------------------------------------------ window discovery
    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }
    static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // The emulator draws its framebuffer in a "QWindowIcon" top level window titled
    // "Android Emulator - <avd>:<port>"; the volume/rotate rail lives in a separate
    // small "QWindowTool*" window we hide.
    //
    // Ojo: durante el arranque del emulador (y tras ocultarla la supresión persistente) esta ventana es **invisible**,
    // así que aquí ya no se puede filtrar por IsWindowVisible; si no, nunca se encontraría una ventana para incrustar
    // y el usuario vería una ventana de app totalmente negra. Ahora se reconoce «si el título es Android Emulator,
    // priorizando las ventanas grandes visibles». Barras de herramientas / avisos (QWindowTool) son muy pequeñas y las descarta el umbral de área.
    //
    // LanzadorAPK cambia el título de esta ventana al nombre de la app (ver el comando "title"), así que al identificarla
    // también hay que reconocer «el título cambiado». Un campo volatile recuerda el título que pusimos.
    public static string _ourTitle = "";
    // Ruta del archivo de icono de la app: Qt devuelve el icono al robot verde por defecto al recrear la ventana; la revisión lo vuelve a poner.
    public static string _ourIconFile = "";
    public static IntPtr _ourIconSmall = IntPtr.Zero;
    public static IntPtr _ourIconBig = IntPtr.Zero;
    static bool LooksLikeEmulator(string title)
    {
        if (title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (_ourTitle.Length > 0 && String.Equals(title, _ourTitle, StringComparison.Ordinal)) return true;
        return false;
    }
    static IntPtr FindEmulator()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            // Ownership comes first. "QWindowIcon" is the class of EVERY Qt top level
            // window, and WeChat 4.x / MuMu / music players are Qt too -- matching on
            // the class alone is how the wrong window ended up hidden or re-parented.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowIcon", StringComparison.Ordinal) < 0) return true;
            string title = TitleOf(h);
            bool named = LooksLikeEmulator(title);
            if (!named && !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area < 200 * 200) return true;   // Barras de herramientas / avisos no son la ventana de imagen
            // Primero las ventanas grandes visibles, luego las ocultas
            long score = area + (IsWindowVisible(h) ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // Para diagnóstico: lista las ventanas de nivel superior (clase / título / pid / tamaño / si es visible).
    // Sirve para verificar «al abrir el programa solo se ve su interfaz»: la ventana principal del emulador y la consola de netsim no deben estar.
    static string ListWindows(bool includeHidden)
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            bool vis = IsWindowVisible(h);
            if (!vis && !includeHidden) return true;
            string cls = ClassOf(h);
            string title = TitleOf(h);
            // Hay demasiadas ventanas ocultas (cientos o miles en el sistema); solo se miran las relacionadas con el emulador/Qt
            if (!vis && cls.IndexOf("QWindow", StringComparison.Ordinal) < 0
                && title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.R - r.L, hh = r.B - r.T;
            if (vis && (w < 40 || hh < 40)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"w\":").Append(w)
              .Append(",\"h\":").Append(hh)
              .Append(",\"vis\":").Append(vis ? "true" : "false")
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static void HideToolWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowTool", StringComparison.Ordinal) < 0) return true;
            // QWindowToolSaveBits is what Qt uses for menus, tooltips and popup panels --
            // WeChat's emoji panel / right-click menu included. Only hide our own.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) > 200) return true;   // the framebuffer window also uses this class
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Durante el arranque: oculta las ventanas de consola negras de qemu / emulator, para que no aparezca una «ventana de comandos».
    // Son procesos del subsistema de consola; windowsHide de Node no alcanza a los subprocesos, solo se pueden suprimir periódicamente con Win32.
    //
    // Problema clave: desde Windows 10 la ventana de consola pertenece en realidad a conhost.exe; GetWindowThreadProcessId
    // devuelve el pid de conhost, no el de emulator; la implementación anterior usaba una lista de pid permitidos,
    // y no ocultaba ninguna de esas ventanas negras (de ahí venía «pulso y no pasa nada, primero aparece una ventana negra de cmd»).
    // Ahora es «coincide el pid o coincide el título de la ventana (el título es la ruta del exe lanzado)»; cualquiera de las dos basta para ocultarla.
    static void HideConsoleWindows()
    {
        if (_scopeDirs.Count == 0) return;   // no scope: never touch anybody's terminal

        // Primero se revisa qué ventanas de consola hay; si no hay ninguna no se enumeran procesos (GetProcessesByName no es barato)
        var consoles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                consoles.Add(h);
            return true;
        }, IntPtr.Zero);
        if (consoles.Count == 0) return;

        // La implementación anterior tenía además la regla «si el título contiene emulator / qemu / netsim es nuestra»,
        // que ocultaba también las terminales que abría el usuario (con títulos de ruta, p. ej. D://Android//emulator).
        // Ahora solo hay dos pruebas válidas: la cadena de procesos padre de conhost llega a nuestra carpeta del runtime,
        // o el título contiene la ruta absoluta de nuestra carpeta del runtime (Windows usa la ruta de la imagen como título de la consola).
        long now = Environment.TickCount;
        foreach (IntPtr h in consoles)
        {
            if (IsOurConsole(h)) { ShowWindow(h, 0); continue; }
            // Tercera prueba (solo Windows 11): cuando el anfitrión de consola por defecto pasa a ser Windows Terminal,
            // la consola que el emulador abre para qemu pertenece a WindowsTerminal.exe:
            // el pid no es nuestro, la cadena de padres no llega a nosotros y el título a menudo es solo "Terminal",
            // así que ninguna de las dos pruebas anteriores coincide y en cada arranque aparecía una ventana negra durante 200–300 ms.
            // Aquí se reconocen tres condiciones juntas: «no existía antes del arranque + aparece en los 20 s siguientes + título vacío/igual a Terminal».
            // Las terminales nuevas que abre el usuario suelen tener ya un título (PowerShell, una ruta),
            // así que no se afectan; y en el peor caso solo se ocultan, no se cierra su proceso.
            if (_bootHideStart != 0 && now - _bootHideStart < 20000
                && !_consolesBeforeBoot.Contains(h.ToInt64()))
            {
                string t = TitleOf(h);
                string tl = t.ToLowerInvariant();
                // En la práctica el título cambia: puede estar vacío, ser "Terminal" o "Windows Terminal"
                // (según la versión de WT y si ya recibió el título de la shell). Aquí solo se exige que «parezca un
                // anfitrión de consola»: título vacío o que contenga terminal.
                // Las terminales que el usuario ya tenía abiertas están en _consolesBeforeBoot y no se afectan;
                // y en el peor caso solo se ocultan, no se cierra su proceso.
                bool plain = t.Length == 0 || tl.IndexOf("terminal", StringComparison.Ordinal) >= 0;
                if (plain)
                {
                    ShowWindow(h, 0);
                }
            }
        }
    }

    // Registra «las ventanas de consola que ya existían en el momento del arranque (boothide)».
    // Windows Terminal mete nuestra consola de qemu en una ventana nueva cuya pertenencia no se puede deducir por pid /
    // proceso padre / título; lo más fiable es reconocerla por «no existía antes del arranque y apareció después».
    static System.Collections.Generic.HashSet<long> _consolesBeforeBoot =
        new System.Collections.Generic.HashSet<long>();

    static void SnapshotConsoles()
    {
        _consolesBeforeBoot.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                _consolesBeforeBoot.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
    }

    // Para diagnóstico: lista las ventanas de consola «visibles» actuales (ventanas negras) y su pertenencia, para los scripts de verificación de tools.
    // ours=true indica que es la ventana de consola de emulator/qemu.
    static string ListConsoles()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            bool isConsole = cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0;
            if (!isConsole) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string title = TitleOf(h);
            bool ours = IsOurConsole(h);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"ours\":").Append(ours ? "true" : "false")
              .Append(",\"pid\":").Append(pid)
              .Append(",\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static string JsonStr(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s == null ? "" : s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c >= ' ') b.Append(c);
        }
        b.Append("\"");
        return b.ToString();
    }

    // Respaldo: oculta cualquier **ventana visible de nivel superior sobrante** creada por «nuestros procesos del runtime».
    // Además de la ventana principal del emulador (que se incrusta en el anfitrión), emulator / qemu / netsimd / adb pueden
    // mostrar cosas fugaces (avisos de Qt, diálogos de fallo, barra de volumen, ventanas de registro…).
    // Antes se nombraban una por una por clase, y cada una olvidada parpadeaba; ahora se decide por «el proceso pertenece a nuestra carpeta del runtime»,
    // con mucha más cobertura. La ventana anfitriona y la del emulador no entran en este alcance y nunca se afectan.
    static void HideStrayWindows()
    {
        if (_scopeDirs.Count == 0) return;
        IntPtr embeddedRoot = _emu;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            if (h == embeddedRoot) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsOurs(pid)) return true;
            string cls = ClassOf(h);
            // Solo se ocultan clases claramente emergentes: avisos / diálogos / consolas de Qt.
            // Nunca se toca QWindowIcon / subWin: es el LCD que se está incrustando; ocultarlo dejaría todo negro y sin clics.
            bool safe = cls.IndexOf("QWindowTool", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("Qt", StringComparison.Ordinal) < 0 && cls.IndexOf("Chrome", StringComparison.Ordinal) < 0;
            if (!safe) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) < 8 && (r.B - r.T) < 8) return true;
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Barrido de supresión persistente: mientras la ventana del emulador no sea «hija de una de nuestras ventanas», se oculta.
    // Así, ya sea que el emulador esté arrancando, precalentando, o que LanzadorAPK ya haya salido (y el sistema vuelva a colgar la ventana del escritorio
    // como ventana de nivel superior), el usuario nunca ve la ventana negra llamada "Android Emulator - lanzadorapk5554".
    // Además se suprimen la barra de herramientas (QWindowTool) y todas las ventanas de consola (qemu / netsimd / emulator).

    // En el momento del embed, la subventana de renderizado web de Electron puede no existir aún y FindChromeRender devuelve 0,
    // así que el simulador queda como hijo directo del anfitrión (hermano de la capa web), y la capa web tapa
    // la imagen y se come el ratón. Aquí el barrido persistente lo corrige: en cuanto aparece la capa web, se vuelve a colgar.
    static void EnsureReparent()
    {
        if (_emu == IntPtr.Zero || _host == IntPtr.Zero) return;
        if (_chromeRender == IntPtr.Zero || !IsWindow(_chromeRender))
            _chromeRender = FindChromeRender(_host);
        if (_chromeRender == IntPtr.Zero) return;
        IntPtr ep = GetParent(_emu);
        if (ep == _chromeRender) return;
        if (ep != _host && ep != IntPtr.Zero) return;   // Es de otro anfitrión; no tocar
        RECT r;
        if (!GetWindowRect(_emu, out r)) return;
        RECT hr;
        if (!GetWindowRect(_host, out hr)) return;
        SetParent(_emu, _chromeRender);
        // Coordenadas relativas al área cliente de la capa web (igual que el área cliente del anfitrión); se mantiene la posición en pantalla
        SetWindowPos(_emu, IntPtr.Zero, r.L - hr.L, r.T - hr.T,
                     r.R - r.L, r.B - r.T, 0x0004 | 0x0010 | 0x0040);
    }

    static void QuietSweep()
    {
        // Modo de ventana independiente: la ventana del emulador es «la que el usuario está viendo», nunca se puede suprimir,
        // ni ajustarse según el área cliente del anfitrión. Aquí se omite toda la lógica de supresión.
        if (_detachedMode)
        {
            // Qt devuelve el título a "Android Emulator - ..." al cambiar la resolución/recrear la ventana.
            // Se vuelve a fijar en cada revisión, para que en la barra de tareas siempre diga LanzadorAPK (o el nombre de la app).
            if (_ourTitle.Length > 0 && _emu != IntPtr.Zero
                && !String.Equals(TitleOf(_emu), _ourTitle, StringComparison.Ordinal))
                SetWindowTextW(_emu, _ourTitle);
            // Tras cambiar la resolución/recrear la ventana Qt vuelve al icono del robot verde; se fija otra vez en cada ronda.
            // Si WM_GETICON no es cero la ventana ya tiene nuestro icono y se omite; si no, se reenvía el identificador en caché.
            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero)
                && SendMessageW(_emu, 0x007F, new IntPtr(1), IntPtr.Zero) == IntPtr.Zero)
            {
                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
            }
            HideConsoleWindows();
            HideStrayWindows();
            return;
        }
        EnsureReparent();
        // Autocorrección de tamaño: tras maximizar/redimensionar el anfitrión, la capa chrome de Electron muchas veces no crece,
        // y la imagen queda en una franja arriba a la izquierda. Aquí se reajusta en cada ronda (Fit recalcula según el área cliente del anfitrión;
        // si el tamaño no cambió, SetWindowPos casi no cuesta nada).
        if (_emu != IntPtr.Zero && _host != IntPtr.Zero) Fit(-8, 30, 640, 480, false, 0);
        IntPtr ep = _emu != IntPtr.Zero ? GetParent(_emu) : IntPtr.Zero;
        bool embedded = _emu != IntPtr.Zero && ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        IntPtr e = embedded ? _emu : FindEmulator();
        if (!embedded && e != IntPtr.Zero && IsWindowVisible(e)) ShowWindow(e, 0);
        HideToolWindows();
        HideConsoleWindows();
        HideStrayWindows();
        if (!embedded && e != IntPtr.Zero) _bootHideUntil = Environment.TickCount + 5000;
    }

    // Only our own runtime counts. The old version returned true for ANY process named
    // "emulator" -- other emulators (MuMu / LDPlayer ship their own) kept the guard alive.
    static bool AnyEmulatorProcess()
    {
        if (_scopeDirs.Count == 0) return false;
        try
        {
            string[] names = { "qemu-system-x86_64", "qemu-system-x86_64-headless", "emulator", "emulator-headless", "netsimd" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] all = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < all.Length; j++)
                    if (IsOurs((uint)all[j].Id)) return true;
            }
        }
        catch { }
        return false;
    }

    // ------------------------------------------------------------------ embed / detach

    // Busca la subventana de renderizado de Chromium dentro de la ventana anfitriona.
    // Si la capa web de Electron (Chrome_RenderWidgetHostHWND) y la ventana del emulador son ambas
    // hijas directas del anfitrión, son «hermanas», y Electron sube la capa web al frente una y otra vez:
    // el fondo negro de la capa web tapa la imagen de Android y se come todo el ratón (los «bordes negros /
    // sin llenar / clics que no funcionan / no se puede pulsar aceptar» de los usuarios venían todos de aquí).
    // Colgando el emulador como **hija** de la capa web, el orden Z y los clics favorecen naturalmente al emulador.
    static IntPtr FindChromeRender(IntPtr host)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(host, delegate(IntPtr c, IntPtr p)
        {
            if (ClassOf(c).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.Ordinal) >= 0)
            {
                found = c;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static bool Embed(IntPtr host, IntPtr emu)
    {
        if (host == IntPtr.Zero || emu == IntPtr.Zero) return false;
        HideToolWindows();
        // La subventana web cubre el área cliente del anfitrión con el mismo sistema de coordenadas, así que el rectángulo que pasa Fit no cambia.
        IntPtr parent = FindChromeRender(host);
        if (parent == IntPtr.Zero) parent = host;   // Si no se encuentra se vuelve al comportamiento anterior, para que la app pueda abrir
        SetParent(emu, parent);
        uint style = (uint)GetWindowLong(emu, GWL_STYLE);
        style &= ~WS_POPUP;
        style &= ~(uint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER);
        style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        SetWindowLong(emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(emu, GWL_EXSTYLE);
        ex &= ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
        SetWindowLong(emu, GWL_EXSTYLE, ex);
        // Versiones anteriores le pusieron una window region a esta ventana; al reutilizarla se quita primero, si no, la detección de clics sigue desplazada
        SetWindowRgn(emu, IntPtr.Zero, false);
        return true;
    }

    // HWND_TOP: la subventana de renderizado de Chromium y el emulador son hijas del mismo nivel;
    // si no se sube al frente, el fondo negro de Chromium lo tapa (el usuario ve una pantalla negra).
    static readonly IntPtr HWND_TOP = new IntPtr(1);
    static void Fit(int x, int y, int w, int h, bool frame, int clipTop)
    {
        if (_emu == IntPtr.Zero) return;
        // Fit lo llama JS en cada resize; para entonces la capa web ya existe seguro.
        // Asegura que el emulador cuelgue bajo la capa web (como hermanas, la capa web lo taparía y se comería el ratón).
        if (_host != IntPtr.Zero)
        {
            IntPtr cr = FindChromeRender(_host);
            if (cr != IntPtr.Zero)
            {
                _chromeRender = cr;
                IntPtr cur = GetParent(_emu);
                if (cur != cr && (cur == _host || cur == IntPtr.Zero))
                {
                    SetParent(_emu, cr);
                    // Coordenadas relativas al área cliente de la capa web, igual que el anfitrión; se usan las x/y recibidas
                }
            }
        }
        // El tamaño se autocorrige según el **área cliente de la ventana anfitriona**, sin confiar en el w/h que manda JS
        // ni en el tamaño de la propia capa de renderizado de Chrome.
        //
        // Por qué: tras maximizar en Electron la ventana anfitriona pasa a 1936x1048, pero la
        // Chrome_RenderWidgetHostHWND interna se queda en el tamaño anterior (probado: 532x984), y la ventana del emulador
        // cuelga de la capa chrome y su padre la recorta: la imagen solo ocupa una franja arriba a la izquierda
        // con un gran espacio vacío a la derecha (el «no llena tras maximizar/pantalla completa» de las capturas de usuarios).
        // Por eso primero se estira la capa chrome a todo el área cliente del anfitrión y luego emu se fija a ese tamaño.
        if (_host != IntPtr.Zero)
        {
            RECT hc;
            if (GetClientRect(_host, out hc))
            {
                int cw = hc.R - hc.L;
                int chh = hc.B - hc.T;
                if (cw > 200 && chh > 200)
                {
                    if (_chromeRender != IntPtr.Zero)
                    {
                        RECT crc;
                        if (GetWindowRect(_chromeRender, out crc))
                        {
                            if ((crc.R - crc.L) != cw || (crc.B - crc.T) != chh)
                            {
                                SetWindowPos(_chromeRender, IntPtr.Zero, 0, 0, cw, chh,
                                    SWP_NOZORDER | SWP_NOACTIVATE);
                            }
                        }
                    }
                    // x/y mantienen el desborde de -8 (saca de la zona visible el borde gris de 8 px de Qt),
                    // ancho y alto = área cliente + 2*8; la barra de título de 38 px la tapa el anfitrión con su propio dibujo.
                    x = -8;
                    y = 38 - 8;
                    w = cw + 16;
                    h = (chh - 38) + 16;
                }
            }
        }
        if (w < 16) w = 16;
        if (h < 16) h = 16;
        // Solo se puede mostrar lo que «de verdad ya está incrustado en nuestra ventana».
        // Si el embed falla (la ventana del emulador aún no existe / cambió el identificador), Fit nunca debe tratarla como ventana independiente
        // y subirla al escritorio: justo esa era la ventana negra "Android Emulator - lanzadorapk5554" que veía el usuario.
        IntPtr ep = GetParent(_emu);
        bool embedded = ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        if (!embedded)
        {
            ShowWindow(_emu, 0);
            return;
        }
        // SWP_FRAMECHANGED forces Windows to recompute the whole non-client area and
        // repaint it. It is needed exactly once (right after SetParent); repeating it
        // on every periodic sweep caused visible stutter and wasted GPU/CPU.
        uint flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (frame ? SWP_FRAMECHANGED : 0u);
        SetWindowPos(_emu, HWND_TOP, x, y, w, h, flags);
        // Nunca se le pone una window region a la ventana incrustada: con region, la detección de clics y el mapeo de coordenadas de entrada
        // de una subventana Qt/GL se desplazan (clics que no funcionan / no se alcanzan botones), y tras rotar y cambiar de tamaño la region sigue con el rectángulo
        // viejo y deja bordes negros. La franja de 8 px que desborda sobre la barra de título la tapa la barra dibujada por el anfitrión.
    }

    static void Raise()
    {
        if (_emu == IntPtr.Zero) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void Detach()
    {
        if (_emu == IntPtr.Zero) return;
        SetParent(_emu, IntPtr.Zero);
        uint style = (uint)GetWindowLong(_emu, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLong(_emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(_emu, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(_emu, GWL_EXSTYLE, ex);
        SetWindowPos(_emu, IntPtr.Zero, 60, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        // En modo de ventana independiente se conserva el identificador: show / layout lo usan para ubicar la ventana real.
        // En modo incrustado (por defecto) se sigue vaciando, con la semántica de siempre.
        if (!_detachedMode) _emu = IntPtr.Zero;
    }

    // Igual que Detach, pero **sin mostrar** la ventana: se llama cuando la ventana anfitriona está por destruirse.
    // Si no se desprende antes, al destruir el anfitrión Windows vuelve a colgar la hija del escritorio y la hace visible,
    // y aparece de la nada una ventana negra "Android Emulator - lanzadorapk5554".
    static void ParkEmulator()
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        IntPtr e = _emu;
        if (e == IntPtr.Zero) { _host = IntPtr.Zero; return; }
        ShowWindow(e, 0);
        SetParent(e, IntPtr.Zero);
        uint style = (uint)GetWindowLong(e, GWL_STYLE);
        style &= ~WS_CHILD;
        // Se restaura también WS_VISIBLE (0x10000000): puede haberse quitado implícitamente al hacer «SetParent a un anfitrión oculto»,
        // y un backend de terceros (MuMu) no la vuelve a mostrar; tras cerrar la ventana de la app el usuario nunca más vería el emulador.
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | 0x10000000);
        SetWindowLong(e, GWL_STYLE, (int)style);
        int ex = GetWindowLong(e, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(e, GWL_EXSTYLE, ex);
        SetWindowPos(e, IntPtr.Zero, 40, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        _emu = IntPtr.Zero;
        _host = IntPtr.Zero;
    }

    // ------------------------------------------------------------------ rotation
    // Girar la pantalla del emulador es «cambiar la orientación de la pantalla», y solo lo dispara su propio atajo Qt Ctrl+←/→;
    // el comando de consola adb emu rotate solo gira la imagen 90° y el sistema sigue en vertical (imagen acostada).
    // Lo difícil es que el atajo lo debe recibir la ventana del emulador, que ya es hija de nuestra ventana
    // con el foco en la capa web. Por eso primero se unen las colas de entrada de ambos hilos, se da el foco temporalmente al emulador,
    // se pulsa la tecla y se devuelve el foco.
    static void Rotate(string dir)
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        if (_emu == IntPtr.Zero) return;
        // keybd_event feeds the SYSTEM input queue, so if we are not the foreground
        // window the Ctrl+Left lands in whatever the user is typing in (WeChat's input
        // box, a browser, ...). Rotate is a user action in our own window; if we are
        // not foreground, do nothing instead of typing into someone else's app.
        IntPtr fg = GetForegroundWindow();
        if (_host == IntPtr.Zero || (fg != IntPtr.Zero && GetAncestor(fg, 2) != _host)) return;
        IntPtr host = _host != IntPtr.Zero ? _host : GetParent(_emu);

        uint emuTid, hostTid, dummy;
        emuTid = GetWindowThreadProcessId(_emu, out dummy);
        hostTid = host != IntPtr.Zero ? GetWindowThreadProcessId(host, out dummy) : 0;
        uint myTid = GetCurrentThreadId();

        bool a1 = AttachThreadInput(myTid, emuTid, true);
        bool a2 = hostTid != 0 && AttachThreadInput(myTid, hostTid, true);
        try
        {
            if (host != IntPtr.Zero) SetForegroundWindow(host);
            IntPtr prev = SetFocus(_emu);
            Thread.Sleep(150);
            byte vk = dir == "right" ? (byte)0x27 : (byte)0x25;
            keybd_event(0x11, 0, 0, IntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(vk, 0, 0, IntPtr.Zero);
            Thread.Sleep(80);
            keybd_event(vk, 0, 2, IntPtr.Zero);
            keybd_event(0x11, 0, 2, IntPtr.Zero);
            Thread.Sleep(120);
            SetFocus(prev);
        }
        finally
        {
            if (a2) AttachThreadInput(myTid, hostTid, false);
            if (a1) AttachThreadInput(myTid, emuTid, false);
        }
    }

    // ------------------------------------------------------------------ mouse mapping
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_RBUTTONUP = 0x0205;
    const int WM_RBUTTONDBLCLK = 0x0206;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;
    const int WM_XBUTTONUP = 0x020C;
    const int WM_MOUSEHWHEEL = 0x020E;

    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long NowMs() { return _clock.ElapsedMilliseconds; }

    // Only react inside the embedded LCD while OUR window is the foreground root.
    // GetAncestor(GA_ROOT) covers Chromium child windows and the Qt framebuffer.
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || _host == IntPtr.Zero) return false;
        // HWNDs get recycled. If "our" host is gone (or now belongs to another process)
        // the hook must not swallow anything -- otherwise right click / wheel silently
        // stop working in whichever app inherited the handle.
        if (!IsWindow(_host)) return false;
        if (_appPid != 0 && _hostPid != 0 && _hostPid != _appPid) return false;
        if (GetAncestor(fg, 2) != _host) return false;   // 2 = GA_ROOT
        IntPtr e = _emu;
        if (e != IntPtr.Zero && GetWindowRect(e, out r))
        {
            // Qt keeps an 8px grey pad around the real LCD; embed() pushes it out.
            return pt.X >= r.L + 8 && pt.X <= r.R - 8 && pt.Y >= r.T + 8 && pt.Y <= r.B - 8;
        }
        // Before embed (or if FindEmulator failed) fall back to the host window
        // minus its 38px title bar. Approximate on HiDPI, but only a fallback.
        if (!GetWindowRect(_host, out r)) return false;
        return pt.X >= r.L + 4 && pt.X <= r.R - 4 && pt.Y >= r.T + 40 && pt.Y <= r.B - 4;
    }

    static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

    static void PushWheel(int dx, int dy, POINT pt, RECT r)
    {
        int w = r.R - r.L - 16, h = r.B - r.T - 16;
        double nx = w > 0 ? (pt.X - r.L - 8.0) / w : 0.5;
        double ny = h > 0 ? (pt.Y - r.T - 8.0) / h : 0.5;
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) _wheelFirst = now;
            _wheelDx += dx;
            _wheelDy += dy;
            _wheelNx = nx;
            _wheelNy = ny;
            _wheelLast = now;
        }
    }

    // Drained from the socket loop. Emit after 60ms of quiet, but never let a
    // continuous spin starve the queue (hard cap 90ms from the first notch).
    static void FlushWheel(bool force)
    {
        int dx = 0, dy = 0;
        double nx = 0.5, ny = 0.5;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) return;
            if (!force && now - _wheelLast < 60 && now - _wheelFirst < 90) return;
            dx = _wheelDx; dy = _wheelDy; nx = _wheelNx; ny = _wheelNy;
            _wheelDx = 0; _wheelDy = 0;
        }
        _events.Enqueue("{\"ev\":\"wheel\",\"dx\":" + dx + ",\"dy\":" + dy
            + ",\"nx\":" + Num(nx) + ",\"ny\":" + Num(ny) + "}");
    }

    static void ResetWheel()
    {
        lock (_wheelLock) { _wheelDx = 0; _wheelDy = 0; }
    }

    // The callback must stay microscopic: Windows synchronously waits for it on
    // EVERY mouse event of EVERY process. Anything not one of our 7 messages
    // (including all left-button events) is a single CallNextHookEx.
    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            bool right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK;
            bool wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
            bool xbut = msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP;
            if (!right && !wheel && !xbut) return CallNextHookEx(_hook, nCode, wParam, lParam);
            if ((right && _optRight == 0) || (wheel && _optWheel == 0) || (xbut && _optSide == 0))
                return CallNextHookEx(_hook, nCode, wParam, lParam);

            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT r;
            if (!InOurLcd(d.Pt, out r)) return CallNextHookEx(_hook, nCode, wParam, lParam);

            if (right)
            {
                // Qt maps a right click to a plain finger tap: swallow it, emit BACK.
                if (msg == WM_RBUTTONDOWN) _events.Enqueue("{\"ev\":\"back\"}");
                return (IntPtr)1;
            }
            if (wheel)
            {
                int delta = (short)((d.MouseData >> 16) & 0xFFFF);
                if (msg == WM_MOUSEWHEEL) PushWheel(0, delta, d.Pt, r);
                else PushWheel(delta, 0, d.Pt, r);
                return (IntPtr)1;
            }
            if (msg == WM_XBUTTONDOWN)
            {
                int button = (d.MouseData >> 16) & 0xFFFF;
                _events.Enqueue(button == 1 ? "{\"ev\":\"back\"}" : "{\"ev\":\"forward\"}");
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    // A WH_MOUSE_LL hook is global: Windows synchronously waits for this callback on
    // EVERY mouse event of EVERY application. It must therefore live on a thread whose
    // only job is pumping messages. Installing it on the socket-serving thread (which
    // used to block up to 4s in Poll) made the whole desktop pointer lag and drift.
    // It is scoped now: JS installs it only while an app window is foreground, and
    // the callback ignores events outside the embedded LCD.
    static void HookThreadProc()
    {
        _hookTid = GetCurrentThreadId();
        _hookProc = HookCallback;
        _hook = SetWindowsHookEx(14, _hookProc, IntPtr.Zero, 0);
        _hookReady.Set();
        MSG m;
        while (_hookRun && GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _hookTid = 0;
    }

    static void HookOn()
    {
        if (_hookThread != null && _hookThread.IsAlive) return;
        _hookRun = true;
        _hookReady.Reset();
        _hookThread = new Thread(HookThreadProc);
        _hookThread.IsBackground = true;
        _hookThread.Start();
        // Reply must reflect the real hook state; otherwise the JS side sees
        // hooked:false and thinks enabling failed.
        _hookReady.WaitOne(1000);
    }
    static void HookOff()
    {
        _hookRun = false;
        _optRight = 0; _optWheel = 0; _optSide = 0;
        ResetWheel();
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        if (_hookTid != 0) PostThreadMessage(_hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        _hookThread = null;
        // _hookProc mantiene la referencia a propósito: el hilo del gancho puede estar ejecutando el callback, y ponerlo en null antes
        // haría que el GC recogiera el delegado. Al salir el hilo se libera solo.
    }

    // ------------------------------------------------------------------ plumbing
    static void Pump()
    {
        MSG m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static long L(string line, string key)
    {
        string pat = "\"" + key + "\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = line.IndexOf(':', i + pat.Length);
        if (i < 0) return 0;
        i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\"')) i++;
        int j = i;
        while (j < line.Length && (char.IsDigit(line[j]) || line[j] == '-')) j++;
        long v;
        return long.TryParse(line.Substring(i, j - i), out v) ? v : 0;
    }

    static string S(string line, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return "";
        i += pat.Length;
        int j = line.IndexOf('"', i);
        return j < 0 ? "" : line.Substring(i, j - i);
    }

    // Convierte "0x1A2B3C" / "17158972" en un HWND. Un backend de terceros (MuMu) informa cadenas hexadecimales,
    // y nuestros propios llamadores pueden dar decimales; hay que aceptar ambos.
    static IntPtr ParseHwnd(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return IntPtr.Zero;
        string s = raw.Trim();
        long v = 0;
        try
        {
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                v = Convert.ToInt64(s.Substring(2), 16);
            }
            else if (long.TryParse(s, out v))
            {
                // Decimal es decimal
            }
            else
            {
                v = Convert.ToInt64(s, 16);
            }
        }
        catch { return IntPtr.Zero; }
        if (v <= 0) return IntPtr.Zero;
        return new IntPtr(v);
    }

    static void Reply(Socket s, string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            s.Send(b);
        }
        catch { }
    }

    public static void Serve(int port)
    {
        // per-monitor v2 (Win10 1703+); si falla, system-aware
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        TcpListener l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        int actual = ((IPEndPoint)l.LocalEndpoint).Port;
        Console.WriteLine("PORT=" + actual);
        Console.Out.Flush();
        Socket sock;
        try { sock = l.AcceptSocket(); }
        catch { return; }
        l.Stop();

        StringBuilder rx = new StringBuilder();
        byte[] buf = new byte[8192];
        bool run = true;
        while (run)
        {
            Pump();
            FlushWheel(false);

            string ev;
            while (_events.TryDequeue(out ev))
                Reply(sock, "{\"ev\":\"" + ev + "\"}");

            // The Qt tool rail can re-appear right after embedding. Sweep only for the
            // first few seconds after an embed, then stop: a permanent 2s EnumWindows +
            // SetWindowPos loop is pure overhead and competes with the foreground app.
            long now = Environment.TickCount;
            if (_embedAt != 0 && now - _embedAt < 8000 && now - _lastToolSweep > 1500)
            {
                _lastToolSweep = now;
                HideToolWindows();
                Raise();
            }
            if (_embedAt != 0 && now - _embedAt >= 8000) _embedAt = 0;

            // Supresión persistente: ventana principal del emulador / barra de herramientas / consolas negras de qemu·netsimd.
            // Cada ronda enumera varias veces todas las ventanas del escritorio y cuesta bastante: antes, una ronda cada 120 ms durante 90 s
            // ralentizaba visiblemente el equipo (usuarios reportaban «todo el sistema va lento»). En realidad, una vez incrustada la ventana
            // no hace falta tanta frecuencia: 250 ms los primeros 10 s del arranque para atrapar parpadeos y luego 1500 ms como respaldo.
            // En modo juego (_perfMode) baja a 3000 ms, dejando toda la CPU al renderizado de Android.
            long sweepGap;
            if (_perfMode) sweepGap = (now - _bootHideStart < 10000) ? 300 : 3000;
            else sweepGap = (now - _bootHideStart < 10000) ? 250 : 1500;
            if (_quiet && now - _bootHideSweep > sweepGap)
            {
                _bootHideSweep = now;
                QuietSweep();
            }

            // Canal de alta frecuencia exclusivo para consolas negras (solo los primeros 15 s y solo enumerando ventanas tipo consola).
            // Por qué: cuando emulator inicia qemu, Windows crea una ventana de consola nueva
            // cuyo proceso es conhost / WindowsTerminal; IsOurs da false y solo se puede reconocer
            // con el «título = nuestra ruta del runtime» de IsOurConsole. Estas ventanas solo son visibles
            // 200–300 ms y la revisión principal de 250 ms puede no verlas: el usuario ve
            // un parpadeo negro al arrancar. Aquí, una ronda cada 100 ms la atrapa seguro antes de que desaparezca.
            if (_quiet && now - _bootHideStart < 15000
                && now - _consoleSweep > (_perfMode ? 200 : 100))
            {
                _consoleSweep = now;
                HideConsoleWindows();
            }

            try
            {
                // La conexión se cortó (LanzadorAPK salió / falló inesperadamente): no se termina de inmediato.
                // El emulador puede seguir arrancando y Qt mostrar la ventana decenas de segundos después; si para entonces
                // no hay ningún agente vigilando, queda una ventana negra de Android Emulator en el escritorio.
                // Por eso tras desconectarse se sigue «vigilando» un rato, hasta que pase un tiempo sin procesos del emulador.
                if (sock == null)
                {
                    if (Environment.TickCount > _lingerUntil) break;
                    // Si los emuladores ya salieron todos, no hace falta seguir vigilando
                    if (!AnyEmulatorProcess() && FindEmulator() == IntPtr.Zero) break;
                    Thread.Sleep(120);
                    continue;
                }
                // Short poll: keep the message pump responsive even when no command
                // arrives. Never block for seconds while owning window hooks.
                if (!sock.Poll(50, SelectMode.SelectRead)) continue;
                int n = sock.Receive(buf);
                if (n <= 0)
                {
                    try { sock.Close(); } catch { }
                    sock = null;
                    if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                    break;
                }
                rx.Append(Encoding.UTF8.GetString(buf, 0, n));
                while (true)
                {
                    string all = rx.ToString();
                    int nl = all.IndexOf('\n');
                    if (nl < 0) break;
                    string line = all.Substring(0, nl).Trim();
                    rx.Remove(0, nl + 1);
                    if (line.Length == 0) continue;

                    string cmd = S(line, "cmd");
                    if (cmd == "scope")
                    {
                        // Whitelist of "our" directories. Must arrive before boothide /
                        // embed; the sweeps refuse to touch anything outside it.
                        SetScope(S(line, "dirs"));
                        long appPid = L(line, "pid");
                        _appPid = appPid > 0 ? (uint)appPid : 0;
                        _hostPid = 0;
                        Reply(sock, "{\"ok\":true,\"n\":" + _scopeDirs.Count + "}");
                    }
                    else if (cmd == "embed")
                    {
                        // De ventana independiente a incrustado: primero se quita la marca de modo independiente y se restaura la supresión persistente,
                        // si no, la ventana del emulador seguiría tratándose como «la que ve el usuario» y no participaría en Fit.
                        _detachedMode = false;
                        // Incrustar significa «el usuario va a ver la imagen». La supresión no se desactiva (solo oculta ventanas no incrustadas
                        // y consolas negras), pero primero hay que entregar bien la ventana oculta a SetParent,
                        // y luego la muestra el SWP_SHOWWINDOW de Fit.
                        IntPtr want = new IntPtr(L(line, "host"));
                        uint wantPid = 0;
                        if (want != IntPtr.Zero) GetWindowThreadProcessId(want, out wantPid);
                        // Never re-parent into a foreign window: a stale handle could
                        // point at another app (the exact way "LanzadorAPK ate WeChat's
                        // window" can happen).
                        if (want == IntPtr.Zero || (_appPid != 0 && wantPid != _appPid))
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"host-not-ours\"}");
                            Thread.Sleep(1);
                        }
                        else
                        {
                            _host = want;
                            _hostPid = wantPid;
                            _chromeRender = FindChromeRender(want);
                            // Un backend de terceros (MuMu, etc.) nos informa directamente el identificador de la ventana de imagen;
                            // "target" es una lista de candidatos separada por comas; se prueba SetParent con cada uno,
                            // y el primero que realmente queda como hija del anfitrión es el correcto.
                            string targets = S(line, "target");
                            _emu = IntPtr.Zero;
                            if (_quiet) { _quiet = false; _bootHideUntil = 0; }   // No volver a ocultar la ventana que se va a incrustar
                            if (!string.IsNullOrEmpty(targets))
                            {
                                string[] pieces = targets.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                                for (int i = 0; i < pieces.Length; i++)
                                {
                                    IntPtr cand = ParseHwnd(pieces[i]);
                                    if (cand == IntPtr.Zero || !IsWindow(cand)) continue;
                                    // Ventana ya incrustada en nuestro anfitrión (embed repetido / cambio de tamaño): se usa directamente
                                    if (GetParent(cand) == want || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                    Embed(_host, cand);
                                    if (GetParent(cand) == _host || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                }
                            }
                            else
                            {
                                _emu = FindEmulator();
                                Embed(_host, _emu);
                            }
                            bool ok = _emu != IntPtr.Zero
                                && (GetParent(_emu) == _host || GetParent(_emu) == _chromeRender);
                            _embedAt = Environment.TickCount;
                            _lastToolSweep = 0;
                            Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), true, (int)L(line, "clipTop"));
                            Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + ",\"emu\":" + _emu.ToInt64() + "}");
                            // La ventana de un backend de terceros no la creamos nosotros ni se vuelve a mostrar sola:
                            // a cada candidato hay que ponerle WS_VISIBLE; si no, tras SetParent quedaría siempre oculta.
                            if (ok && !string.IsNullOrEmpty(targets)) ShowWindow(_emu, 5);
                        }
                    }
                    else if (cmd == "fit")
                    {
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), false, (int)L(line, "clipTop"));
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "rotate")
                    {
                        Rotate(S(line, "dir"));
                        Thread.Sleep(350);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hide")
                    {
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 0);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "perf")
                    {
                        // JS avisa según priorityMode: en modo juego se reduce la frecuencia del escaneo de ventanas
                        _perfMode = L(line, "on") != 0;
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "show")
                    {
                        // En modo de ventana independiente Detach() vacía _emu (lo trata como «fin de la incrustación»),
                        // así que aquí hay que volver a buscarla; si no, show/layout actuarían sobre un identificador vacío,
                        // con el síntoma «tras cambiar a ventana independiente desaparece la ventana del emulador».
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        // Si estaba minimizada (botón «Minimizar» de la barra de controles) SW_SHOW no la restaura: hace falta SW_RESTORE
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, IsIconic(_emu) ? 9 : 5);
                        Reply(sock, "{\"ok\":" + (_emu != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "detach")
                    {
                        // keep=1 significa «cambiar a modo de ventana independiente»: no tratarlo como
                        // «fin de la incrustación, hay que ocultar el emulador»; si no, QuietSweep ocultaría
                        // en la siguiente ronda la ventana que el usuario está viendo.
                        _detachedMode = L(line, "keep") == 1;
                        // El modo independiente puede no haber hecho nunca embed (_emu sigue en 0); primero se busca,
                        // si no, Detach haría return y show/layout actuarían sobre un identificador vacío.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Detach();
                        Reply(sock, "{\"ok\":true,\"emu\":" + _emu.ToInt64() + "}");
                    }
                    else if (cmd == "title")
                    {
                        // Cambia el título de la ventana nativa del emulador de "Android Emulator - lanzadorapk:5554"
                        // a un nombre comprensible para el usuario (por defecto "Lanzador APK"). Qt lo devuelve al recrear la ventana,
                        // así que QuietSweep lo vuelve a fijar en cada revisión (ver abajo).
                        string t = S(line, "text");
                        if (t.Length == 0) t = "Lanzador APK";
                        _ourTitle = t;
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = _emu != IntPtr.Zero && SetWindowTextW(_emu, t);
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "icon")
                    {
                        // Fija el icono de la ventana nativa del emulador (en modo independiente, la barra de tareas/Alt+Tab muestran el icono de la app actual,
                        // no el robot verde por defecto del emulador de Google). Recibe la ruta absoluta de un ICO/PNG.
                        string f = S(line, "file");
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = false;
                        if (f.Length > 0 && System.IO.File.Exists(f))
                        {
                            // Identificador de icono en caché: al cambiar de app se libera el anterior y se carga el nuevo; la revisión usa directamente la caché,
                            // sin LoadImage en cada ronda (eso sería E/S de disco + fuga de objetos GDI).
                            if (!String.Equals(f, _ourIconFile, StringComparison.OrdinalIgnoreCase))
                            {
                                if (_ourIconSmall != IntPtr.Zero) DestroyIcon(_ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) DestroyIcon(_ourIconBig);
                                _ourIconSmall = LoadImageW(IntPtr.Zero, f, 1, 32, 32, 0x10);
                                _ourIconBig = LoadImageW(IntPtr.Zero, f, 1, 64, 64, 0x10);
                                if (_ourIconSmall == IntPtr.Zero) _ourIconSmall = _ourIconBig;
                                if (_ourIconBig == IntPtr.Zero) _ourIconBig = _ourIconSmall;
                                _ourIconFile = f;
                            }
                            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero))
                            {
                                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
                                ok = true;
                            }
                        }
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "layout")
                    {
                        // Modo de ventana independiente: la ventana del emulador es una ventana nativa del sistema; aquí solo se coloca
                        // en el rectángulo de pantalla indicado (sin SetParent). Orientación/escalado/entrada los gestiona ella,
                        // así que no aparecen los bordes negros, coordenadas desplazadas ni la falta de llenado del modo incrustado.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu == IntPtr.Zero)
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"no-emu\"}");
                        }
                        else
                        {
                            // Primero se asegura que sea una ventana visible de nivel superior (Detach ya quitó WS_CHILD)
                            ShowWindow(_emu, 5);
                            SetWindowPos(_emu, HWND_TOP,
                                (int)L(line, "x"), (int)L(line, "y"),
                                (int)L(line, "w"), (int)L(line, "h"),
                                SWP_SHOWWINDOW);
                            Reply(sock, "{\"ok\":true}");
                        }
                    }
                    else if (cmd == "hook")
                    {
                        // Options are re-sent on every enable, so changing settings
                        // while the hook is live needs no reinstall / no thread churn.
                        _optRight = L(line, "right") == 1 ? 1 : 0;
                        _optWheel = L(line, "wheel") == 1 ? 1 : 0;
                        _optSide = L(line, "side") == 1 ? 1 : 0;
                        if (L(line, "on") == 1) HookOn(); else HookOff();
                        Reply(sock, "{\"ok\":true,\"hooked\":" + (_hook != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "minimize")
                    {
                        // Minimiza a la barra de tareas (a diferencia de hide, que la oculta del todo y solo se recupera desde la bandeja)
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 6);
                        Reply(sock, "{\"ok\":" + (_emu != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "track")
                    {
                        // Para la barra de controles flotante: dónde está la ventana del emulador y si se está usando.
                        // fg=1 si el primer plano es el emulador o la propia barra (bar = su HWND), para ocultar la barra
                        // cuando el usuario pasa a otro programa.
                        IntPtr e = _emu != IntPtr.Zero && IsWindow(_emu) ? _emu : FindEmulator();
                        long bar = L(line, "bar");
                        RECT r = new RECT();
                        bool vis = false, icon = false, fgOk = false;
                        if (e != IntPtr.Zero)
                        {
                            GetWindowRect(e, out r);
                            vis = IsWindowVisible(e);
                            icon = IsIconic(e);
                            IntPtr fg = GetForegroundWindow();
                            if (fg != IntPtr.Zero)
                            {
                                IntPtr root = GetAncestor(fg, 2);
                                fgOk = fg == e || root == e || (bar != 0 && (fg.ToInt64() == bar || root.ToInt64() == bar));
                            }
                        }
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64()
                            + ",\"x\":" + r.L + ",\"y\":" + r.T
                            + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T)
                            + ",\"visible\":" + (vis ? "true" : "false")
                            + ",\"iconic\":" + (icon ? "true" : "false")
                            + ",\"fg\":" + (fgOk ? "true" : "false") + "}");
                    }
                    else if (cmd == "probe")
                    {
                        IntPtr e = FindEmulator();
                        RECT r = new RECT();
                        if (e != IntPtr.Zero) GetWindowRect(e, out r);
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64()
                            + ",\"x\":" + r.L + ",\"y\":" + r.T
                            + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
                    }
                    else if (cmd == "winready")
                    {
                        // Control de «listo» para backends de terceros: los identificadores candidatos existen + el estado es «existe».
                        // La comprobación de oculta se hace en JS (ver windowReady en backends/mumu.js).
                        string list = S(line, "target");
                        int alive = 0;
                        string first = "";
                        if (!string.IsNullOrEmpty(list))
                        {
                            string[] pieces = list.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                            for (int i = 0; i < pieces.Length; i++)
                            {
                                IntPtr h = ParseHwnd(pieces[i]);
                                if (h == IntPtr.Zero || !IsWindow(h)) continue;
                                alive++;
                                if (first.Length == 0) first = pieces[i];
                            }
                        }
                        Reply(sock, "{\"ok\":true,\"alive\":" + alive + ",\"first\":\"" + first + "\"}");
                    }
                    else if (cmd == "consoles")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListConsoles() + "]}");
                    }
                    else if (cmd == "windows")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListWindows(L(line, "all") == 1) + "]}");
                    }
                    else if (cmd == "boothide")
                    {
                        if (L(line, "on") == 1)
                        {
                            _quiet = true;
                            _bootHideSweep = 0;
                            _consoleSweep = 0;
                            _bootHideStart = Environment.TickCount;
                            SnapshotConsoles();
                            QuietSweep();
                        }
                        else
                        {
                            // Se deja la ventana como está y solo se vuelven a suprimir las consolas negras (desactivar quiet normalmente es porque
                            // el usuario quiere ver la ventana del emulador; ver la opción startVisible).
                            _quiet = false;
                            HideConsoleWindows();
                        }
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "park")
                    {
                        // La ventana de la app se va a cerrar: primero se desprende la ventana del emulador del anfitrión y se oculta,
                        // para que al destruir el anfitrión Windows no la vuelva a colgar del escritorio como ventana visible de nivel superior
                        // (de ahí venía la «ventana negra de Android Emulator que aparece de la nada» que veía el usuario).
                        _quiet = true;
                        _bootHideStart = Environment.TickCount;
                        _bootHideSweep = 0;
                        ParkEmulator();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "quit")
                    {
                        Reply(sock, "{\"ok\":true}");
                        run = false;
                        break;
                    }
                    else
                    {
                        Reply(sock, "{\"ok\":false,\"error\":\"unknown\"}");
                    }
                }
            }
            catch (SocketException)
            {
                try { sock.Close(); } catch { }
                sock = null;
                if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                break;
            }
            catch (Exception) { }
        }
        HookOff();
        try { sock.Close(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $src
[ApkAgent]::Serve($Port)
