// Uses only the Windows .NET Framework; no SDK, NuGet or model process required.
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Management;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;

public static class AxConsole {
 [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public short Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size,Cursor; public short Attr; public Rect Window; public Coord Max; }
 [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode, Size=20)] public struct Record {
  [FieldOffset(0)] public short Type;
  [FieldOffset(4)] public int Down;
  [FieldOffset(8)] public short Repeat;
  [FieldOffset(10)] public short Key;
  [FieldOffset(14)] public char Char;
 }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr sec,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h,out Info info);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ReadConsoleOutputCharacter(IntPtr h,[Out] char[] text,uint count,Coord at,out uint read);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(IntPtr h,Record[] input,uint count,out uint written);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static IntPtr Open(string name) {
  var h=CreateFile(name,0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
  if(h==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
  return h;
 }
 static string Snapshot() {
  var h=Open("CONOUT$"); try {
   Info info; Check(GetConsoleScreenBufferInfo(h,out info));
   var text=new StringBuilder();
   for(int y=info.Window.Top;y<=info.Window.Bottom;y++) {
    uint read; var row=new char[info.Size.X];
    Check(ReadConsoleOutputCharacter(h,row,(uint)row.Length,new Coord { X=0,Y=(short)y },out read));
    text.AppendLine(new string(row,0,(int)read).TrimEnd());
   }
   return text.ToString();
  } finally { CloseHandle(h); }
 }
 static void Send(string text) {
  var h=Open("CONIN$"); try {
   var records=new Record[text.Length*2];
   for(int i=0;i<text.Length;i++) {
    var r=new Record {Type=1,Down=1,Repeat=1,Char=text[i],Key=(short)(text[i]=='\r'?13:0)};
    records[i*2]=r; r.Down=0; records[i*2+1]=r;
   }
   uint written; Check(WriteConsoleInput(h,records,(uint)records.Length,out written));
   if(written!=records.Length) throw new Exception("Partial console delivery; do not retry automatically.");
  } finally { CloseHandle(h); }
 }
 static string Get(Dictionary<string,object> payload, string key) {
  object value; return payload.TryGetValue(key,out value) ? value as string : null;
 }
 static Dictionary<string,object> Identity(int pid) {
  using(var proc=Process.GetProcessById(pid)) {
   if(proc.ProcessName!="agy") throw new Exception("Target is not agy.exe");
   return new Dictionary<string,object> { {"pid",pid}, {"startedAt",proc.StartTime.ToUniversalTime().ToString("o")} };
  }
 }
 static bool Headless(string commandLine) {
  return Regex.IsMatch(commandLine ?? "", @"--input-format|--print(?:\s|=|$)|(?:^|\s)-p(?:\s|$)");
 }
 public static int Main(string[] args) {
  Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
  // AttachConsole replaces standard handles. Preserve the caller's pipe first.
  var reply=Console.Out;
  var json=new JavaScriptSerializer { MaxJsonLength=1024*1024 };
  try {
   int pid=int.Parse(args[0]); var action=args[1];
   if(pid<=0) throw new Exception("A positive PID is required");
   var payload=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
   if(action!="snapshot" && action!="send" && action!="ancestor") throw new Exception("Unsupported console action");
   if(action=="ancestor") {
    for(int i=0;i<12 && pid>0;i++) {
     using(var entry=new ManagementObject("Win32_Process.Handle='"+pid+"'")) {
      entry.Get();
      if((string)entry["Name"]=="agy.exe") {
       var result=Headless((string)entry["CommandLine"]) ? new Dictionary<string,object> {{"ignored",true}} : Identity(pid);
       reply.WriteLine(json.Serialize(result)); return 0;
      }
      pid=Convert.ToInt32(entry["ParentProcessId"]);
     }
    }
    throw new Exception("No interactive agy ancestor found");
   }
   var identity=Identity(pid);
   using(var entry=new ManagementObject("Win32_Process.Handle='"+pid+"'")) {
    entry.Get();
    if(Headless((string)entry["CommandLine"])) throw new Exception("Target is not an interactive agy console");
   }
   if(Get(payload,"startedAt")!=null && Get(payload,"startedAt")!=(string)identity["startedAt"]) throw new Exception("Process identity changed");
   FreeConsole(); Check(AttachConsole((uint)pid));
   var screen=Snapshot();
   if(action=="send") {
    if(Get(payload,"expectedScreen")!=screen) throw new Exception("Console changed before delivery; input was not sent");
    var text=Get(payload,"text");
    if(text==null || text.Length>65536) throw new Exception("Invalid console input");
    // Recheck identity immediately before mutating the console input queue.
    if((string)Identity(pid)["startedAt"]!=(string)identity["startedAt"]) throw new Exception("Process identity changed");
    Send(text);
   }
   FreeConsole(); identity["screen"]=screen;
   reply.WriteLine(json.Serialize(identity)); return 0;
  } catch(Exception e) {
   FreeConsole(); reply.WriteLine(json.Serialize(new Dictionary<string,object> {{"error",e.Message}})); return 1;
  }
 }
}
