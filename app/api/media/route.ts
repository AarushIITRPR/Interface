import { ensureSchema, getBindings } from "@/lib/session-engine";
import { getOperatorUser } from "@/app/operator-auth";

export const dynamic = "force-dynamic";

/**
 * Upload ceiling, in step with `experimental.serverActions.bodySizeLimit` in next.config.ts.
 *
 * That setting is the one that actually bites: the runtime applies it to every multipart POST before this handler
 * runs, so a larger number here would only produce a bare 413 that never reaches our error message. Keep the two
 * in step, and keep both at or below the Cloudflare Workers request body ceiling of 100 MB.
 */
const MAX_UPLOAD_MB = 100;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export async function GET(request: Request) {
  await ensureSchema();
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (key) {
    const object = await getBindings().MEDIA.get(key);
    if (!object) return new Response("Not found",{status:404});
    const headers = new Headers();
    object.writeHttpMetadata(headers); headers.set("etag",object.httpEtag); headers.set("cache-control","public, max-age=86400");
    return new Response(object.body,{headers});
  }
  if (!await getOperatorUser()) return Response.json({error:"Instructor authorization is required."},{status:401});
  const rows = await getBindings().DB.prepare(`SELECT id, object_key, filename, content_type, size, duration_sec, created_at FROM media_assets ORDER BY created_at DESC LIMIT 100`).all();
  return Response.json({assets:rows.results});
}

export async function POST(request: Request) {
  if (!await getOperatorUser()) return Response.json({error:"Instructor authorization is required."},{status:401});
  await ensureSchema();
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({error:"Choose a media file."},{status:400});
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({error:`That file is ${(file.size / 1e6).toFixed(0)} MB. The limit is ${MAX_UPLOAD_MB} MB.`},{status:413});
  // The browser reads the real length before uploading. Workers cannot decode media, so this is the only chance to
  // measure it, and a clip stored without a duration would mis-time every session that used it.
  const durationSec = Number(form.get("durationSec"));
  const playable = (file.type || "").startsWith("video/") || (file.type || "").startsWith("audio/");
  if (playable && !(Number.isFinite(durationSec) && durationSec > 0)) {
    return Response.json({error:"Could not read the length of that file. It may be corrupt or in a format this browser cannot play."},{status:400});
  }
  const id = crypto.randomUUID();
  const key = `media/${id}/${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
  await getBindings().MEDIA.put(key,file.stream(),{httpMetadata:{contentType:file.type || "application/octet-stream"}});
  const createdAt = new Date().toISOString();
  const measured = playable ? Math.round(durationSec * 10) / 10 : null;
  await getBindings().DB.prepare(`INSERT INTO media_assets (id, object_key, filename, content_type, size, duration_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id,key,file.name,file.type || "application/octet-stream",file.size,measured,createdAt).run();
  return Response.json({asset:{id,key,filename:file.name,durationSec:measured,url:`/api/media?key=${encodeURIComponent(key)}`}}, {status:201});
}
