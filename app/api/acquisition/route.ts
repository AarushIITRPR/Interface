import { acquisitionCommand, getSession, mutateSession } from "@/lib/session-engine";

export const dynamic = "force-dynamic";

type AgentRequest = {
  code?: string;
  token?: string;
  action?: "poll" | "heartbeat" | "finalize";
  agent?: Record<string,unknown>;
  sensors?: unknown[];
  recordings?: unknown[];
};

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  try {
    const body = await request.json() as AgentRequest;
    const code = String(body.code ?? "").trim().toUpperCase().slice(0,16);
    const token = String(body.token ?? "").trim().slice(0,96);
    if (!code || !token) return Response.json({error:"Session code and acquisition token are required."},{status:400});
    const session = await getSession(code);
    if (!session) return Response.json({error:"Session not found."},{status:404});
    if (!constantTimeEqual(token,session.acquisitionToken)) return Response.json({error:"Invalid acquisition token."},{status:403});

    let current = session;
    if (body.action === "heartbeat") {
      const agent = body.agent ?? {};
      current = await mutateSession(code,"acquisitionHeartbeat",{
        agentId:agent.id,host:agent.host,platform:agent.platform,version:agent.version,
        recordingRoot:agent.recordingRoot,inventory:agent.inventory,diskFreeGb:agent.diskFreeGb,
        estimatedHours:agent.estimatedHours,clockOffsetMs:agent.clockOffsetMs,openFileCount:agent.openFileCount,
        droppedPct:agent.droppedPct,previewUrls:agent.previewUrls,configRevision:agent.configRevision,
        preflightTest:agent.preflightTest,sensors:Array.isArray(body.sensors)?body.sensors:[],
      }) ?? session;
    } else if (body.action === "finalize") {
      current = await mutateSession(code,"acquisitionFinalize",{recordings:Array.isArray(body.recordings)?body.recordings:[]}) ?? session;
    } else if (body.action !== "poll") {
      return Response.json({error:"Unsupported acquisition action."},{status:400});
    }
    return Response.json({command:{...acquisitionCommand(current),serverReceivedAt:receivedAt}},{headers:{"cache-control":"no-store"}});
  } catch (error) {
    return Response.json({error:error instanceof Error?error.message:"Unable to update acquisition state."},{status:500});
  }
}

function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length,b.length);
  for (let index=0;index<length;index++) different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return different === 0;
}
