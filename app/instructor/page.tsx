import { requireChatGPTUser } from "../chatgpt-auth";
import { getOperatorUser, isOperatorUser } from "../operator-auth";
import { InstructorConsole } from "./instructor-console";

export const dynamic = "force-dynamic";
export const metadata = { title:"Instructor console | Meridian", description:"Research operations console" };
export default async function InstructorPage() {
  const operator = await getOperatorUser();
  const user = operator ?? await requireChatGPTUser("/instructor");
  if (!operator && !isOperatorUser(user)) {
    return <main className="preflight-shell"><section className="preflight-card"><div className="preflight-intro"><p className="eyebrow">Restricted</p><h1>Instructor access only.</h1><p>This account is not authorized to operate data collection sessions.</p></div></section></main>;
  }
  return <InstructorConsole operatorName={user.displayName} />;
}
