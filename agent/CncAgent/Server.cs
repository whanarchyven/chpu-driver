using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace CncAgent
{
    public sealed class JobInfo
    {
        public string JobId;
        public string Number;
        public string Status;
        public string CncName;
        public string Sha256;
        public int Lines;
        public int QtyPlanned;
        public int QtyDone;
        public double CreatedAt;
    }

    public sealed class AgentEvent
    {
        public string EventId = Guid.NewGuid().ToString("N");
        public string Type;
        public string JobId;
        public long At = Server.NowMs();
        public int? Count;
        public double? DurationSec;
        public long? StartedAt;
        public string Detail;
    }

    // HTTP client for the Convex /agent endpoints plus a disk outbox, so events survive
    // a server outage or an agent restart.
    public sealed class Server
    {
        readonly Config _config;
        readonly string _outboxPath;
        readonly List<AgentEvent> _outbox;
        readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };

        public Server(Config config)
        {
            _config = config;
            _outboxPath = config.FullPath("outbox.json");
            _outbox = LoadOutbox();
            ServicePointManager.DefaultConnectionLimit = 4;
        }

        public static long NowMs() => (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

        HttpWebRequest Request(string method, string pathAndQuery, int timeoutMs = 15000)
        {
            var request = (HttpWebRequest)WebRequest.Create(_config.BaseUrl + pathAndQuery);
            request.Method = method;
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.Proxy = null;
            request.Headers["Authorization"] = "Bearer " + _config.Token;
            return request;
        }

        string Send(string method, string path, object body)
        {
            var request = Request(method, path);
            if (body != null)
            {
                var bytes = Encoding.UTF8.GetBytes(_json.Serialize(body));
                request.ContentType = "application/json";
                request.ContentLength = bytes.Length;
                using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        public List<JobInfo> Jobs()
        {
            var text = Send("GET", "/agent/jobs?machineId=" + Uri.EscapeDataString(_config.MachineId), null);
            var root = _json.Deserialize<Dictionary<string, object>>(text);
            var list = new List<JobInfo>();
            if (!(root.TryGetValue("jobs", out var raw) && raw is System.Collections.IList items)) return list;
            foreach (var item in items.OfType<IDictionary<string, object>>())
            {
                list.Add(new JobInfo
                {
                    JobId = S(item, "jobId"),
                    Number = S(item, "number"),
                    Status = S(item, "status"),
                    CncName = S(item, "cncName"),
                    Sha256 = S(item, "sha256"),
                    Lines = (int)N(item, "lines"),
                    QtyPlanned = (int)N(item, "qtyPlanned"),
                    QtyDone = (int)N(item, "qtyDone"),
                    CreatedAt = N(item, "createdAt"),
                });
            }
            return list;
        }

        static string S(IDictionary<string, object> d, string key) => d.TryGetValue(key, out var v) && v != null ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) : null;
        static double N(IDictionary<string, object> d, string key) => d.TryGetValue(key, out var v) && v != null ? Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture) : 0;

        public byte[] Download(JobInfo job)
        {
            var request = Request("GET", "/agent/file?jobId=" + Uri.EscapeDataString(job.JobId), 60000);
            byte[] bytes;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var memory = new MemoryStream())
            {
                stream.CopyTo(memory);
                bytes = memory.ToArray();
            }
            var actual = Sha256(bytes);
            if (!string.Equals(actual, job.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"контрольная сумма не совпала: {actual} вместо {job.Sha256}");
            return bytes;
        }

        public static string Sha256(byte[] bytes)
        {
            using (var sha = SHA256.Create())
                return string.Concat(sha.ComputeHash(bytes).Select(b => b.ToString("x2")));
        }

        public void Heartbeat(Dictionary<string, object> body)
        {
            Send("POST", "/agent/heartbeat", body);
        }

        public void Enqueue(AgentEvent e)
        {
            lock (_outbox)
            {
                _outbox.Add(e);
                SaveOutbox();
            }
            Log.Write($"событие {e.Type}{(e.JobId != null ? " " + e.JobId : "")}{(e.Detail != null ? ": " + e.Detail : "")}");
        }

        public int PendingEvents
        {
            get { lock (_outbox) return _outbox.Count; }
        }

        public void Flush()
        {
            List<AgentEvent> batch;
            lock (_outbox) batch = _outbox.Take(50).ToList();
            if (batch.Count == 0) return;
            var payload = new Dictionary<string, object>
            {
                ["machineId"] = _config.MachineId,
                ["events"] = batch.Select(EventBody).ToList(),
            };
            var text = Send("POST", "/agent/events", payload);
            var root = _json.Deserialize<Dictionary<string, object>>(text);
            var done = new HashSet<string>();
            foreach (var key in new[] { "accepted", "duplicates" })
                if (root.TryGetValue(key, out var raw) && raw is System.Collections.IList ids)
                    foreach (var id in ids) done.Add(Convert.ToString(id));
            lock (_outbox)
            {
                _outbox.RemoveAll(e => done.Contains(e.EventId));
                SaveOutbox();
            }
        }

        static Dictionary<string, object> EventBody(AgentEvent e)
        {
            var body = new Dictionary<string, object> { ["eventId"] = e.EventId, ["type"] = e.Type, ["at"] = e.At };
            if (e.JobId != null) body["jobId"] = e.JobId;
            if (e.Count.HasValue) body["count"] = e.Count.Value;
            if (e.DurationSec.HasValue) body["durationSec"] = Math.Round(e.DurationSec.Value, 1);
            if (e.StartedAt.HasValue) body["startedAt"] = e.StartedAt.Value;
            if (e.Detail != null) body["detail"] = e.Detail;
            return body;
        }

        List<AgentEvent> LoadOutbox()
        {
            try
            {
                if (File.Exists(_outboxPath)) return _json.Deserialize<List<AgentEvent>>(File.ReadAllText(_outboxPath)) ?? new List<AgentEvent>();
            }
            catch (Exception e)
            {
                Log.Write("outbox повреждён, начинаю заново: " + e.Message);
            }
            return new List<AgentEvent>();
        }

        void SaveOutbox()
        {
            var tmp = _outboxPath + ".tmp";
            File.WriteAllText(tmp, _json.Serialize(_outbox));
            if (File.Exists(_outboxPath)) File.Replace(tmp, _outboxPath, null);
            else File.Move(tmp, _outboxPath);
        }
    }
}
