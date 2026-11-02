"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {NBACK_PACE} from "@/lib/nback";
import type {SubjectStep} from "@/lib/types";
import {MatchControl,NBackLesson,PositionGrid} from "./nback-lesson";

export function NBackTask({step,level:configuredLevel,active,act}:{step:Pick<SubjectStep,"id">;level:number;active:boolean;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [level]=useState(configuredLevel);
  const [started,setStarted]=useState(false);const [lit,setLit]=useState<number|null>(null);
  const [trial,setTrial]=useState(0);const [responded,setResponded]=useState(false);
  const accepting=useRef(false);
  const elapsed=useRef({trial:-1,ms:0});
  const [finished,setFinished]=useState(false);const [error,setError]=useState("");
  const sequence=useRef<number[]>([]);const onset=useRef(0);const response=useRef<number|null>(null);
  const results=useRef<Array<{position:number;target:boolean;response:boolean;rtMs:number|null;warmup:boolean}>>([]);
  const saving=useRef(false);
  const finish=useCallback(async()=>{
    if(saving.current)return;saving.current=true;setError("");
    const scored=results.current.filter(r=>!r.warmup);
    try{await act("taskComplete",{expectedStepId:step.id,eventType:"nback_complete",label:"N-back completed",metadata:{level,...NBACK_PACE,trials:20,scoredTrials:scored.length,practiceScored:false,hits:scored.filter(r=>r.target&&r.response).length,misses:scored.filter(r=>r.target&&!r.response).length,falseAlarms:scored.filter(r=>!r.target&&r.response).length,correctRejections:scored.filter(r=>!r.target&&!r.response).length,trialResults:results.current}});}
    catch{setError("Results are still here. Check your connection, then retry saving.");}
    finally{saving.current=false;}
  },[act,level,step.id]);
  useEffect(()=>{
    if(!started||!active||finished)return;
    if(trial>=20){const done=window.setTimeout(()=>{setFinished(true);void finish();},0);return()=>clearTimeout(done);}
    if(sequence.current[trial]===undefined){let pos=Math.floor(Math.random()*9);if(trial>=level&&Math.random()<.3)pos=sequence.current[trial-level];sequence.current[trial]=pos;}
    if(elapsed.current.trial!==trial){elapsed.current={trial,ms:0};response.current=null;}
    const spent=elapsed.current.ms, resumeAt=performance.now();
    const show=window.setTimeout(()=>{setLit(spent<NBACK_PACE.visibleMs?sequence.current[trial]:null);setResponded(response.current!==null);onset.current=resumeAt-spent;accepting.current=true;},0);
    const hide=window.setTimeout(()=>setLit(null),Math.max(0,NBACK_PACE.visibleMs-spent));
    const next=window.setTimeout(()=>{
      accepting.current=false;
      results.current[trial]={position:sequence.current[trial],target:trial>=level&&sequence.current[trial]===sequence.current[trial-level],response:response.current!==null,rtMs:response.current,warmup:trial<level};
      setTrial(trial+1);
    },Math.max(0,NBACK_PACE.intervalMs-spent));
    return()=>{elapsed.current.ms=Math.min(NBACK_PACE.intervalMs,spent+performance.now()-resumeAt);accepting.current=false;clearTimeout(show);clearTimeout(hide);clearTimeout(next);};
  },[active,finish,finished,level,started,trial]);
  const press=()=>{const rt=performance.now()-onset.current;if(!active||!started||finished||!accepting.current||response.current!==null||rt>=NBACK_PACE.intervalMs)return;response.current=Math.round(rt);setResponded(true);};
  if(finished)return <section className="subject-center"><h1>Task finished.</h1><p role="status">{error||"Saving your responses…"}</p>{error?<button className="paper-button" onClick={()=>void finish()}>Retry saving</button>:null}</section>;
  if(!started)return <NBackLesson level={level} active={active} start={async()=>{
    await act("log",{eventType:"nback_scored_onset",level,...NBACK_PACE});
    setStarted(true);
  }}/>;
  return <section className="task-screen nback-running"><p>Square {Math.min(trial+1,20)} of 20</p><p>Match the position from <strong>{level} {level===1?"step":"steps"} ago</strong>.</p><PositionGrid lit={lit}/><MatchControl disabled={!active||responded} press={press}/><p role="status">{responded?"Response received":trial<level?"Watch and remember. There is no earlier square to compare yet.":"Different position? Wait for the next square."}</p><small>Click Match or press Space.</small></section>;
}
