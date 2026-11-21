// TupraQ.exe - self-contained app. Unpacks the bundled engine (Node runtime + app files + WebView2 SDK)
// to %LOCALAPPDATA%\TupraQ\app, starts the engine hidden, and shows the UI in TupraQ's OWN window
// (WebView2), so Windows treats it as TupraQ - taskbar pinning, icon and name all belong to TupraQ.
// If the WebView2 runtime is missing, it falls back to an Edge/Chrome app window.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("TupraQ")]
[assembly: AssemblyProduct("TupraQ PC Optimizer")]
[assembly: AssemblyDescription("TupraQ PC Optimizer")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

static class Program
{
    static string Root;
    static Process Engine;
    static string Url, Token;
    static string RestartVerb; // set by the page: "open" = restart normally, "runas" = restart as administrator

    [STAThread]
    static int Main(string[] args)
    {
        bool restart = Array.IndexOf(args, "--restart") >= 0;
        bool owned;
        Mutex mutex = new Mutex(true, "Local\\TupraQ.App", out owned);
        if (!owned)
        {
            try { owned = mutex.WaitOne(restart ? 10000 : 0); } catch (AbandonedMutexException) { owned = true; }
            if (!owned) { ActivateExisting(); return 0; }
        }
        try
        {
            Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TupraQ", "app");
            // Leftover from a self-update: the previous exe was renamed to .old while it was running.
            string oldExe = Assembly.GetExecutingAssembly().Location + ".old";
            for (int i = 0; i < 10 && File.Exists(oldExe); i++) { try { File.Delete(oldExe); } catch { Thread.Sleep(500); } }
            Unpack();
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
            {
                string f = Path.Combine(Root, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(f) ? Assembly.LoadFrom(f) : null;
            };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (!WebViewAvailable())
            {
                // No WebView2 runtime: let the engine open its own Edge/Chrome app window, as before.
                StartEngine(false);
                return 0;
            }
            StartEngine(true);
            if (Url == null) throw new Exception("The TupraQ engine did not start.");
            RunWindow();
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show("TupraQ could not start:\n\n" + e.Message, "TupraQ", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            if (Engine != null && Url != null) { try { if (!Engine.HasExited) { Engine.Kill(); Engine.WaitForExit(3000); } } catch { } }
            if (RestartVerb != null)
            {
                try { mutex.ReleaseMutex(); } catch { }
                try
                {
                    ProcessStartInfo si = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--restart");
                    si.UseShellExecute = true;
                    if (RestartVerb == "runas") si.Verb = "runas";
                    Process.Start(si);
                }
                catch { }
            }
            GC.KeepAlive(mutex);
        }
    }

    static void Unpack()
    {
        Assembly a = Assembly.GetExecutingAssembly();
        string stamp;
        using (StreamReader r = new StreamReader(a.GetManifestResourceStream("stamp.txt"))) stamp = r.ReadToEnd();
        string stampFile = Path.Combine(Root, "stamp.txt");
        if (File.Exists(stampFile) && File.ReadAllText(stampFile) == stamp) return;
        foreach (string name in a.GetManifestResourceNames())
        {
            if (name == "stamp.txt") continue;
            string dest = Path.Combine(Root, name.Replace('/', '\\'));
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            try
            {
                using (Stream s = a.GetManifestResourceStream(name))
                using (FileStream f = File.Create(dest)) s.CopyTo(f);
            }
            catch (IOException) { if (!File.Exists(dest)) throw; }
        }
        File.WriteAllText(stampFile, stamp);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static bool WebViewAvailable()
    {
        try
        {
            Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(Root);
            return !string.IsNullOrEmpty(Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch { return false; }
    }

    static void StartEngine(bool hosted)
    {
        string exe = Assembly.GetExecutingAssembly().Location;
        ProcessStartInfo si = new ProcessStartInfo(Path.Combine(Root, "node.exe"), "\"" + Path.Combine(Root, "server.js") + "\"" + (hosted ? " --no-ui" : ""));
        si.WorkingDirectory = Root;
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        si.RedirectStandardOutput = hosted;
        si.EnvironmentVariables["TQ_EXE"] = exe;
        Engine = Process.Start(si);
        if (!hosted) return;
        Job.Attach(Engine); // engine and its helpers die with this window, even on a crash
        string line = null;
        Thread t = new Thread(() => { try { line = Engine.StandardOutput.ReadLine(); } catch { } });
        t.IsBackground = true; t.Start();
        if (!t.Join(20000) || line == null) return;
        int i = line.IndexOf("http://", StringComparison.Ordinal);
        if (i < 0) return;
        Url = line.Substring(i).Trim();
        int k = Url.IndexOf("?t=", StringComparison.Ordinal);
        Token = k >= 0 ? Url.Substring(k + 3) : "";
        Thread drain = new Thread(() => { try { while (Engine.StandardOutput.ReadLine() != null) { } } catch { } });
        drain.IsBackground = true; drain.Start();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static void RunWindow()
    {
        Color bg = Color.FromArgb(4, 7, 14);
        Form f = new Form();
        f.Text = "TupraQ";
        f.BackColor = bg;
        try { f.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        f.Size = new Size(Math.Min(1280, wa.Width - 40), Math.Min(840, wa.Height - 40));
        f.MinimumSize = new Size(900, 600);
        f.StartPosition = FormStartPosition.CenterScreen;

        Microsoft.Web.WebView2.WinForms.WebView2 wv = new Microsoft.Web.WebView2.WinForms.WebView2();
        wv.Dock = DockStyle.Fill;
        wv.DefaultBackgroundColor = bg;
        f.Controls.Add(wv);

        bool allowClose = false;
        f.Load += async (s, e) =>
        {
            try
            {
                string data = Path.Combine(Path.GetDirectoryName(Root), "webview");
                var opts = new Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
                var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, data, opts);
                await wv.EnsureCoreWebView2Async(env);
                var c = wv.CoreWebView2;
                c.Settings.AreDevToolsEnabled = false;
                c.Settings.AreDefaultContextMenusEnabled = false;
                c.Settings.IsStatusBarEnabled = false;
                c.Settings.IsZoomControlEnabled = false;
                c.Settings.AreBrowserAcceleratorKeysEnabled = false;
                c.WindowCloseRequested += (s2, e2) => { allowClose = true; f.Close(); };
                c.NewWindowRequested += (s2, e2) => { e2.Handled = true; };
                // Messages from the page: restart after a self-update, restart as admin, or open a GitHub page.
                c.WebMessageReceived += (s2, e2) =>
                {
                    string m;
                    try { m = e2.TryGetWebMessageAsString(); } catch { return; }
                    if (m == "restart" || m == "restart-admin")
                    {
                        RestartVerb = m == "restart" ? "open" : "runas";
                        allowClose = true; f.Close();
                    }
                    else if (m != null && m.StartsWith("open:https://github.com/", StringComparison.Ordinal))
                    {
                        try { Process.Start(new ProcessStartInfo(m.Substring(5)) { UseShellExecute = true }); } catch { }
                    }
                };
                c.Navigate(Url);
            }
            catch (Exception ex)
            {
                MessageBox.Show(f, "TupraQ could not open its window:\n\n" + ex.Message, "TupraQ", MessageBoxButtons.OK, MessageBoxIcon.Error);
                allowClose = true; f.Close();
            }
        };
        f.FormClosing += (s, e) =>
        {
            if (allowClose || !TaskRunning()) return;
            DialogResult r = MessageBox.Show(f, "A task is still running. Closing TupraQ will stop it.\n\nClose anyway?", "TupraQ", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r != DialogResult.Yes) e.Cancel = true;
        };
        Application.Run(f);
    }

    static bool TaskRunning()
    {
        try
        {
            Uri u = new Uri(Url);
            WebClient w = new WebClient();
            w.Headers.Add("X-TupraQ-Token", Token);
            string j = w.DownloadString("http://127.0.0.1:" + u.Port + "/api/job?since=999999");
            return j.Contains("\"status\":\"running\"");
        }
        catch { return false; }
    }

    static void ActivateExisting()
    {
        Process me = Process.GetCurrentProcess();
        foreach (Process p in Process.GetProcessesByName(me.ProcessName))
        {
            if (p.Id == me.Id || p.MainWindowHandle == IntPtr.Zero) continue;
            if (IsIconic(p.MainWindowHandle)) ShowWindow(p.MainWindowHandle, 9);
            SetForegroundWindow(p.MainWindowHandle);
            return;
        }
    }

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
}

// Kill-on-close job object: when TupraQ.exe exits for any reason, Windows ends the engine too.
static class Job
{
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXT { public BASIC Basic; public IO Io; public UIntPtr p, q, r, s; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

    static IntPtr handle;
    public static void Attach(Process p)
    {
        try
        {
            if (handle == IntPtr.Zero)
            {
                handle = CreateJobObject(IntPtr.Zero, null);
                EXT info = new EXT();
                info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)));
            }
            AssignProcessToJobObject(handle, p.Handle);
        }
        catch { }
    }
}
