using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;

namespace CncAgent
{
    // Syntec Remote API (Syntec.Remote.SyntecRemoteCNC, see SyntecLibrary). The controller must
    // run its Remote API server ("Core server" in the network settings), ports 5566-5572.
    // With RemoteDir set (the controller's shared NcFiles folder or FTP), a file the Remote API
    // fails to install is written there instead, and later files go there directly.
    public sealed class SyntecRemoteLink : ICncLink
    {
        readonly string _host;
        readonly int _timeoutMs;
        readonly string _tempDir;
        readonly FileDropLink _drop;
        readonly string _library;
        dynamic _cnc;
        DateTime _nextConnect = DateTime.MinValue;
        string _describe;
        string _connectError;
        bool _preferDrop;

        public SyntecRemoteLink(Config config)
        {
            if (string.IsNullOrWhiteSpace(config.CncIp)) throw new ArgumentException("CncIp не задан в cnc-agent.json");
            _host = config.CncIp;
            _timeoutMs = config.CncTimeoutMs;
            _library = config.SyntecLib;
            _tempDir = Path.Combine(Path.GetTempPath(), "cnc-agent");
            Directory.CreateDirectory(_tempDir);
            if (!string.IsNullOrWhiteSpace(config.RemoteDir)) _drop = new FileDropLink(config);
        }

        public string LastUploadVia { get; private set; }

        public string Kind => "syntec";
        public bool CanRead => true;

        // Syntec.Remote.SyntecRemoteCNC.ErrorCode, identical in both library builds.
        enum SyntecError : short
        {
            NormalTermination = 0, ErrorFunctionNotExecuted = 1, ErrorDataBlockLength = 2, ErrorDataNumber = 3,
            ErrorDataAttribute = 4, ErrorData = 5, ErrorNoOption = 6, ErrorWriteProtection = 7, ErrorMemoryOverflow = 8,
            ErrorCNCParameter = 9, ErrorBufferEmptyOrFull = 10, ErrorPathNumber = 11, ErrorCNCMode = 12,
            ErrorCNCExecutionReject = 13, ErrorDataServer = 14, ErrorAlarm = 15, ErrorStop = 16, ErrorDataProtection = 17,
            ErrorNotFoundMachineID = 18, ErrorNoOut = 19, ErrorNeedUpdateVersion = 20,
            NotSupported = -18, ProtocolError = -17, SocketError = -16, DLLFileError = -15, USBEmpty = -14, NoUSB = -13,
            HandleNumberError = -8, VersionMismach = -7, AbnormalLibraryState = -6, RestOrStopRequest = -2, CNCBusy = -1,
        }

        static bool Ok(short rc) => rc == (short)SyntecError.NormalTermination;

        static string Code(short rc) =>
            Enum.IsDefined(typeof(SyntecError), rc) ? $"{(SyntecError)rc} ({rc})" : rc.ToString();

        dynamic Cnc()
        {
            if (_cnc != null && (bool)_cnc.isConnected()) return _cnc;
            if (DateTime.Now < _nextConnect) return null;
            Drop();
            _nextConnect = DateTime.Now.AddSeconds(10);
            dynamic cnc;
            try
            {
                cnc = SyntecLibrary.Create(_library, _host, _timeoutMs);
                var until = DateTime.Now.AddMilliseconds(Math.Max(15000, _timeoutMs));
                while (!(bool)cnc.isConnected() && DateTime.Now < until) Thread.Sleep(200);
            }
            catch (Exception e)
            {
                while ((e is TargetInvocationException || e is TypeInitializationException) && e.InnerException != null) e = e.InnerException;
                _connectError = e is DllNotFoundException || e is BadImageFormatException || e is FileNotFoundException
                    ? "не загружается библиотека Syntec (нужен Microsoft Visual C++ 2005 SP1 x86): " + e.Message
                    : "библиотека Syntec: " + e.GetType().Name + ": " + e.Message;
                return null;
            }
            if (!(bool)cnc.isConnected())
            {
                try { cnc.Close(); } catch { }
                _connectError = $"стойка {_host} не отвечает (включён ли Core server / Remote API, порты 5566-5572)";
                return null;
            }
            _cnc = cnc;
            _connectError = null;
            _describe = null;
            Log.Write($"Remote API: подключено к {_host}, библиотека {SyntecLibrary.Loaded}");
            return _cnc;
        }

        void Drop()
        {
            if (_cnc == null) return;
            try { _cnc.Close(); } catch { }
            _cnc = null;
        }

        static string Clean(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var trimmed = value.Trim();
            return trimmed.Trim('*').Length == 0 ? null : trimmed;
        }

