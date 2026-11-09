using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using Syntec.Remote;

// Standalone Remote API check for a Syntec controller.
// Usage: SyntecProbe <host> [info|watch|list|upload <file>|main <name>|del <name>|install [kind]]
static class Probe
{
    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length < 1)
        {
            Console.WriteLine("SyntecProbe <host> [info|watch|list|upload <file>|main <name>|del <name>|install [kind]]");
            return 2;
        }
        string host = args[0];
        string cmd = args.Length > 1 ? args[1].ToLowerInvariant() : "info";
        string arg = args.Length > 2 ? args[2] : null;

        Console.WriteLine("connect " + host);
        SyntecRemoteCNC cnc = new SyntecRemoteCNC(host, 5000);
        try
        {
            DateTime until = DateTime.Now.AddSeconds(15);
            while (!cnc.isConnected() && DateTime.Now < until) Thread.Sleep(500);
            Console.WriteLine("isConnected=" + cnc.isConnected());

            switch (cmd)
            {
                case "info": Info(cnc); break;
                case "watch":
                    while (true) { Status(cnc); Thread.Sleep(1000); }
                case "list": List(cnc); break;
                case "upload": Upload(cnc, arg); break;
                case "main": Rc("WRITE_nc_main", cnc.WRITE_nc_main(arg)); Status(cnc); break;
                case "del": Rc("DEL_nc_mem", cnc.DEL_nc_mem(arg)); break;
                case "install": Install(cnc, arg == null ? 32 : int.Parse(arg)); List(cnc); break;
                default: Console.WriteLine("unknown command " + cmd); return 2;
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.WriteLine("EXCEPTION " + e);
            return 1;
        }
        finally
        {
            try { cnc.Close(); } catch { }
        }
    }

    static string Rc(string name, short rc)
    {
        string text = Enum.IsDefined(typeof(SyntecRemoteCNC.ErrorCode), (int)rc)
            ? ((SyntecRemoteCNC.ErrorCode)rc).ToString() : rc.ToString();
        Console.WriteLine(name + " -> " + rc + " " + text);
        return text;
    }

    static string J(string[] a) { return a == null ? "null" : "[" + string.Join(", ", a) + "]"; }

    static void Info(SyntecRemoteCNC cnc)
    {
        short axes, maxAxes; string type, series, ver; string[] axisNames;
        if (Rc("READ_information", cnc.READ_information(out axes, out type, out maxAxes, out series, out ver, out axisNames)) == "NormalTermination")
            Console.WriteLine("  axes=" + axes + " type=" + type + " max=" + maxAxes + " series=" + series + " ver=" + ver + " names=" + J(axisNames));
        try { Console.WriteLine("  SeriesNo=" + cnc.SeriesNo + " Board=" + cnc.MainBoardPlatformName); } catch (Exception e) { Console.WriteLine("  props: " + e.Message); }

        Status(cnc);

        int ptr;
        if (Rc("READ_nc_pointer", cnc.READ_nc_pointer(out ptr)) == "NormalTermination") Console.WriteLine("  pointer=" + ptr);
        string block;
        if (Rc("READ_nc_current_block", cnc.READ_nc_current_block(out block)) == "NormalTermination") Console.WriteLine("  block=" + block);

        int parts, req, total;
        if (Rc("READ_part_count", cnc.READ_part_count(out parts, out req, out total)) == "NormalTermination")
            Console.WriteLine("  parts=" + parts + " required=" + req + " total=" + total);

        int powerOn, cutting, cycle, work;
        if (Rc("READ_time", cnc.READ_time(out powerOn, out cutting, out cycle, out work)) == "NormalTermination")
            Console.WriteLine("  powerOn=" + powerOn + " cutting=" + cutting + " cycle=" + cycle + " work=" + work);

        float ovFeed, ovSp, actFeed; int actSp;
        if (Rc("READ_spindle", cnc.READ_spindle(out ovFeed, out ovSp, out actFeed, out actSp)) == "NormalTermination")
            Console.WriteLine("  ovFeed=" + ovFeed + " ovSpindle=" + ovSp + " feed=" + actFeed + " rpm=" + actSp);

        string[] names, units; short dec; float[] mach, abs, rel, dist;
        if (Rc("READ_position", cnc.READ_position(out names, out dec, out units, out mach, out abs, out rel, out dist)) == "NormalTermination")
            for (int i = 0; i < names.Length; i++) Console.WriteLine("  " + names[i] + " mach=" + mach[i] + " abs=" + abs[i]);

        bool isAlarm; string[] msgs; DateTime[] times;
        if (Rc("READ_alm_current", cnc.READ_alm_current(out isAlarm, out msgs, out times)) == "NormalTermination")
            Console.WriteLine("  alarm=" + isAlarm + " " + J(msgs));

        long free;
        if (Rc("READ_nc_freespace", cnc.READ_nc_freespace(out free)) == "NormalTermination") Console.WriteLine("  ncFree=" + free);
        List(cnc);
    }

    static void Status(SyntecRemoteCNC cnc)
    {
        string mainProg, curProg, mode, status, alarm, emg; int seq;
        short rc = cnc.READ_status(out mainProg, out curProg, out seq, out mode, out status, out alarm, out emg);
        int ptr = -1;
        cnc.READ_nc_pointer(out ptr);
        Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " status rc=" + rc + " main=" + mainProg + " cur=" + curProg +
            " seq=" + seq + " line=" + ptr + " mode=" + mode + " status=" + status + " alarm=" + alarm + " emg=" + emg);
    }

    static void List(SyntecRemoteCNC cnc)
    {
        string[][] list;
        if (Rc("READ_nc_mem_list", cnc.READ_nc_mem_list(out list)) != "NormalTermination" || list == null) return;
        foreach (string[] row in list) Console.WriteLine("  " + J(row));
    }

    // Second half of UPLOAD_nc_mem: asks the controller to move \DiskC\ServerTmp\Tmp\<kind> into place.
    static void Install(SyntecRemoteCNC cnc, int methods)
    {
        const BindingFlags inst = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        object remoteObj = typeof(SyntecRemoteCNC).GetField("m_RemoteObj", inst).GetValue(cnc);
        IntPtr link = (IntPtr)remoteObj.GetType().GetField("m_TCPClientLink", inst).GetValue(remoteObj);
        Type tcp = Type.GetType("Syntec.OpenCNC.OcApiTCP, Syntec.OpenCNC", true);
        Type kind = tcp.GetNestedType("TModifyMethods");
        MethodInfo m = tcp.GetMethod("MultiTCPInstall", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        object result = m.Invoke(null, new object[] { link, Enum.ToObject(kind, methods) });
        Console.WriteLine("MultiTCPInstall(" + Enum.ToObject(kind, methods) + ") link=" + link + " -> " + result);
    }

    static void Upload(SyntecRemoteCNC cnc, string file)
    {
        if (file == null || !File.Exists(file)) { Console.WriteLine("file not found: " + file); return; }
        Rc("UPLOAD_nc_mem", cnc.UPLOAD_nc_mem(Path.GetFullPath(file)));
        DateTime until = DateTime.Now.AddSeconds(60);
        while (!cnc.isFileUploadDone && DateTime.Now < until)
        {
            Console.WriteLine("  progress " + cnc.FileUploadCurrentProgress + "/" + cnc.FileUploadTotalProgress);
            Thread.Sleep(500);
        }
        Console.WriteLine("  done=" + cnc.isFileUploadDone + " error=" + cnc.FileUploadErrorCode);
        List(cnc);
    }
}
