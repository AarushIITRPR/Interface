"use client";
import {useCallback,useState} from "react";
import {SubjectFrame} from "../subject/subject-frame";
import {NBackTask} from "../subject/nback-task";

export default function NBackPractice(){
  const [complete,setComplete]=useState(false);
  const [audio,setAudio]=useState(true);
  const act=useCallback(async(action:string)=>{
    if(action==="taskComplete")setComplete(true);
  },[]);
  return <SubjectFrame code="Preview" progress={complete?100:0} label="Memory task" showLabel={false}
    title={complete?"Test complete.":<>Stay with<br/><i>the sequence.</i></>}
    description={complete?"This preview does not save responses.":"Press Match when the square repeats the previous position. Otherwise, wait."}
    audioEnabled={audio} setAudioEnabled={setAudio} allowSwitch={false} changeSession={()=>{}}>
    {complete?<button className="paper-button" onClick={()=>setComplete(false)}>Watch again</button>:
      <div className="live-subject-task task-nback"><NBackTask step={{id:"preview"}} level={1} active act={act}/></div>}
  </SubjectFrame>;
}
