"use client";

import {Maximize, Minimize} from "lucide-react";
import {useEffect, useRef, useState, type ReactNode, type RefObject, type VideoHTMLAttributes} from "react";

type Props = VideoHTMLAttributes<HTMLVideoElement> & {
  active:boolean;
  videoRef?:RefObject<HTMLVideoElement|null>;
  onAudioChange:(enabled:boolean)=>void;
  children?:ReactNode;
};

export function StudyPlayer({active,videoRef,hidden,onAudioChange,onPlaying,children,...props}:Props) {
  const localVideo=useRef<HTMLVideoElement>(null);
  const video=videoRef??localVideo;
  const player=useRef<HTMLDivElement>(null);
  const [fullscreen,setFullscreen]=useState(false);
  const [fullscreenError,setFullscreenError]=useState(false);
  const customFullscreen=typeof document!=="undefined" && !!document.fullscreenEnabled;
  useEffect(()=>{
    const changed=()=>setFullscreen(document.fullscreenElement===player.current);
    document.addEventListener("fullscreenchange",changed);
    return ()=>document.removeEventListener("fullscreenchange",changed);
  },[]);
  useEffect(()=>{
    if(!active || hidden){
      video.current?.pause();
      if(player.current && document.fullscreenElement===player.current)void document.exitFullscreen().catch(()=>{});
    }
  },[active,hidden,video]);
  const toggleFullscreen=async()=>{
    try{
      setFullscreenError(false);
      if(document.fullscreenElement===player.current)await document.exitFullscreen();
      else await player.current?.requestFullscreen();
    }catch{setFullscreenError(true);}
  };
  return <div className="study-player" ref={player} hidden={hidden}>
    <div className="study-player-picture">
      {/* Research clips retain their original audio and video tracks. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video {...props} ref={video} controls controlsList={customFullscreen?"nofullscreen":undefined}
        disablePictureInPicture playsInline preload="metadata"
        onPlaying={e=>{if(active)onPlaying?.(e);else e.currentTarget.pause();}}
        onVolumeChange={e=>onAudioChange(!e.currentTarget.muted)}/>
      {children && <div className="study-player-guide">{children}</div>}
    </div>
    {customFullscreen && <div className="study-player-footer">
      <button type="button" onClick={()=>void toggleFullscreen()}>
        {fullscreen?<Minimize size={16}/>:<Maximize size={16}/>}
        {fullscreen?"Exit fullscreen":"Fullscreen"}
      </button>
    </div>}
    {fullscreenError && <p role="status">Fullscreen is unavailable in this window.</p>}
  </div>;
}
