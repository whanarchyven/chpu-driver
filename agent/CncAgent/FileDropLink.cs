using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;

namespace CncAgent
{
    // Delivery-only fallback: a shared folder the controller reads (\Network / DNC, a mapped
    // drive) or the controller's FTP server. No state reading, the operator picks the program.
    public sealed class FileDropLink : ICncLink
    {
        readonly Config _config;
        readonly bool _ftp;

        public FileDropLink(Config config)
        {
            _config = config;
            _ftp = config.RemoteDir.StartsWith("ftp://", StringComparison.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(config.RemoteDir)) throw new ArgumentException("RemoteDir не задан в cnc-agent.json");
        }

        public string Kind => _ftp ? "ftp" : "folder";
        public bool CanRead => false;

        public CncSnapshot Read()
        {
            try
            {
                ListFiles(out _);
                return new CncSnapshot { Connected = true };
            }
            catch (Exception e)
            {
                return new CncSnapshot { Error = e.Message };
            }
        }

        string FtpUrl(string name) => _config.RemoteDir.TrimEnd('/') + "/" + Uri.EscapeDataString(name);

        FtpWebRequest Ftp(string url, string method)
        {
            var request = (FtpWebRequest)WebRequest.Create(url);
            request.Method = method;
            request.UseBinary = true;
            request.UsePassive = true;
            request.Proxy = null;
            request.Timeout = 30000;
            if (_config.FtpUser.Length > 0) request.Credentials = new NetworkCredential(_config.FtpUser, _config.FtpPassword);
            return request;
        }

        public void Upload(string cncName, byte[] content)
        {
            if (_ftp)
            {
                var request = Ftp(FtpUrl(cncName), WebRequestMethods.Ftp.UploadFile);
                request.ContentLength = content.Length;
                using (var stream = request.GetRequestStream()) stream.Write(content, 0, content.Length);
                using (request.GetResponse()) { }
                return;
            }
            var target = Path.Combine(_config.RemoteDir, cncName);
            var tmp = target + ".part";
            File.WriteAllBytes(tmp, content);
            if (File.Exists(target)) File.Delete(target);
            File.Move(tmp, target);
        }

        public bool SelectMain(string cncName) => false;

        public List<string> ListFiles(out long? freeBytes)
        {
            freeBytes = null;
            if (!_ftp) return Directory.GetFiles(_config.RemoteDir).Select(Path.GetFileName).OrderBy(n => n).ToList();
            var request = Ftp(_config.RemoteDir.TrimEnd('/') + "/", WebRequestMethods.Ftp.ListDirectory);
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                return reader.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            }
        }

        public string Describe() => (_ftp ? "FTP " : "папка ") + _config.RemoteDir;

        public void Dispose() { }
    }
}
