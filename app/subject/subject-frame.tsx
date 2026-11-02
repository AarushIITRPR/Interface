"use client";
import {createContext, useState, type ReactNode} from "react";
import {Volume2, VolumeX} from "lucide-react";
import {MotionConfig, motion} from "motion/react";
import {PortalHeader} from "../portal-header";

export const SubjectCopySlot = createContext<HTMLDivElement | null>(null);

export function SubjectFrame({code,progress,label,title,description,audioEnabled,setAudioEnabled,changeSession,endSession,children,allowSwitch=true,showLabel=true}:{showLabel?:boolean;allowSwitch?:boolean;endSession?:()=>void;code:string;progress:number;label:string;title:ReactNode;description:string;audioEnabled:boolean;setAudioEnabled:(value:boolean)=>void;changeSession:()=>void;children:ReactNode}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return <SubjectCopySlot.Provider value={slot}><MotionConfig reducedMotion="user"><main className="live-subject"><PortalHeader role="Subject" endSession={endSession} changeSession={allowSwitch?changeSession:undefined}/><div className="live-subject-progress" aria-hidden="true"><motion.i initial={false} animate={{width:`${Math.max(0,Math.min(progress,100))}%`}} /></div><section className="live-subject-stage"><motion.div className="live-subject-copy" key={`${code}-${label}`} initial={{opacity:0,y:7}} animate={{opacity:1,y:0}}>{showLabel && <p className="live-subject-label">{label}</p>}<h1>{title}</h1><p className="live-subject-description">{description}</p><div ref={setSlot}/><div className="live-subject-actions"><button className="live-subject-secondary" onClick={()=>setAudioEnabled(!audioEnabled)} aria-pressed={audioEnabled}>{audioEnabled?<Volume2 size={16}/>:<VolumeX size={16}/>} {audioEnabled?"AUDIO ON":"AUDIO OFF"}</button></div></motion.div><div className="live-subject-field">{children}</div></section><p className="sr-only" aria-live="polite">Audio is {audioEnabled?"on":"off"}.</p></main></MotionConfig></SubjectCopySlot.Provider>;
}
