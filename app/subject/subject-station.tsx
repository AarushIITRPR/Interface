"use client";
import {useEffect,useRef,useState,useSyncExternalStore} from "react";

import {stationRequest} from "@/lib/station-client";

const watchHash=(notify:()=>void)=>{window.addEventListener("hashchange",notify);return()=>window.removeEventListener("hashchange",notify);};

// The browser credential is HTTP-only. No acquisition token is stored in the page.
export function useStation(onAssignment:(code:string,enrolling:boolean)=>void){
  const [assigned,setAssigned]=useState<string|null>(null);
  const [issue,setIssue]=useState("");
  const invite=useSyncExternalStore(watchHash,()=>new URLSearchParams(location.hash.slice(1)).get("invite")||"",()=>"");
  const enrolling=useRef(false);const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let stopped=false,inFlight=false;
    const check=async()=>{
      if(stopped||inFlight)return;
      inFlight=true;
      if(invite){inFlight=false;return;}
      try{
        const data=await stationRequest({action:"discover"});
        if(stopped)return;
        setAssigned(data.code||null);setIssue("");
        if(data.code)onAssignment(data.code,false);
      }catch(error){
        if(!stopped && assigned)setIssue(error instanceof Error?error.message:"Could not join the study.");
      }finally{inFlight=false;}
    };
    const first=setTimeout(check,0),timer=setInterval(check,4000);
    window.addEventListener("hashchange",check);
    return()=>{stopped=true;clearTimeout(first);clearInterval(timer);window.removeEventListener("hashchange",check);};
  },[onAssignment,invite,assigned]);
  const enroll=async()=>{
    if(!invite||enrolling.current)return;
    enrolling.current=true;setBusy(true);setIssue("");
    try{
      const data=await stationRequest({action:"enroll",invite});
      if(!data.code)throw Error("The study is not available.");
      setAssigned(data.code);
      history.replaceState(null,"",location.pathname+location.search);
      onAssignment(data.code,true);
      window.dispatchEvent(new Event("hashchange"));
    }catch(e){setIssue(e instanceof Error?e.message:"Could not pair this computer.");}
    finally{enrolling.current=false;setBusy(false);}
  };
  return {assigned,issue,invite,enroll,busy};
}

export function SubjectRecorder({code}:{code:string}){
  const [uri,setUri]=useState(""),[error,setError]=useState(""),[opened,setOpened]=useState(false);
  const [version,retry]=useState(0);
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    async function prepare(){
      try{
        const data=await stationRequest({action:"ticket",code});
        if(stopped)return;
        setUri("meridian-recorder://pair?"+new URLSearchParams({server:location.origin,code,key:data.secret!}));setError("");
        // Renew only while the preparation screen is still open; installation time
        // and study duration are independent of the short-lived launch credential.
        timer=setTimeout(prepare,Math.max(1000,(data.expires||0)-Date.now()-15000));
      }catch(e){if(!stopped){setUri("");setError(e instanceof Error?e.message:"Could not prepare the recorder.");}}
    }
    timer=setTimeout(prepare,0);
    return()=>{stopped=true;clearTimeout(timer);};
  },[code,version]);
  return <section className="subject-recorder">
    {uri?<a className="wizard-primary" href={uri} onClick={()=>setOpened(true)}>{opened?"Open recorder again":"Connect recorder"}</a>:null}
    {opened && <p role="status">Confirm this study in the recorder window. This page will continue when it connects. <button onClick={()=>{setOpened(false);setUri("");retry(n=>n+1);}}>Get a fresh connection</button></p>}
    {!uri && !error && <p role="status">Preparing the connection…</p>}
    {error && <><p role="alert">{error}</p><button className="paper-button" onClick={()=>retry(n=>n+1)}>Retry connection</button></>}
    <details><summary>First time on this computer?</summary><p>Install the recorder once, then come back and select Connect recorder.</p><a download href="/recorder-tools/MeridianRecorderSetup.exe">Install Meridian Recorder for Windows (64-bit)</a></details>
  </section>;
}
