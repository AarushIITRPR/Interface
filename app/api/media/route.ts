import { ensureSchema, getBindings } from "@/lib/session-engine";
import { getOperatorUser } from "@/app/operator-auth";

export const dynamic = "force-dynamic";

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
  const rows = await getBindings().DB.prepare(`SELECT id, object_key, filename, content_type, size, created_at FROM media_assets ORDER BY created_at DESC LIMIT 100`).all();
  return Response.json({assets:rows.results});
}

export async function POST(request: Request) {
  if (!await getOperatorUser()) return Response.json({error:"Instructor authorization is required."},{status:401});
  await ensureSchema();
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({error:"Choose a media file."},{status:400});
  if (file.size > 250 * 1024 * 1024) return Response.json({error:"File exceeds the 250 MB upload limit."},{status:413});
  const id = crypto.randomUUID();
  const key = `media/${id}/${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
  await getBindings().MEDIA.put(key,file.stream(),{httpMetadata:{contentType:file.type || "application/octet-stream"}});
  const createdAt = new Date().toISOString();
  await getBindings().DB.prepare(`INSERT INTO media_assets (id, object_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id,key,file.name,file.type || "application/octet-stream",file.size,createdAt).run();
  return Response.json({asset:{id,key,filename:file.name,url:`/api/media?key=${encodeURIComponent(key)}`}}, {status:201});
}
