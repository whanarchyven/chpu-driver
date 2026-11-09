using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace CncAgent
{
    public sealed class Config
    {
        public string BaseUrl = "http://127.0.0.1:3221";
        public string Token = "";
        public string MachineId = Environment.MachineName;
        // syntec | fake | folder | ftp
        public string Link = "syntec";
        public string CncIp = "";
        public int CncTimeoutMs = 5000;
        // auto | 10.118 | v4 (see SyntecLibrary)
        public string SyntecLib = "auto";
        public double PollSec = 2;
        public bool AutoSelectMain = true;
        public int DeliverAhead = 3;
        // folder: UNC or local path; ftp: ftp://host/dir. For syntec: optional fallback delivery
        // into the controller's shared NcFiles folder when the Remote API refuses a file.
        public string RemoteDir = "";
        public string FtpUser = "";
        public string FtpPassword = "";
        public string FakeDir = "fake-cnc";
        public double FakeAutoStartSec = 0;
        public double FakeLinesPerSec = 200;

        public static string Dir => AppDomain.CurrentDomain.BaseDirectory;

        public static Config Load(string path)
        {
            var config = new Config();
            if (!File.Exists(path)) return config;
            var raw = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
            if (raw == null) return config;
            foreach (var field in typeof(Config).GetFields())
            {
                if (!raw.TryGetValue(field.Name, out var value) || value == null) continue;
                try
                {
                    field.SetValue(config, Convert.ChangeType(value, field.FieldType, System.Globalization.CultureInfo.InvariantCulture));
                }
                catch (Exception e)
                {
                    Log.Write($"конфиг: поле {field.Name} пропущено ({e.Message})");
                }
            }
            config.BaseUrl = config.BaseUrl.TrimEnd('/');
            return config;
        }

        public string FullPath(string relative) => Path.IsPathRooted(relative) ? relative : Path.Combine(Dir, relative);
    }

    public static class Log
    {
        static readonly object Gate = new object();
        static readonly Queue<string> Tail = new Queue<string>();
        static string _path;

        public static void Init(string path) => _path = path;

        public static void Write(string text)
        {
            var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {text}";
            lock (Gate)
            {
                Console.WriteLine(line);
                Tail.Enqueue(line);
                while (Tail.Count > 30) Tail.Dequeue();
                if (_path == null) return;
                try
                {
                    var info = new FileInfo(_path);
                    if (info.Exists && info.Length > 5 * 1024 * 1024) File.Move(_path, _path + "." + DateTime.Now.ToString("yyyyMMddHHmmss"));
                    File.AppendAllText(_path, line + Environment.NewLine);
                }
                catch
                {
                    // Logging must never stop the agent.
                }
            }
        }

        public static string[] Recent()
        {
            lock (Gate) return Tail.ToArray();
        }
    }
}