        public CncSnapshot Read()
        {
            var snap = new CncSnapshot();
            var cnc = Cnc();
            if (cnc == null)
            {
                snap.Error = "нет связи с Remote API: " + (_connectError ?? _host);
                return snap;
            }
            string main = null, cur = null, mode = null, status = null, alarm = null, emg = null;
            int seq = 0;
            short rc = cnc.READ_status(out main, out cur, out seq, out mode, out status, out alarm, out emg);
            if (!Ok(rc))
            {
                snap.Error = "READ_status: " + Code(rc);
                if (rc == (short)SyntecError.SocketError) Drop();
                return snap;
            }
            snap.Connected = true;
            snap.MainProgram = Clean(main);
            snap.CurrentProgram = Clean(cur);
            snap.Mode = Clean(mode);
            snap.State = Clean(status);
            snap.Emergency = Clean(emg) != null;

            int line = 0;
            if (Ok(cnc.READ_nc_pointer(out line))) snap.Line = line;
            int parts = 0, required = 0, total = 0;
            if (Ok(cnc.READ_part_count(out parts, out required, out total))) snap.PartCount = parts;
            float ovFeed = 0, ovSpindle = 0, feed = 0;
            int rpm = 0;
            if (Ok(cnc.READ_spindle(out ovFeed, out ovSpindle, out feed, out rpm)))
            {
                snap.FeedOverride = ovFeed;
                snap.SpindleOverride = ovSpindle;
                snap.Feed = feed;
                snap.Rpm = rpm;
            }
            bool isAlarm = false;
            string[] messages = null;
            DateTime[] times = null;
            if (Ok(cnc.READ_alm_current(out isAlarm, out messages, out times)) && isAlarm && messages != null)
                snap.Alarms.AddRange(messages.Where(m => !string.IsNullOrWhiteSpace(m)).Select(m => m.Trim()));
            else if (Clean(alarm) != null)
                snap.Alarms.Add(Clean(alarm));
            string[] names = null, units = null;
            short decPoint = 0;
            float[] machine = null, absolute = null, relative = null, toGo = null;
            if (Ok(cnc.READ_position(out names, out decPoint, out units, out machine, out absolute, out relative, out toGo)) && names != null)
            {
                snap.Position = new List<Axis>();
                for (var i = 0; i < names.Length; i++)
                    snap.Position.Add(new Axis { Name = names[i], Machine = machine[i], Absolute = absolute[i] });
            }
            return snap;
        }

        public void Upload(string cncName, byte[] content)
        {
            if (_drop == null || !_preferDrop)
            {
                try
                {
                    UploadApi(cncName, content);
                    LastUploadVia = "Remote API";
                    return;
                }
                catch (CncException e) when (_drop != null)
                {
                    Log.Write($"{cncName}: Remote API не установил файл ({e.Message}), пишу в {_drop.Describe()}");
                }
            }
            try
            {
                _drop.Upload(cncName, content);
            }
            catch (Exception e)
            {
                throw new CncException($"{_drop.Describe()}: {e.Message}");
            }
            _preferDrop = true;
            LastUploadVia = _drop.Describe();
            var files = ListFiles(out _);
            if (files != null && !files.Any(f => string.Equals(f, cncName, StringComparison.OrdinalIgnoreCase)))
                Log.Write($"{cncName}: записан в {_drop.Describe()}, но в списке программ стойки его нет — RemoteDir указывает не на NcFiles?");
        }

        void UploadApi(string cncName, byte[] content)
        {
            var cnc = Cnc() ?? throw new CncException("нет связи с Remote API: " + (_connectError ?? _host));
            var path = Path.Combine(_tempDir, cncName);
            File.WriteAllBytes(path, content);
            short rc = cnc.UPLOAD_nc_mem(path);
            if (!Ok(rc)) throw new CncException("UPLOAD_nc_mem: " + Code(rc));
            var until = DateTime.Now.AddSeconds(120);
            while (!(bool)cnc.isFileUploadDone && DateTime.Now < until) Thread.Sleep(300);
            if (!(bool)cnc.isFileUploadDone) throw new CncException("передача файла не закончилась за 2 минуты");
            short error = cnc.FileUploadErrorCode;
            // The file travels to \DiskC\ServerTmp first, then the controller installs it into NcFiles.
            if (error != 0) throw new CncException($"стойка не приняла файл (код {Code(error)})");
            var files = ListFiles(out _);
            if (files != null && !files.Any(f => string.Equals(f, cncName, StringComparison.OrdinalIgnoreCase)))
                throw new CncException("файл передан, но в списке программ стойки его нет");
        }

        public bool SelectMain(string cncName)
        {
            var cnc = Cnc() ?? throw new CncException("нет связи с Remote API: " + (_connectError ?? _host));
            short rc = cnc.WRITE_nc_main(cncName);
            if (!Ok(rc))
            {
                Log.Write($"WRITE_nc_main({cncName}): {Code(rc)}");
                return false;
            }
            return true;
        }

        public List<string> ListFiles(out long? freeBytes)
        {
            freeBytes = null;
            var cnc = Cnc();
            if (cnc == null) return null;
            long free = 0;
            if (Ok(cnc.READ_nc_freespace(out free))) freeBytes = free;
            string[][] rows = null;
            if (!Ok(cnc.READ_nc_mem_list(out rows)) || rows == null) return null;
            return rows
                .Where(r => r != null && r.Length > 0 && (r.Length < 4 || r[3] == "FILE"))
                .Select(r => r[0])
                .Where(n => n != "." && n != "..")
                .ToList();
        }

        public string Describe()
        {
            if (_describe != null) return _describe;
            var cnc = Cnc();
            if (cnc == null) return null;
            short axes = 0, maxAxes = 0;
            string type = null, series = null, version = null;
            string[] axisNames = null;
            if (Ok(cnc.READ_information(out axes, out type, out maxAxes, out series, out version, out axisNames)))
                _describe = $"Syntec {series} {type} ПО {version}, осей {axes}, библиотека {SyntecLibrary.Loaded}" + (_drop == null ? "" : $", запасная доставка: {_drop.Describe()}");
            return _describe;
        }

        public void Dispose() => Drop();
    }
}
