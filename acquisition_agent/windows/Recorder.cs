// Per-user Windows x64 installer and meridian-recorder:// handler. No shell commands.
using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Collections.Generic;
using System.Reflection;
using System.Security.Cryptography;
using System.Net;
using System.Threading;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;

class Recorder {
  const string Scheme="meridian-recorder";
  static readonly string Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Meridian","Recorder");
  static readonly string Output=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"Meridian recordings");
  static Stream Resource(string name){return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);}
  static string Digest(Stream data){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();}
  static void Extract(Stream stream,string root,bool wheel){
    string prefix=Path.GetFullPath(root)+Path.DirectorySeparatorChar;
    using(var zip=new ZipArchive(stream,ZipArchiveMode.Read,true))foreach(var e in zip.Entries){
      var name=e.FullName.Replace('\\','/');
      if(name.EndsWith("/"))continue;
      if(wheel && name.Contains(".data/")){
        var m=Regex.Match(name,@"^[^/]+\.data/(purelib|platlib)/(.*)$");
        if(m.Success)name=m.Groups[2].Value;
        else if(!name.Contains(".data/data/"))continue;
      }
      string dest=Path.GetFullPath(Path.Combine(root,name));
      if(!dest.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new IOException("Invalid archive path.");
      Directory.CreateDirectory(Path.GetDirectoryName(dest));
      using(var input=e.Open())using(var output=File.Create(dest))input.CopyTo(output);
    }
  }
  static void Prepare(string root,string cache,Action<string> report){
    Directory.CreateDirectory(root);
    using(var reader=new StreamReader(Resource("downloads.lock")))for(string line;(line=reader.ReadLine())!=null;){
      var f=line.Split('\t');var uri=new Uri(f[2]);var name=Path.GetFileName(uri.LocalPath);
      report("Preparing "+name);
      if(uri.Scheme!="https" || (uri.Host!="www.python.org" && uri.Host!="files.pythonhosted.org"))throw new IOException("Invalid source.");
      byte[] bytes;
      if(cache!=null)bytes=File.ReadAllBytes(Path.Combine(cache,name));else using(var client=new WebClient())bytes=client.DownloadData(uri);
      using(var ms=new MemoryStream(bytes)){
        if(Digest(ms)!=f[1])throw new IOException("Download verification failed for "+name);
        ms.Position=0;Extract(ms,f[0]=="runtime"?root:Path.Combine(root,"packages"),f[0]=="wheel");
      }
    }
    using(var zip=Resource("agent.zip"))Extract(zip,root,false);
    File.WriteAllText(Path.Combine(root,"python313._pth"),"python313.zip\n.\npackages\n");
    var check=new ProcessStartInfo(Path.Combine(root,"python.exe"),"-c \"import numpy,cv2,sounddevice,serial,websocket,meridian_agent.agent\""){
      UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true,WorkingDirectory=root};
    using(var p=Process.Start(check)){var err=p.StandardError.ReadToEnd();p.WaitForExit();if(p.ExitCode!=0)throw new IOException("Recorder self-test failed: "+err);}
  }
  static Dictionary<string,string> Fields(string query){
    var fields=new Dictionary<string,string>();
    foreach(var field in query.TrimStart('?').Split('&')){var parts=field.Split(new[]{'='},2);if(parts.Length!=2)throw new FormatException();fields.Add(parts[0],Uri.UnescapeDataString(parts[1]));}
    return fields;
  }
  static void Connect(string link){
    var u=new Uri(link);
    if(u.Scheme!=Scheme||u.Host!="pair"||u.UserInfo!=""||u.Fragment!=""||u.AbsolutePath!="/")throw new FormatException("Invalid recorder link.");
    var f=Fields(u.Query);var server=new Uri(f["server"]);
    if(f.Count!=3||server.UserInfo!=""||server.AbsolutePath!="/"||server.Query!=""||server.Fragment!=""||
      !(server.Scheme=="https"||(server.Scheme=="http"&&server.IsLoopback))||
      !Regex.IsMatch(f["code"],@"\A[A-Z0-9]{5,16}\z")||!Regex.IsMatch(f["key"],@"\A[a-f0-9]{48}\z"))throw new FormatException("Invalid pairing details.");
    if(MessageBox.Show("Allow "+server.Authority+" to connect to sensors on this computer for session "+f["code"]+"?\n\nOnly continue if this is the study you opened. Recordings will be saved in:\n"+Output,
        "Meridian Recorder",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
    bool free;
    using(var mutex=new Mutex(true,@"Local\MeridianRecorderAgent",out free)){
      if(!free)throw new IOException("A recorder is already running on this computer. End that session before connecting another.");
      var json=new JavaScriptSerializer();var request=(HttpWebRequest)WebRequest.Create(new Uri(server,"/api/recorder-pair"));
      request.Method="POST";request.AllowAutoRedirect=false;request.ContentType="application/json";request.Timeout=15000;
      byte[] payload=Encoding.UTF8.GetBytes(json.Serialize(new {action="redeem", code=f["code"], secret=f["key"]}));
      using(var body=request.GetRequestStream())body.Write(payload,0,payload.Length);
      Dictionary<string,string> pair;
      using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream()))pair=json.Deserialize<Dictionary<string,string>>(reader.ReadToEnd());
      if(pair["code"]!=f["code"]||!Regex.IsMatch(pair["token"],@"\Amac_[0-9a-f]+\z"))throw new IOException("Invalid recorder credential.");
      Directory.CreateDirectory(Output);
      var root=Path.GetDirectoryName(Application.ExecutablePath);
      var start=new ProcessStartInfo(Path.Combine(root,"python.exe"),"-m meridian_agent --output ."){
        WorkingDirectory=Output,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
      start.EnvironmentVariables["MERIDIAN_URL"]=server.GetLeftPart(UriPartial.Authority);
      start.EnvironmentVariables["MERIDIAN_SESSION"]=pair["code"];start.EnvironmentVariables["MERIDIAN_ACQUISITION_TOKEN"]=pair["token"];
      start.EnvironmentVariables["PYTHONUNBUFFERED"]="1";
      string logfile=Path.Combine(Output,"recorder-"+pair["code"]+".log");
      using(var log=new StreamWriter(logfile,true)){log.AutoFlush=true;using(var p=new Process()){
        p.StartInfo=start;DataReceivedEventHandler write=(s,e)=>{if(e.Data!=null)lock(log)log.WriteLine(e.Data);};
        p.OutputDataReceived+=write;p.ErrorDataReceived+=write;p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();
        if(p.ExitCode!=0)throw new IOException("Recorder stopped. Check the connection and see "+logfile);
      }}
    }
  }
  static void Install(){
    if(MessageBox.Show("Install Meridian Recorder for this Windows account? The installer downloads its private Python runtime and sensor drivers. No administrator access is required.",
      "Meridian Recorder",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;
    var form=new Form{Text="Installing Meridian Recorder",Width=540,Height=140,ControlBox=false,StartPosition=FormStartPosition.CenterScreen};
    var label=new Label{Dock=DockStyle.Fill,Padding=new Padding(18),Text="Preparing recorder…"};form.Controls.Add(label);form.Show();Application.DoEvents();
    Directory.CreateDirectory(Root);var version=Path.Combine(Root,Guid.NewGuid().ToString("N"));
    Prepare(version,null,msg=>{label.Text=msg;Application.DoEvents();});
    var exe=Path.Combine(version,"MeridianRecorder.exe");File.Copy(Application.ExecutablePath,exe);
    using(var k=Registry.CurrentUser.CreateSubKey(@"Software\Classes\"+Scheme)){
      k.SetValue("","URL:Meridian Recorder");k.SetValue("URL Protocol","");
      using(var cmd=k.CreateSubKey(@"shell\open\command"))cmd.SetValue("","\""+exe+"\" \"%1\"");
    }
    form.Close();MessageBox.Show("Installed. Return to the subject display on this computer and choose Connect recorder.","Meridian Recorder");
  }
  [STAThread] static int Main(string[] args){
    ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
    bool verify=args.Length==3&&args[0]=="--verify-runtime";
    try{
      if(verify){Prepare(args[2],args[1],s=>{});return 0;}
      Application.EnableVisualStyles();
      if(args.Length==0)Install();else if(args.Length==1)Connect(args[0]);else throw new FormatException("Invalid arguments.");
      return 0;
    }catch(Exception e){
      if(verify)Console.Error.WriteLine(e.Message);
      else MessageBox.Show(e.Message+"\nReturn to the subject display and choose Get a fresh connection, then Connect recorder.","Meridian Recorder",MessageBoxButtons.OK,MessageBoxIcon.Error);
      return 1;
    }
  }
}
