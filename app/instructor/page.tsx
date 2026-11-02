import Link from "next/link";
import { requireChatGPTUser } from "../chatgpt-auth";
import { getOperatorUser, isOperatorUser } from "../operator-auth";
import { EditorialOperatorConsole } from "./editorial-operator-console";

export const dynamic = "force-dynamic";
export const metadata = { title:"Instructor console | Meridian", description:"Research operations console" };
export default async function InstructorPage() {
  const operator = await getOperatorUser();
  const user = operator ?? await requireChatGPTUser("/instructor");
  if (!operator && !isOperatorUser(user)) {
    return <main className="preflight-shell"><section className="preflight-card"><div className="preflight-intro"><h1>Instructor access only.</h1><p>Use an authorized operator account to prepare a recording. If you are joining a study, open the subject display.</p><Link href="/subject">Open subject display</Link></div></section></main>;
  }
  return <EditorialOperatorConsole operatorName={user.displayName} />;
}
