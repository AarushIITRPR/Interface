"use client";
import {useRef, useState} from "react";
import {consentChoices, dataNames, experienceRatings, FORM_VERSION} from "@/lib/participation";

type Submit = (action:string, payload?:Record<string,unknown>)=>Promise<void>;

function useFormSave(act:Submit) {
  const lock=useRef(false);
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  async function save(action:string,payload?:Record<string,unknown>) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError("");
    try { await act(action,payload); }
    catch(e){setError(e instanceof Error?e.message:"Could not save. Please try again.");}
    finally{lock.current=false;setBusy(false);}
  }
  return {save,busy,error};
}

export function ConsentForm({sources,act}:{sources:string[];act:Submit}) {
  const [checked,setChecked]=useState([false,false,false]);
  const {save,busy,error}=useFormSave(act);
  const list=new Intl.ListFormat("en",{style:"long",type:"conjunction"}).format(sources.map(id=>dataNames[id]??id));
  return <form className="participant-form" onSubmit={e=>{
    e.preventDefault();
    if(checked.every(Boolean))void save("consent",{version:FORM_VERSION,sources,participate:checked[0],record:checked[1],research:checked[2]});
  }}>
    <h2>What we’ll record</h2>
    {list && <p>Selected sensors: {list}.</p>}
    <p>We also save task answers, timing, and any blood pressure readings taken during the study.</p>
    <p>We label study records with a participant code. Raw recordings stay on the recording computer. The study team can see sensor readings and previews in Meridian.</p>
    {sources.some(id=>["face","audio","thermal"].includes(id)) && <p>Your image or voice may identify you.</p>}
    <p>You are giving permission for the study team to use these data to train and evaluate engagement models for research. Other uses require separate permission.</p>
    <fieldset disabled={busy}><legend>Your choices</legend>
      {consentChoices.map((label,i)=><label className="participant-check" key={label}>
        <input type="checkbox" checked={checked[i]} onChange={e=>setChecked(old=>old.map((v,j)=>j===i?e.target.checked:v))}/>{label}
      </label>)}
    </fieldset>
    <div className="participant-form-actions"><button className="paper-button" type="submit" disabled={busy||!checked.every(Boolean)}>Give consent</button>
      <button type="button" data-tone="danger" disabled={busy} onClick={()=>void save("declineConsent")}>Decline</button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function FeedbackForm({act}:{act:Submit}) {
  const [rating,setRating]=useState<string|null>(null),[comment,setComment]=useState("");
  const {save,busy,error}=useFormSave(act);
  return <form className="participant-form" onSubmit={e=>{e.preventDefault();void save("feedback",{rating,comment});}}>
    <fieldset disabled={busy}><legend>How easy was it to follow the tasks?</legend>
      <div className="participant-ratings">{experienceRatings.map(value=><label key={value}>
        <input type="radio" name="experience" checked={value===rating} onChange={()=>setRating(value)}/>{value}
      </label>)}</div>
    </fieldset>
    <label htmlFor="participant-comment">What, if anything, could we make clearer?</label>
    <textarea id="participant-comment" value={comment} maxLength={500} disabled={busy} rows={3} onChange={e=>setComment(e.target.value)}/>
    <div className="participant-form-actions"><button className="paper-button" disabled={busy||(!rating&&!comment.trim())}>Send feedback</button>
      <button type="button" disabled={busy} onClick={()=>void save("feedback",{skip:true})}>Skip</button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
