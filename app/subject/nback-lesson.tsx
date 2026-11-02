"use client";
import {createPortal} from "react-dom";
import {SubjectCopySlot} from "./subject-frame";
import {useContext,useEffect,useRef,useState,useSyncExternalStore} from "react";
import {decision,demonstrationSequence,DEMO_SLIDES,NBACK_PACE,places} from "@/lib/nback";

export function PositionGrid({lit}:{lit:number|null}){
  return <div className="nback-grid" role="img" aria-label={lit===null?"Blank grid":"Lit square: "+places[lit]}>
    {Array.from({length:9},(_,i)=><div key={i} className={lit===i?"lit":""}/>)}
  </div>;
}

export function MatchControl({disabled,press}:{disabled:boolean;press:()=>void}){
  const button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{
    if(e.code!=="Space"||e.metaKey||e.ctrlKey||e.altKey)return;
    const control=e.target instanceof HTMLElement && e.target.closest("button,a,input,summary,select,textarea");
    if(control && control!==button.current)return;
    e.preventDefault();if(!e.repeat)button.current?.click();
  };window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[]);
  return <button ref={button} className="match-button" aria-keyshortcuts="Space" disabled={disabled} onClick={press}>Match</button>;
}

const phaseMs=[350,NBACK_PACE.visibleMs-350,NBACK_PACE.gapMs];
const watchVisibility=(notify:()=>void)=>{document.addEventListener("visibilitychange",notify);return()=>document.removeEventListener("visibilitychange",notify);};

function TeachingHand({pressed}:{pressed:boolean}){
  return <svg className="nb-hand" data-tap={pressed} aria-hidden="true" viewBox="0 0 108 100">
    <g className="nb-touch" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="M15 15l-6-5m14 0-2-7M9 23l-7-1"/>
    </g>
    <path d="M72 97c-9-10-21-13-27-22L24 52c-6-7 1-14 7-9l14 12L21 27c-6-7 2-15 9-9l25 23c-1-7 6-9 10-5l6 6c0-6 6-8 10-4l6 7c2-5 7-5 11 0 9 11 10 19 7 31l-3 13" fill="var(--live-paper-light)" stroke="currentColor" strokeWidth="2.7" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>;
}

export function NBackLesson({level,active,start}:{level:number;active:boolean;start:()=>Promise<void>}){
  const slot = useContext(SubjectCopySlot);
  const [tick,setTick]=useState(0);
  const remainder=useRef({tick:0,ms:phaseMs[0]});
  const visible=useSyncExternalStore(watchVisibility,()=>!document.hidden,()=>false);
  const [starting,setStarting]=useState(false),[error,setError]=useState("");
  const lock=useRef(false);
  const over=tick===DEMO_SLIDES*3, index=Math.min(DEMO_SLIDES-1,Math.floor(tick/3)),phase=tick%3;
  useEffect(()=>{
    if(!active||!visible||over)return;
    if(remainder.current.tick!==tick)remainder.current={tick,ms:phaseMs[tick%3]};
    const began=performance.now(),left=remainder.current.ms;
    const timer=setTimeout(()=>setTick(t=>Math.min(DEMO_SLIDES*3,t+1)),left);
    return()=>{clearTimeout(timer);remainder.current.ms=Math.max(0,left-(performance.now()-began));};
  },[active,visible,over,tick]);
  const sequence=demonstrationSequence(level);
  const action=decision(sequence,index,level);
  const reference=index>=level?sequence[index-level]:null;
  const pressed=!over && phase===1 && action==="match";
  const caption=action==="remember"?"":action==="match"
    ?(level===1?"Same position as the previous slide, so Match is pressed.":`Same position as ${level} slides ago, so Match is pressed.`)
    :"Different position. No press.";
  const begin=async()=>{
    if(!active||lock.current)return;lock.current=true;setStarting(true);setError("");
    try{await start();}catch{setError("Could not start the task. Try again.");}finally{lock.current=false;setStarting(false);}
  };
  return <section className="nb-simulation" data-playing={active&&visible&&!over} data-phase={phase} aria-label="Watch-only memory demonstration">
    {slot && createPortal(<div className="nb-instructions">
      <h1>Watch the<br/><i>example.</i></h1>
      <p className="live-subject-description">Each slide lights up one square. In the test, press <strong>Match</strong> or the space bar if the square is in the same place as on {level===1?"the previous slide":`the slide ${level} turns back`}. If it’s in a different place, wait.</p>
      <p className="live-subject-description">Just watch for now. The small grid shows {level===1?"the previous slide":`the slide ${level} turns back`} during the example. In the test, you’ll remember it yourself.</p>
      <button className="paper-button nb-start" disabled={!active||starting} onClick={()=>void begin()}>{starting?"Starting…":"Understood, start test"}</button>
      {error && <p role="alert">{error}</p>}
    </div>,slot)}
    <div className="nb-canvas">
      {over ? <div className="nb-finished"><h2>Example complete.</h2><p>Select “Understood, start test” when you’re ready.</p></div> : <>
        <p className="nb-mast">Slide {String(index+1).padStart(2,"0")} of {DEMO_SLIDES}</p>
        <aside className="nb-reference" aria-label="Comparison grid"><h3>{level===1?"Previous slide":level+" slides ago"}</h3><PositionGrid lit={reference}/></aside>
        <div className="nb-current"><h2>Current slide</h2><PositionGrid lit={phase===2?null:sequence[index]}/>
          <div className="nb-tap-stage" aria-hidden="true"><div className="nb-tap-target" data-pressed={pressed}>Match</div><TeachingHand pressed={pressed}/></div>
        </div>
        <p className="nb-explanation" role="status">{caption}</p>
      </>}
    </div>
  </section>;
}
