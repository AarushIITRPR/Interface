import Link from "next/link";
import type {ReactNode} from "react";

export function PortalHeader({role,endSession,changeSession,navigation}:{
  role:"Subject"|"Instructor"; endSession?:()=>void; changeSession?:()=>void; navigation?:ReactNode;
}) {
  return <header className={`portal-header portal-header-${role.toLowerCase()}`}>
    <div className="portal-header-left">
      {changeSession && <button type="button" data-tone="danger" disabled={!endSession} onClick={endSession}>End session</button>}
      {navigation}
    </div>
    <Link className="portal-header-title" href="/">Meridian-{role}</Link>
    {changeSession && <button className="portal-header-switch" type="button" onClick={changeSession}>Change session</button>}
  </header>;
}
