"""Build the small Windows GUI installer. --refresh-lock explicitly updates pinned downloads.
--verify extracts the exact private runtime into .local-run and imports all sensor drivers;
it never registers the protocol handler, starts sensors, or touches the user's installation."""
import argparse, hashlib, json, os, subprocess, sys, urllib.request, zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = ROOT / ".local-run" / "recorder-build"
LOCK = HERE / "downloads.lock"
PYTHON = "3.13.12"
WHEELS = {
    "opencv-python": ("4.12.0.88", "cp37-abi3-win_amd64"),
    "numpy": ("2.2.6", "cp313-cp313-win_amd64"),
    "sounddevice": ("0.5.3", "py3-none-win_amd64"),
    "cffi": ("1.17.1", "cp313-cp313-win_amd64"),
    "pycparser": ("2.22", "py3-none-any"),
    "pyserial": ("3.5", "py2.py3-none-any"),
    "websocket-client": ("1.8.0", "py3-none-any"),
}
def fetch(url):
    if not url.startswith(("https://www.python.org/", "https://files.pythonhosted.org/", "https://pypi.org/pypi/")):
        raise ValueError("Unexpected package source")
    with urllib.request.urlopen(url, timeout=90) as r:
        return r.read()

def cached(url, sha=None):
    file = CACHE / url.rsplit("/",1)[1]
    if not file.is_file(): file.write_bytes(fetch(url))
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    if sha and digest != sha: raise ValueError(f"Digest mismatch: {file.name}")
    return file, digest

def refresh():
    url=f"https://www.python.org/ftp/python/{PYTHON}/python-{PYTHON}-embed-amd64.zip"
    rows=[("runtime",cached(url)[1],url)]
    for name,(version,tag) in WHEELS.items():
        meta=json.loads(fetch(f"https://pypi.org/pypi/{name}/{version}/json"))
        link=next(w for w in meta["urls"] if w["filename"].endswith(tag+".whl"))
        rows.append(("wheel",link["digests"]["sha256"],link["url"]))
    LOCK.write_text("\n".join("\t".join(row) for row in rows)+"\n",encoding="ascii")

def build(verify):
    source = CACHE / "agent.zip"
    with zipfile.ZipFile(source,"w",zipfile.ZIP_DEFLATED) as z:
        for f in sorted((HERE.parent / "meridian_agent").glob("*.py")):
            z.write(f,"meridian_agent/"+f.name)
    dest=ROOT/"public"/"recorder-tools"/"MeridianRecorderSetup.exe"
    dest.parent.mkdir(exist_ok=True)
    csc=Path(os.environ["WINDIR"])/"Microsoft.NET"/"Framework64"/"v4.0.30319"/"csc.exe"
    subprocess.run([str(csc),"/nologo","/target:winexe","/platform:x64","/optimize+",
        "/r:System.Windows.Forms.dll","/r:System.IO.Compression.dll","/r:System.IO.Compression.FileSystem.dll",
        "/r:System.Web.Extensions.dll","/resource:"+str(source)+",agent.zip",
        "/resource:"+str(LOCK)+",downloads.lock","/out:"+str(dest),str(HERE/"Recorder.cs")],check=True)
    if verify:
        for _,digest,url in (row.split("\t") for row in LOCK.read_text().splitlines()): cached(url,digest)
        with TemporaryDirectory(dir=CACHE) as temp:
            subprocess.run([str(dest),"--verify-runtime",str(CACHE),temp],check=True,timeout=150)
    print(dest)

if __name__=="__main__":
    args=argparse.ArgumentParser()
    args.add_argument("--refresh-lock",action="store_true")
    args.add_argument("--verify",action="store_true")
    a=args.parse_args();CACHE.mkdir(parents=True,exist_ok=True)
    if a.refresh_lock: refresh()
    build(a.verify)
