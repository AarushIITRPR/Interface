import { getOperatorUser } from "@/app/operator-auth";
import { defaultProtocolTemplate } from "@/lib/protocol";
import { TemplateError, sanitizeTemplate } from "@/lib/protocol-template";
import { activeTemplate, ensureSchema, getBindings } from "@/lib/session-engine";

export const dynamic = "force-dynamic";

/** The active template, or the built-in protocol as an editable starting point when none has been saved. */
export async function GET() {
  if (!await getOperatorUser()) return Response.json({error:"Instructor authorization is required."},{status:401});
  await ensureSchema();
  const saved = await activeTemplate();
  return Response.json({ template: saved ?? defaultProtocolTemplate(), saved: Boolean(saved) });
}

/**
 * Save a new version and make it active.
 *
 * Templates are append-only: every save writes a new row rather than editing the previous one, so a session that
 * copied version 3 can still be explained after version 4 exists.
 */
export async function POST(request: Request) {
  if (!await getOperatorUser()) return Response.json({error:"Instructor authorization is required."},{status:401});
  await ensureSchema();
  let template;
  try {
    template = sanitizeTemplate((await request.json() as { template?: unknown }).template, await activeTemplate() ?? undefined);
  } catch (error) {
    if (error instanceof TemplateError) return Response.json({error:error.message},{status:400});
    return Response.json({error:"That protocol could not be read."},{status:400});
  }
  const db = getBindings().DB;
  const createdAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE protocol_templates SET active = 0 WHERE active = 1`),
    db.prepare(`INSERT INTO protocol_templates (id, version, label, template_json, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .bind(crypto.randomUUID(), template.version, template.label, JSON.stringify(template), createdAt),
  ]);
  return Response.json({ template, saved: true }, { status: 201 });
}
