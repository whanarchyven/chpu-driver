using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace CncAgent
{
    // Controller emulator for the stand and for training. Programs live in FakeDir, the
    // "operator" is a text file: write start / hold / resume / stop / alarm <text> / clear /
    // emg / mode <MODE> into fake-control.txt next to the agent.
    public sealed class FakeCncLink : ICncLink
    {
        readonly string _dir;
        readonly string _controlPath;
        readonly double _autoStartSec;
        readonly double _linesPerSec;
        string _mode = "AUTO";
        string _state = "READY";
        string _main;
        int _lines;
        double _line;
        int _parts;
        readonly List<string> _alarms = new List<string>();
        bool _emergency;
        DateTime _last = DateTime.Now;
        DateTime _readySince = DateTime.Now;

        public FakeCncLink(Config config)
        {
            _dir = config.FullPath(config.FakeDir);
            Directory.CreateDirectory(_dir);
            _controlPath = config.FullPath("fake-control.txt");
            _autoStartSec = config.FakeAutoStartSec;
            _linesPerSec = Math.Max(1, config.FakeLinesPerSec);
        }

        public string Kind => "fake";
        public bool CanRead => true;

        void Control()
        {
            if (!File.Exists(_controlPath)) return;
            string[] commands;
            try
            {
                commands = File.ReadAllLines(_controlPath);
                File.Delete(_controlPath);
            }
            catch (IOException)
            {
                return;
            }
            foreach (var raw in commands)
            {
                var line = raw.Trim();
                if (line.Length == 0) continue;
                var space = line.IndexOf(' ');
                var verb = (space < 0 ? line : line.Substring(0, space)).ToLowerInvariant();
                var arg = space < 0 ? "" : line.Substring(space + 1).Trim();
                Log.Write("эмулятор: " + line);
                switch (verb)
                {
                    case "start": Start(); break;
                    case "hold": if (_state == "START") _state = "HOLD"; break;
                    case "resume": if (_state == "HOLD") _state = "START"; break;
                    case "stop":
                    case "reset": Reset(); break;
                    case "alarm": _alarms.Add(arg.Length > 0 ? arg : "тестовая тревога"); Reset(); break;
                    case "clear": _alarms.Clear(); _emergency = false; break;
                    case "emg": _emergency = true; Reset(); break;
                    case "mode": _mode = arg.ToUpperInvariant(); break;
                }
            }
        }

        void Start()
        {
            if (_main == null || _mode != "AUTO" || _emergency || _alarms.Count > 0 || _state == "START") return;
            var path = Path.Combine(_dir, _main);
            if (!File.Exists(path)) return;
            _lines = File.ReadAllLines(path).Length;
            _line = 1;
            _state = "START";
        }

        void Reset()
        {
            if (_state == "START" || _state == "HOLD") _readySince = DateTime.Now;
            _state = "READY";
            _line = 0;
        }

        public CncSnapshot Read()
        {
            Control();
            var now = DateTime.Now;
            var dt = (now - _last).TotalSeconds;
            _last = now;
            if (_state == "START")
            {
                _line += dt * _linesPerSec;
                if (_line >= _lines)
                {
                    _parts += 1;
                    Reset();
                }
            }
            else if (_state == "READY" && _autoStartSec > 0 && _main != null && (now - _readySince).TotalSeconds >= _autoStartSec)
            {
                _readySince = now;
                Start();
            }
            return new CncSnapshot
            {
                Connected = true,
                Mode = _mode,
                State = _state,
                MainProgram = _main,
                CurrentProgram = _main,
                Line = (int)Math.Floor(_line),
                PartCount = _parts,
                Alarms = new List<string>(_alarms),
                Emergency = _emergency,
                Feed = _state == "START" ? 15000 : 0,
                Rpm = _state == "START" ? 18000 : 0,
                FeedOverride = 100,
                SpindleOverride = 100,
                Position = new List<Axis>
                {
                    new Axis { Name = "X", Machine = _line % 2000, Absolute = _line % 2000 },
                    new Axis { Name = "Y", Machine = 0, Absolute = 0 },
                    new Axis { Name = "Z", Machine = _state == "START" ? -6 : 50, Absolute = _state == "START" ? -6 : 50 },
                },
            };
        }

        public void Upload(string cncName, byte[] content)
        {
            if ((_state == "START" || _state == "HOLD") && string.Equals(cncName, _main, StringComparison.OrdinalIgnoreCase))
                throw new CncException("программа сейчас выполняется, перезаписать нельзя");
            File.WriteAllBytes(Path.Combine(_dir, cncName), content);
        }

        public bool SelectMain(string cncName)
        {
            if (_state == "START" || _state == "HOLD") return false;
            if (!File.Exists(Path.Combine(_dir, cncName))) return false;
            _main = cncName;
            _readySince = DateTime.Now;
            return true;
        }

        public List<string> ListFiles(out long? freeBytes)
        {
            freeBytes = 512L * 1024 * 1024;
            return Directory.GetFiles(_dir).Select(Path.GetFileName).OrderBy(n => n).ToList();
        }

        public string Describe() => "эмулятор стойки (fake)";

        public void Dispose() { }
    }
}
