using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Web.Script.Serialization;

namespace CncAgent
{
    public sealed class RunState
    {
        public string JobId;
        public long StartedAt;
        public int StartParts;
        public int MaxLine;
    }

    // Survives agent restarts, so a run in progress is still closed correctly.
    public sealed class AgentState
    {
        public Dictionary<string, string> Delivered = new Dictionary<string, string>();
        public string Loaded;
        public List<string> SkipAuto = new List<string>();
        public RunState Run;
        public string AlarmKey = "";
        public Dictionary<string, JobInfo> Known = new Dictionary<string, JobInfo>();
    }

    public sealed class Agent
    {
        public const string Version = "0.1.0";
        static readonly HashSet<string> Open = new HashSet<string> { "queued", "delivered", "loaded", "in_progress" };

        readonly Config _config;
        readonly Server _server;
        readonly ICncLink _link;
        readonly string _statePath;
        readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        AgentState _state;
        List<JobInfo> _jobs = new List<JobInfo>();
        bool _linkUp = true;
        int _linkFailures;
        DateTime _nextHeartbeat = DateTime.MinValue;
        DateTime _nextFiles = DateTime.MinValue;
        DateTime _nextSelect = DateTime.MinValue;
        List<string> _files;
        long? _freeBytes;
        CncSnapshot _last = new CncSnapshot();
        string _serverError;
        readonly Dictionary<string, DateTime> _deliverRetry = new Dictionary<string, DateTime>();

        public Agent(Config config, Server server, ICncLink link)
        {
            _config = config;
            _server = server;
            _link = link;
            _statePath = config.FullPath("state.json");
            _state = LoadState();
        }

        AgentState LoadState()
        {
            try
            {
                if (File.Exists(_statePath)) return _json.Deserialize<AgentState>(File.ReadAllText(_statePath)) ?? new AgentState();
            }
            catch (Exception e)
            {
                Log.Write("state.json повреждён, начинаю заново: " + e.Message);
            }
            return new AgentState();
        }

        void SaveState()
        {
            var tmp = _statePath + ".tmp";
            File.WriteAllText(tmp, _json.Serialize(_state));
            if (File.Exists(_statePath)) File.Replace(tmp, _statePath, null);
            else File.Move(tmp, _statePath);
        }

        void Emit(string type, JobInfo job, string detail = null, Action<AgentEvent> fill = null)
        {
            var e = new AgentEvent { Type = type, JobId = job?.JobId, Detail = detail };
            fill?.Invoke(e);
            _server.Enqueue(e);
        }

        static bool Same(string a, string b) => a != null && b != null && string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);

        JobInfo Job(string jobId)
        {
            if (jobId == null) return null;
            var job = _jobs.FirstOrDefault(j => j.JobId == jobId);
            if (job != null) return job;
            return _state.Known.TryGetValue(jobId, out var known) ? known : null;
        }

        public void Tick()
        {
            CncSnapshot snap;
            try
            {
                snap = _link.Read();
            }
            catch (Exception e)
            {
                snap = new CncSnapshot { Error = e.Message };
            }
            _last = snap;
            TrackLink(snap);
            PollServer();
            Deliver(snap);
            if (_link.CanRead && snap.Connected)
            {
                TrackRun(snap);
                SelectMain(snap);
                TrackAlarms(snap);
            }
            SaveState();
            Heartbeat(snap);
            try
            {
                _server.Flush();
            }
            catch (Exception e) when (IsNetwork(e))
            {
                // Events stay in the outbox until the server is back.
            }
        }

        static bool IsNetwork(Exception e) => e is WebException || e is SocketException || e is IOException;

        void TrackLink(CncSnapshot snap)
        {
            if (snap.Connected)
            {
                if (!_linkUp) Emit("link_restored", null, _link.Describe());
                _linkUp = true;
                _linkFailures = 0;
                return;
            }
            _linkFailures += 1;
            if (_linkUp && _linkFailures >= 3)
            {
                _linkUp = false;
                Emit("link_lost", null, snap.Error);
            }
        }

        void PollServer()
        {
            try
            {
                _jobs = _server.Jobs();
                _serverError = null;
                foreach (var job in _jobs) _state.Known[job.JobId] = job;
                var live = new HashSet<string>(_jobs.Select(j => j.JobId));
                foreach (var id in _state.Known.Keys.ToList())
                {
                    var keep = live.Contains(id) || id == _state.Loaded || id == _state.Run?.JobId;
                    if (!keep) _state.Known.Remove(id);
                }
                foreach (var id in _state.Delivered.Keys.ToList())
                    if (!live.Contains(id)) _state.Delivered.Remove(id);
                _state.SkipAuto.RemoveAll(id => !live.Contains(id));
            }
            catch (Exception e)
            {
                if (_serverError != e.Message) Log.Write("сервер недоступен: " + e.Message);
                _serverError = e.Message;
            }
        }

