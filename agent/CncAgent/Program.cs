using System;
using System.IO;
using System.Linq;
using System.Threading;

namespace CncAgent
{
    static class Program
    {
        static int Main(string[] args)
        {
            var check = args.Contains("--check");
            var upload = Array.IndexOf(args, "--upload");
            if (upload >= 0)
            {
                if (upload + 1 >= args.Length) { Console.WriteLine("укажите файл: CncAgent.exe --upload <файл.cnc> [cnc-agent.json]"); return 2; }
                var rest = args.Where((a, i) => i != upload && i != upload + 1 && !a.StartsWith("--"));
                return Upload(args[upload + 1], rest.FirstOrDefault() ?? Config.Dir + "cnc-agent.json");
            }
            var configPath = args.FirstOrDefault(a => !a.StartsWith("--")) ?? Config.Dir + "cnc-agent.json";
            if (check) return Check(configPath);
            Log.Init(Config.Dir + "cnc-agent.log");
            using (var mutex = new Mutex(false, @"Global\CncAgent"))
            {
                if (!mutex.WaitOne(0))
                {
                    Log.Write("агент уже запущен, выхожу");
                    return 1;
                }
                Config config;
                ICncLink link;
                try
                {
                    config = Config.Load(configPath);
                    link = CreateLink(config);
                }
                catch (Exception e)
                {
                    Log.Write("не удалось запуститься: " + e.Message);
                    return 2;
                }
                Log.Write($"CncAgent {Agent.Version}: станок {config.MachineId}, канал {string.Join(" ", new[] { link.Kind, config.CncIp, config.RemoteDir }.Where(s => s.Length > 0))}, сервер {config.BaseUrl}");
                var stop = new ManualResetEvent(false);
                Console.CancelKeyPress += (_, e) =>
                {
                    e.Cancel = true;
                    stop.Set();
                };
                using (link)
                {
                    var agent = new Agent(config, new Server(config), link);
                    var period = TimeSpan.FromSeconds(Math.Max(0.5, config.PollSec));
                    while (!stop.WaitOne(0))
                    {
                        try
                        {
                            agent.Tick();
                        }
                        catch (Exception e)
                        {
                            Log.Write("ошибка цикла: " + e);
                        }
                        stop.WaitOne(period);
                    }
                }
                Log.Write("остановлен");
                return 0;
            }
        }

        // One-shot diagnostics for the installer and the technician: connect, print what the
        // controller reports, exit 0 when it answered.
        static int Check(string configPath)
        {
            Config config;
            try
            {
                config = Config.Load(configPath);
            }
            catch (Exception e)
            {
                Console.WriteLine("конфиг: " + e.Message);
                return 2;
            }
            Console.WriteLine($"Канал {config.Link}, стойка {config.CncIp}{(config.RemoteDir.Length > 0 ? ", папка " + config.RemoteDir : "")}");
            try
            {
                using (var link = CreateLink(config))
                {
                    if (!link.CanRead)
                    {
                        var listed = link.ListFiles(out _);
                        Console.WriteLine($"Папка доступна, файлов: {listed.Count}");
                        return 0;
                    }
                    CncSnapshot snap = null;
                    var until = DateTime.Now.AddSeconds(40);
                    while (DateTime.Now < until)
                    {
                        snap = link.Read();
                        if (snap.Connected) break;
                        Thread.Sleep(1000);
                    }
                    if (snap == null || !snap.Connected)
                    {
                        Console.WriteLine("НЕТ СВЯЗИ: " + snap?.Error);
                        return 1;
                    }
                    Console.WriteLine("Связь есть: " + link.Describe());
                    Console.WriteLine($"Режим {snap.Mode}, состояние {snap.State}, основная программа {snap.MainProgram ?? "-"}, строка {snap.Line}");
                    Console.WriteLine($"Счётчик деталей {snap.PartCount?.ToString() ?? "-"}, тревоги: {(snap.Alarms.Count == 0 ? "нет" : string.Join("; ", snap.Alarms))}{(snap.Emergency == true ? ", АВАРИЙНЫЙ СТОП" : "")}");
                    var files = link.ListFiles(out var free);
                    Console.WriteLine($"Программ в памяти: {files?.Count.ToString() ?? "-"}{(free.HasValue ? $", свободно {free.Value / 1024 / 1024} МБ" : "")}");
                    return 0;
                }
            }
            catch (Exception e)
            {
                Console.WriteLine("ОШИБКА: " + e.Message);
                return 1;
            }
        }

        // Delivery test for the technician: send one file the way the agent would, report the
        // channel that took it and whether the controller lists it.
        static int Upload(string file, string configPath)
        {
            if (!File.Exists(file))
            {
                Console.WriteLine("файл не найден: " + file);
                return 2;
            }
            try
            {
                var config = Config.Load(configPath);
                Console.WriteLine($"Канал {config.Link}, стойка {config.CncIp}{(config.RemoteDir.Length > 0 ? ", папка " + config.RemoteDir : "")}");
                using (var link = CreateLink(config))
                {
                    var name = Path.GetFileName(file);
                    link.Upload(name, File.ReadAllBytes(file));
                    var via = (link as SyntecRemoteLink)?.LastUploadVia ?? link.Describe();
                    var files = link.ListFiles(out _);
                    var listed = files?.Any(f => string.Equals(f, name, StringComparison.OrdinalIgnoreCase));
                    Console.WriteLine($"ПЕРЕДАН через {via}. В списке программ стойки: {(listed == null ? "не удалось прочитать" : listed.Value ? "есть" : "НЕТ")}");
                    return listed == false ? 1 : 0;
                }
            }
            catch (Exception e)
            {
                Console.WriteLine("ОШИБКА: " + e.Message);
                return 1;
            }
        }

        static ICncLink CreateLink(Config config)
        {
            switch (config.Link.ToLowerInvariant())
            {
                case "syntec": return new SyntecRemoteLink(config);
                case "fake": return new FakeCncLink(config);
                case "folder":
                case "ftp": return new FileDropLink(config);
                default: throw new ArgumentException("Link должен быть syntec, fake, folder или ftp, а не " + config.Link);
            }
        }
    }
}
