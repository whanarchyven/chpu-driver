using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;

namespace CncAgent
{
    // Both Syntec client builds expose the same Syntec.Remote.SyntecRemoteCNC class but ship
    // native DLLs with the same names (OCAPI.dll, OCKrnl.dll), so each lives in its own folder
    // and only one is loaded per process. The 10.118 build (from the 10.118 PC simulator) is
    // required for file upload on 10.118 firmware; v4 fails the install step with SocketError.
    public static class SyntecLibrary
    {
        public const string Modern = "syntec-10.118";
        public const string Legacy = "syntec-v4";

        const uint LoadWithAlteredSearchPath = 0x8;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);

        static readonly object Gate = new object();
        static Type _type;

        public static string Loaded { get; private set; }

        // choice: auto | 10.118 | v4
        public static dynamic Create(string choice, string host, int timeoutMs)
        {
            lock (Gate)
            {
                if (_type == null) _type = Load(choice);
            }
            return Activator.CreateInstance(_type, host, timeoutMs);
        }

        static Type Load(string choice)
        {
            var modern = Path.Combine(Config.Dir, Modern);
            var legacy = Path.Combine(Config.Dir, Legacy);
            var wanted = (choice ?? "auto").Trim().ToLowerInvariant();
            string dir, entry;
            if (wanted == "v4" || (wanted == "auto" && !File.Exists(Path.Combine(modern, "Syntec.OpenCNC.dll"))))
            {
                dir = legacy;
                entry = "Syntec.RemoteCNC.dll";
            }
            else if (wanted == "auto" || wanted == "10.118")
            {
                dir = modern;
                entry = "Syntec.OpenCNC.dll";
            }
            else throw new ArgumentException("SyntecLib должен быть auto, 10.118 или v4, а не " + choice);

            var path = Path.Combine(dir, entry);
            if (!File.Exists(path)) throw new DllNotFoundException($"нет {path} — пересоберите флешку (syntec-libs.ps1)");
            foreach (var native in Directory.GetFiles(dir, "*.dll").Where(IsNative))
            {
                if (LoadLibraryEx(native, IntPtr.Zero, LoadWithAlteredSearchPath) == IntPtr.Zero)
                    throw new DllNotFoundException($"{Path.GetFileName(native)}: {new Win32Exception(Marshal.GetLastWin32Error()).Message}");
            }
            var assembly = Assembly.LoadFrom(path);
            Loaded = $"{Path.GetFileName(dir)} ({assembly.GetName().Version})";
            Log.Write("библиотека Syntec: " + Loaded);
            return assembly.GetType("Syntec.Remote.SyntecRemoteCNC", true);
        }

        static bool IsNative(string path)
        {
            try
            {
                AssemblyName.GetAssemblyName(path);
                return false;
            }
            catch (BadImageFormatException)
            {
                return true;
            }
        }
    }
}