        bool IsOpen(JobInfo job) => job != null && Open.Contains(job.Status);

        void Deliver(CncSnapshot snap)
        {
            if (!snap.Connected) return;
            var waiting = _jobs.Count(j => j.Status == "delivered" || (j.Status == "queued" && _state.Delivered.ContainsKey(j.JobId)));
            foreach (var job in _jobs.Where(j => j.Status == "queued").OrderBy(j => j.CreatedAt))
            {
                if (_state.Delivered.TryGetValue(job.JobId, out var sha) && sha == job.Sha256) continue;
                if (waiting >= Math.Max(1, _config.DeliverAhead)) break;
                if (_deliverRetry.TryGetValue(job.JobId, out var retryAt) && DateTime.Now < retryAt) continue;
                // Never overwrite the program that is cutting right now.
                if (snap.Running && Same(snap.MainProgram, job.CncName))
                {
                    _deliverRetry[job.JobId] = DateTime.Now.AddSeconds(30);
                    continue;
                }
                try
                {
                    var bytes = _server.Download(job);
                    _link.Upload(job.CncName, bytes);
                    _state.Delivered[job.JobId] = job.Sha256;
                    _nextFiles = DateTime.MinValue;
                    waiting += 1;
                    Emit("delivered", job, $"{job.CncName}, {bytes.Length} байт");
                }
                catch (Exception e) when (IsNetwork(e) && !(e is WebException we && we.Response != null))
                {
                    Log.Write($"{job.Number}: доставка отложена: {e.Message}");
                    _deliverRetry[job.JobId] = DateTime.Now.AddSeconds(20);
                }
                catch (Exception e)
                {
                    Log.Write($"{job.Number}: не удалось доставить: {e.Message}");
                    Emit("failed", job, "доставка на стойку: " + e.Message);
                    _deliverRetry[job.JobId] = DateTime.Now.AddMinutes(5);
                }
            }
        }

        void TrackRun(CncSnapshot snap)
        {
            var run = _state.Run;
            if (run == null)
            {
                if (!snap.Running) return;
                var job = Job(_state.Loaded);
                if (job == null || !Same(snap.MainProgram, job.CncName))
                    job = _jobs.Where(j => IsOpen(j) && Same(snap.MainProgram, j.CncName)).OrderBy(j => j.CreatedAt).FirstOrDefault();
                if (job == null) return;
                if (_state.Loaded != job.JobId)
                {
                    _state.Loaded = job.JobId;
                    Emit("loaded", job, "программу выбрал оператор");
                }
                _state.Run = new RunState
                {
                    JobId = job.JobId,
                    StartedAt = Server.NowMs(),
                    StartParts = snap.PartCount ?? 0,
                    MaxLine = snap.Line ?? 0,
                };
                Emit("run_started", job, snap.MainProgram);
                return;
            }
            if (snap.Line.HasValue) run.MaxLine = Math.Max(run.MaxLine, snap.Line.Value);
            if (snap.Running) return;

            var finishedJob = Job(run.JobId);
            var lines = finishedJob?.Lines ?? 0;
            var parts = (snap.PartCount ?? run.StartParts) - run.StartParts;
            var reachedEnd = lines > 0 && run.MaxLine >= lines - 3;
            var duration = (Server.NowMs() - run.StartedAt) / 1000.0;
            if (parts > 0 || reachedEnd)
            {
                var count = parts > 0 ? parts : 1;
                Emit("run_finished", finishedJob ?? new JobInfo { JobId = run.JobId }, $"за {Math.Round(duration)} с", e =>
                {
                    e.Count = count;
                    e.DurationSec = duration;
                    e.StartedAt = run.StartedAt;
                });
            }
            else
            {
                Emit("run_stopped", finishedJob ?? new JobInfo { JobId = run.JobId }, $"на строке {run.MaxLine} из {lines}", e =>
                {
                    e.DurationSec = duration;
                    e.StartedAt = run.StartedAt;
                });
            }
            _state.Run = null;
        }

