param([int]$TargetPid, [string]$Action = 'snapshot')
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
# Keep the original pipe writer: AttachConsole replaces the standard handles.
$reply = [Console]::Out
if ($Action -eq 'ancestor') {
 for ($i = 0; $i -lt 12 -and $TargetPid -gt 0; $i++) {
  $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
  if (!$entry) { break }
  if ($entry.Name -eq 'agy.exe') {
   if ($entry.CommandLine -match '--input-format|--print(?:\s|=|$)|(?:^|\s)-p(?:\s|$)') { $reply.WriteLine('{"ignored":true}'); exit 0 }
   $proc = Get-Process -Id $TargetPid
   $reply.WriteLine((@{ pid=$TargetPid; startedAt=$proc.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))
   exit 0
  }
  $TargetPid = $entry.ParentProcessId
 }
 throw 'No interactive agy ancestor found'
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
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
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr sec,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h,out Info info);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ReadConsoleOutputCharacter(IntPtr h,[Out] char[] text,uint count,Coord at,out uint read);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(IntPtr h,Record[] input,uint count,out uint written);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static void Attach(int pid) { FreeConsole(); Check(AttachConsole((uint)pid)); }
 static IntPtr Open(string name) { var h=CreateFile(name,0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero); if(h==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); return h; }
 public static string Snapshot() {
  var h=Open("CONOUT$"); try {
   Info info; Check(GetConsoleScreenBufferInfo(h,out info));
   var text=new StringBuilder();
   for(short y=info.Window.Top;y<=info.Window.Bottom;y++) {
    uint read; var row=new char[info.Size.X]; Check(ReadConsoleOutputCharacter(h,row,(uint)row.Length,new Coord { X=0,Y=y },out read)); text.AppendLine(new string(row,0,(int)read).TrimEnd());
   }
   return text.ToString();
  } finally { CloseHandle(h); }
 }
 public static void Send(string text) {
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
}
'@
try {
 $proc = Get-Process -Id $TargetPid
 if ($proc.ProcessName -ne 'agy') { throw 'Target is not agy.exe' }
 $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid").CommandLine
 if ($commandLine -match '--input-format|--print(?:\s|=|$)|(?:^|\s)-p(?:\s|$)') { throw 'Target is not an interactive agy console' }
 if ($payload.startedAt -and $proc.StartTime.ToUniversalTime().ToString('o') -ne $payload.startedAt) { throw 'Process identity changed' }
 [AxConsole]::Attach($TargetPid)
 $screen = [AxConsole]::Snapshot()
 if ($Action -eq 'send') {
  if ($payload.expectedScreen -cne $screen) { throw 'Console changed before delivery; input was not sent' }
  [AxConsole]::Send($payload.text)
 }
 $result = @{ screen = $screen; startedAt = $proc.StartTime.ToUniversalTime().ToString('o'); pid = $TargetPid }
 [AxConsole]::FreeConsole() | Out-Null
 $reply.WriteLine(($result | ConvertTo-Json -Compress))
} catch {
 [AxConsole]::FreeConsole() | Out-Null
 $reply.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
 exit 1
}
