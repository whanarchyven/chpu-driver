using System;
using System.Collections.Generic;

namespace CncAgent
{
    public sealed class Axis
    {
        public string Name;
        public double Machine;
        public double Absolute;
    }

    // One reading of the controller. Fields the link cannot read stay null.
    public sealed class CncSnapshot
    {
        public bool Connected;
        public string Error;
        public string Mode;
        // READY, START, HOLD, STOP, ... as the controller reports it
        public string State;
        public string MainProgram;
        public string CurrentProgram;
        public int? Line;
        public int? PartCount;
        public List<string> Alarms = new List<string>();
        public bool? Emergency;
        public double? Feed;
        public int? Rpm;
        public double? FeedOverride;
        public double? SpindleOverride;
        public List<Axis> Position;

        public bool Running => State == "START" || State == "HOLD";
    }

    public interface ICncLink : IDisposable
    {
        string Kind { get; }
        // False for delivery-only links (folder, FTP): no state, no program selection.
        bool CanRead { get; }
        CncSnapshot Read();
        void Upload(string cncName, byte[] content);
        bool SelectMain(string cncName);
        // null when the link cannot list files.
        List<string> ListFiles(out long? freeBytes);
        string Describe();
    }

    public sealed class CncException : Exception
    {
        public CncException(string message) : base(message) { }
    }
}