        void SelectMain(CncSnapshot snap)
        {
            if (snap.Running || _state.Run != null) return;
            var loaded = Job(_state.Loaded);
            if (loaded != null && !IsOpen(loaded))
            {
                _state.Loaded = null;
                loaded = null;
            }
            if (loaded != null)
            {
                if (Same(snap.MainProgram, loaded.CncName)) return;
                // The operator picked something else on the panel: step back, do not fight them.
                Emit("unloaded", loaded, snap.MainProgram);
                _state.SkipAuto.Add(loaded.JobId);
                _state.Loaded = null;
            }

            // "queued" with a local delivery record: the delivered event is still in the outbox.
            var candidates = _jobs
                .Where(j => j.Status == "loaded" || j.Status == "in_progress" || j.Status == "delivered" ||
                            (j.Status == "queued" && _state.Delivered.ContainsKey(j.JobId)))
                .OrderBy(j => j.Status == "delivered" || j.Status == "queued" ? 1 : 0)
                .ThenBy(j => j.CreatedAt)
                .ToList();
            var chosen = candidates.FirstOrDefault(j => Same(snap.MainProgram, j.CncName));
            if (chosen != null)
            {
                _state.Loaded = chosen.JobId;
                _state.SkipAuto.Remove(chosen.JobId);
                if (chosen.Status == "delivered" || chosen.Status == "queued") Emit("loaded", chosen, snap.MainProgram);
                return;
            }
            if (!_config.AutoSelectMain || DateTime.Now < _nextSelect) return;
            var target = candidates.FirstOrDefault(j => j.Status != "in_progress" && !_state.SkipAuto.Contains(j.JobId));
            if (target == null) return;
            _nextSelect = DateTime.Now.AddSeconds(15);
            try
            {
                if (_link.SelectMain(target.CncName)) Log.Write($"{target.Number}: {target.CncName} выбрана основной программой");
                else Log.Write($"{target.Number}: стойка не дала выбрать {target.CncName} (режим {snap.Mode}, состояние {snap.State})");
            }
            catch (Exception e)
            {
                Log.Write($"{target.Number}: выбор программы: {e.Message}");
            }
        }

        void TrackAlarms(CncSnapshot snap)
        {
            var parts = new List<string>(snap.Alarms);
            if (snap.Emergency == true) parts.Insert(0, "аварийный стоп");
            var key = string.Join("; ", parts);
            if (key == _state.AlarmKey) return;
            var job = Job(_state.Run?.JobId ?? _state.Loaded);
            if (key.Length > 0) Emit("alarm", job, key);
            else Emit("alarm_cleared", job, _state.AlarmKey);
            _state.AlarmKey = key;
        }

        void Heartbeat(CncSnapshot snap)
        {
            if (DateTime.Now < _nextHeartbeat) return;
            _nextHeartbeat = DateTime.Now.AddSeconds(Math.Max(2, _config.PollSec * 2));
            var body = new Dictionary<string, object>
            {
                ["machineId"] = _config.MachineId,
                ["agentVersion"] = Version,
                ["hostname"] = Environment.MachineName,
                ["ip"] = LocalIp(),
                ["serverUrl"] = _config.BaseUrl,
                ["link"] = _link.Kind,
                ["cncIp"] = _config.CncIp,
                ["connected"] = snap.Connected,
                ["at"] = Server.NowMs(),
            };
            void Put(string key, object value)
            {
                if (value != null) body[key] = value;
            }
            Put("linkError", snap.Error);
            Put("mode", snap.Mode);
            Put("state", snap.State);
            Put("mainProgram", snap.MainProgram);
            Put("currentProgram", snap.CurrentProgram);
            Put("line", snap.Line);
            Put("partCount", snap.PartCount);
            if (_link.CanRead && snap.Connected) body["alarms"] = snap.Alarms;
            Put("emergency", snap.Emergency);
            Put("feed", snap.Feed);
            Put("rpm", snap.Rpm);
            Put("feedOverride", snap.FeedOverride);
            Put("spindleOverride", snap.SpindleOverride);
            if (snap.Position != null)
                body["position"] = snap.Position.Select(a => new Dictionary<string, object> { ["axis"] = a.Name, ["machine"] = a.Machine, ["absolute"] = a.Absolute }).ToList();
            if (snap.Connected && DateTime.Now >= _nextFiles)
            {
                _nextFiles = DateTime.Now.AddSeconds(60);
                try
                {
                    _files = _link.ListFiles(out _freeBytes);
                    Put("controller", _link.Describe());
                }
                catch (Exception e)
                {
                    Log.Write("список файлов: " + e.Message);
                }
                Put("ncFiles", _files);
                Put("ncFreeBytes", _freeBytes);
            }
            var debug = Log.Recent().ToList();
            if (_server.PendingEvents > 0) debug.Add($"в outbox событий: {_server.PendingEvents}");
            body["debug"] = debug;
            try
            {
                _server.Heartbeat(body);
            }
            catch (Exception e)
            {
                if (_serverError == null) Log.Write("пульс не отправлен: " + e.Message);
            }
        }

        static string LocalIp()
        {
            try
            {
                return string.Join(", ", Dns.GetHostAddresses(Dns.GetHostName())
                    .Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a))
                    .Select(a => a.ToString()));
            }
            catch
            {
                return null;
            }
        }

        public CncSnapshot Last => _last;
    }
}
