using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("DeepSeek Harness — Русский язык")]
[assembly: AssemblyDescription("Unofficial community Russian localization")]
[assembly: AssemblyCompany("Community")]
[assembly: AssemblyProduct("DeepSeek Harness RU Launcher")]
[assembly: AssemblyCopyright("Unofficial community Russian localization")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace DeepSeekHarnessRu
{
    internal static class Program
    {
        private const string ResourceName = "DeepSeekHarnessRu.payload.zip";
        private const string InstallerRelativePath = "tools/installer.mjs";

        [STAThread]
        private static int Main(string[] args)
        {
            HeadlessOptions options;
            string parseError;
            if (TryParseHeadless(args, out options, out parseError))
                return RunHeadless(options);
            if (!String.IsNullOrEmpty(parseError))
            {
                Console.Error.WriteLine(parseError);
                return 2;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
            return 0;
        }

        private static bool TryParseHeadless(string[] args, out HeadlessOptions options, out string error)
        {
            options = null;
            error = null;
            if (args == null || args.Length == 0) return false;
            HeadlessOptions parsed = new HeadlessOptions();
            int modeCount = 0;
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--check") { parsed.Action = "check"; modeCount++; }
                else if (arg == "--install") { parsed.Action = "install"; modeCount++; }
                else if (arg == "--uninstall") { parsed.Action = "uninstall"; modeCount++; }
                else if (arg == "--self-test") { parsed.SelfTest = true; modeCount++; }
                else if (arg == "--install-dir" || arg == "--dsh-home" || arg == "--log")
                {
                    if (i + 1 >= args.Length) { error = "Для параметра " + arg + " нужно указать значение."; return false; }
                    string value = args[++i];
                    if (arg == "--install-dir") parsed.InstallDir = value;
                    else if (arg == "--dsh-home") parsed.DshHome = value;
                    else parsed.LogPath = value;
                }
                else { error = "Неизвестный параметр: " + arg; return false; }
            }
            if (modeCount == 0) return false;
            if (modeCount != 1) { error = "Укажите только один режим: --check, --install, --uninstall или --self-test."; return false; }
            if (String.IsNullOrWhiteSpace(parsed.LogPath)) { error = "Для командного режима обязателен параметр --log <файл>."; return false; }
            if (!parsed.SelfTest && (String.IsNullOrWhiteSpace(parsed.InstallDir) || String.IsNullOrWhiteSpace(parsed.DshHome)))
            { error = "Укажите --install-dir и --dsh-home."; return false; }
            options = parsed;
            return true;
        }

        private static int RunHeadless(HeadlessOptions options)
        {
            StreamWriter log = null;
            try
            {
                string fullLog = Path.GetFullPath(options.LogPath);
                string parent = Path.GetDirectoryName(fullLog);
                if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                log = new StreamWriter(fullLog, false, new UTF8Encoding(false));
                log.AutoFlush = true;
                if (options.SelfTest)
                {
                    string extracted = null;
                    try
                    {
                        extracted = ExtractPayload();
                        string installer = Path.Combine(extracted, InstallerRelativePath.Replace('/', Path.DirectorySeparatorChar));
                        bool exists = File.Exists(installer);
                        log.WriteLine("{\"status\":\"" + (exists ? "ok" : "error") + "\",\"payloadExtracted\":true,\"installerPresent\":" + (exists ? "true" : "false") + "}");
                        return exists ? 0 : 1;
                    }
                    catch (Exception ex)
                    {
                        log.WriteLine("{\"status\":\"error\",\"payloadExtracted\":false,\"installerPresent\":false,\"message\":\"" + JsonEscape(ex.Message) + "\"}");
                        return 1;
                    }
                    finally { TryDeleteDirectory(extracted); }
                }
                object logLock = new object();
                int exitCode = RunOperation(options.Action, options.InstallDir, options.DshHome, delegate(string line)
                {
                    lock (logLock) log.WriteLine(line);
                }, false);
                return exitCode;
            }
            catch (Exception ex)
            {
                if (log != null) log.WriteLine("Ошибка: " + ex.Message);
                else Console.Error.WriteLine(ex.Message);
                return 1;
            }
            finally { if (log != null) log.Dispose(); }
        }

        private static int RunOperation(string action, string installDir, string dshHome, Action<string> writeLine, bool showProcessWarning)
        {
            if (!String.Equals(action, "check", StringComparison.OrdinalIgnoreCase) && IsHarnessRunning())
            {
                const string message = "Закройте DeepSeek Harness перед установкой или удалением перевода. Приложение не будет закрыто автоматически.";
                writeLine(message);
                if (showProcessWarning)
                    MessageBox.Show(message, "DeepSeek Harness RU", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 3;
            }

            string node = Path.Combine(installDir, "resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
            if (!File.Exists(node))
            {
                writeLine("Не найден встроенный Node.js: " + node);
                return 1;
            }

            string extracted = null;
            try
            {
                extracted = ExtractPayload();
                string installer = Path.Combine(extracted, InstallerRelativePath.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(installer))
                {
                    writeLine("В payload отсутствует " + InstallerRelativePath + ".");
                    return 1;
                }

                List<string> command = new List<string>();
                command.Add(QuoteArgument(installer));
                command.Add(action);
                command.Add("--install-dir");
                command.Add(QuoteArgument(Path.GetFullPath(installDir)));
                command.Add("--dsh-home");
                command.Add(QuoteArgument(Path.GetFullPath(dshHome)));
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = node;
                start.Arguments = String.Join(" ", command.ToArray());
                start.WorkingDirectory = extracted;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = new UTF8Encoding(false);
                start.StandardErrorEncoding = new UTF8Encoding(false);

                using (Process process = new Process())
                {
                    process.StartInfo = start;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) writeLine(e.Data); };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) writeLine("[stderr] " + e.Data); };
                    writeLine("Запуск: " + action);
                    if (!process.Start()) { writeLine("Не удалось запустить установщик."); return 1; }
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();
                    process.WaitForExit();
                    int result = process.ExitCode;
                    writeLine("Операция завершена. Код: " + result.ToString());
                    return result;
                }
            }
            catch (Exception ex)
            {
                writeLine("Ошибка: " + ex.Message);
                return 1;
            }
            finally { TryDeleteDirectory(extracted); }
        }

        private static string ExtractPayload()
        {
            string destination = Path.Combine(Path.GetFullPath(Path.GetTempPath()), "DeepSeekHarnessRu-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(destination);
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
                {
                    if (stream == null) throw new InvalidOperationException("В EXE не встроен payload.zip.");
                    using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read, false))
                    {
                        string root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                            string target = Path.GetFullPath(Path.Combine(destination, relative));
                            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidDataException("Недопустимый путь в payload.");
                            if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
                            string directory = Path.GetDirectoryName(target);
                            if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                            using (Stream input = entry.Open())
                            using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                                input.CopyTo(output);
                        }
                    }
                }
                return destination;
            }
            catch { TryDeleteDirectory(destination); throw; }
        }

        private static bool IsHarnessRunning()
        {
            try { return Process.GetProcessesByName("DeepSeek Harness").Length > 0; }
            catch { return false; }
        }

        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '\\') { slashes++; continue; }
                if (c == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes);
                slashes = 0;
                result.Append(c);
            }
            result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static void TryDeleteDirectory(string path)
        {
            if (String.IsNullOrEmpty(path)) return;
            try
            {
                string fullPath = Path.GetFullPath(path);
                string tempPath = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string parent = Path.GetDirectoryName(fullPath);
                string name = Path.GetFileName(fullPath);
                const string prefix = "DeepSeekHarnessRu-";
                Guid id;
                if (parent == null || !String.Equals(Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), tempPath, StringComparison.OrdinalIgnoreCase)) return;
                if (!name.StartsWith(prefix, StringComparison.Ordinal) || name.Length != prefix.Length + 32) return;
                string suffix = name.Substring(prefix.Length);
                if (!Guid.TryParseExact(suffix, "N", out id) || !String.Equals(id.ToString("N"), suffix, StringComparison.OrdinalIgnoreCase)) return;
                if (Directory.Exists(fullPath)) Directory.Delete(fullPath, true);
            }
            catch { }
        }

        private static string JsonEscape(string value)
        {
            if (value == null) return "";
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t");
        }

        private sealed class HeadlessOptions
        {
            public string Action;
            public string InstallDir;
            public string DshHome;
            public string LogPath;
            public bool SelfTest;
        }

        private sealed class LauncherForm : Form
        {
            private readonly TextBox installPath;
            private readonly TextBox dshPath;
            private readonly TextBox log;
            private readonly Button browseInstall;
            private readonly Button browseDsh;
            private readonly Button checkButton;
            private readonly Button installButton;
            private readonly Button uninstallButton;
            private readonly Label status;
            private bool busy;

            public LauncherForm()
            {
                Text = "DeepSeek Harness — Русский язык";
                StartPosition = FormStartPosition.CenterScreen;
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false;
                MinimizeBox = true;
                ClientSize = new Size(590, 438);
                Font = new Font("Segoe UI", 9F);
                BackColor = Color.FromArgb(247, 248, 250);

                Label title = new Label();
                title.Text = "Русификатор DeepSeek Harness";
                title.Font = new Font("Segoe UI Semibold", 15F, FontStyle.Bold);
                title.ForeColor = Color.FromArgb(30, 41, 59);
                title.Location = new Point(20, 16);
                title.Size = new Size(530, 31);
                Controls.Add(title);

                Label subtitle = new Label();
                subtitle.Text = "Выберите папки и выполните нужное действие. Версия 0.1.7-rc.2 · Windows x64";
                subtitle.ForeColor = Color.FromArgb(100, 116, 139);
                subtitle.Location = new Point(22, 49);
                subtitle.Size = new Size(530, 22);
                Controls.Add(subtitle);

                Controls.Add(MakeLabel("Папка DeepSeek Harness", 22, 85));
                installPath = MakeTextBox(DefaultInstallDir(), 22, 108, 472);
                Controls.Add(installPath);
                browseInstall = MakeButton("Обзор…", 502, 106, 66, 29);
                browseInstall.Click += delegate { Browse(installPath, "Выберите папку DeepSeek Harness"); };
                Controls.Add(browseInstall);

                Controls.Add(MakeLabel("Папка данных Harness", 22, 151));
                dshPath = MakeTextBox(DefaultDshHome(), 22, 174, 472);
                Controls.Add(dshPath);
                browseDsh = MakeButton("Обзор…", 502, 172, 66, 29);
                browseDsh.Click += delegate { Browse(dshPath, "Выберите папку DSH home"); };
                Controls.Add(browseDsh);

                checkButton = MakeButton("Проверить", 22, 219, 112, 34);
                installButton = MakeButton("Установить русский", 143, 219, 170, 34);
                uninstallButton = MakeButton("Удалить перевод", 322, 219, 150, 34);
                checkButton.Click += delegate { StartAction("check"); };
                installButton.Click += delegate { StartAction("install"); };
                uninstallButton.Click += delegate { StartAction("uninstall"); };
                Controls.Add(checkButton);
                Controls.Add(installButton);
                Controls.Add(uninstallButton);

                status = new Label();
                status.Text = "Готово";
                status.ForeColor = Color.FromArgb(71, 85, 105);
                status.Location = new Point(22, 261);
                status.Size = new Size(540, 22);
                Controls.Add(status);

                Label logTitle = MakeLabel("Журнал", 22, 288);
                Controls.Add(logTitle);
                log = new TextBox();
                log.Multiline = true;
                log.ReadOnly = true;
                log.ScrollBars = ScrollBars.Vertical;
                log.WordWrap = false;
                log.BackColor = Color.White;
                log.Font = new Font("Consolas", 8.5F);
                log.Location = new Point(22, 311);
                log.Size = new Size(546, 108);
                Controls.Add(log);
            }

            private static string DefaultInstallDir()
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(local, "Programs", "DeepSeek Harness");
            }

            private static string DefaultDshHome()
            {
                string fromEnvironment = Environment.GetEnvironmentVariable("DSH_HOME");
                if (!String.IsNullOrWhiteSpace(fromEnvironment)) return fromEnvironment;
                string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                return Path.Combine(profile, ".dsh");
            }

            private static Label MakeLabel(string text, int x, int y)
            {
                Label label = new Label();
                label.Text = text;
                label.ForeColor = Color.FromArgb(51, 65, 85);
                label.Location = new Point(x, y);
                label.Size = new Size(300, 20);
                return label;
            }

            private static TextBox MakeTextBox(string value, int x, int y, int width)
            {
                TextBox box = new TextBox();
                box.Text = value;
                box.Location = new Point(x, y);
                box.Size = new Size(width, 25);
                box.BorderStyle = BorderStyle.FixedSingle;
                return box;
            }

            private static Button MakeButton(string text, int x, int y, int width, int height)
            {
                Button button = new Button();
                button.Text = text;
                button.Location = new Point(x, y);
                button.Size = new Size(width, height);
                button.FlatStyle = FlatStyle.System;
                return button;
            }

            private static void Browse(TextBox target, string description)
            {
                using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                {
                    dialog.Description = description;
                    dialog.ShowNewFolderButton = true;
                    if (Directory.Exists(target.Text)) dialog.SelectedPath = target.Text;
                    if (dialog.ShowDialog() == DialogResult.OK) target.Text = dialog.SelectedPath;
                }
            }

            private void StartAction(string action)
            {
                if (busy) return;
                string install = installPath.Text.Trim();
                string dsh = dshPath.Text.Trim();
                if (String.IsNullOrWhiteSpace(install) || String.IsNullOrWhiteSpace(dsh))
                {
                    MessageBox.Show(this, "Укажите обе папки.", "DeepSeek Harness RU", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                SetBusy(true);
                status.Text = "Выполняется: " + action + "…";
                AppendLog("--- " + DateTime.Now.ToString("HH:mm:ss") + " / " + action + " ---");
                ThreadPool.QueueUserWorkItem(delegate
                {
                    int result = RunOperation(action, install, dsh, AppendLog, true);
                    if (!IsDisposed && IsHandleCreated)
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            SetBusy(false);
                            status.Text = result == 0 ? "Готово" : "Завершено с кодом " + result.ToString();
                        });
                    }
                });
            }

            private void AppendLog(string line)
            {
                if (IsDisposed || !IsHandleCreated) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (IsDisposed) return;
                        log.AppendText(line + Environment.NewLine);
                    });
                }
                catch (InvalidOperationException) { }
            }

            private void SetBusy(bool value)
            {
                busy = value;
                installPath.Enabled = !value;
                dshPath.Enabled = !value;
                browseInstall.Enabled = !value;
                browseDsh.Enabled = !value;
                checkButton.Enabled = !value;
                installButton.Enabled = !value;
                uninstallButton.Enabled = !value;
                UseWaitCursor = value;
            }
        }
    }
}
