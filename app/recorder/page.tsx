"use client";
import {useSyncExternalStore} from "react";
const watchHash=(notify:()=>void)=>{window.addEventListener("hashchange",notify);return ()=>window.removeEventListener("hashchange",notify);};
export default function RecorderPair(){
  const hash=useSyncExternalStore(watchHash,()=>location.hash,()=>"");
  const args=new URLSearchParams(hash.slice(1));
  const code=args.get("code")||"", secret=args.get("key")||"";
  const link=/^[A-Z0-9]{5,16}$/.test(code)&&/^[0-9a-f]{48}$/.test(secret)?"meridian-recorder://pair?"+new URLSearchParams({server:location.origin,code,key:secret}):"";
  return <main className="recorder-pair"><h1>Connect this computer</h1><p>Use the Windows computer plugged into the sensors.</p>
    {link?<><a className="wizard-primary" href={link}>Open Meridian Recorder</a><p>Confirm this study in the recorder window. Then return to Recording setup.</p></>:<p>Request a new pairing link from Recording setup.</p>}
    <a href="/recorder-tools/MeridianRecorderSetup.exe" download>Download Windows recorder</a></main>;
}
