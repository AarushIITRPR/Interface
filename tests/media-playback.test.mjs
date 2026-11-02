import assert from "node:assert/strict";
import test from "node:test";
import {rolldown} from "rolldown";

test("uploaded clips serve full and partial media for seekable playback", async()=>{
  const content="0123456789";
  const info={size:content.length,httpEtag:'"clip"',writeHttpMetadata:h=>h.set("content-type","video/mp4")};
  globalThis.testMediaStore={
    head:async()=>info,
    get:async(_key,options)=>({...info,body:options?.range
      ? content.slice(options.range.offset,options.range.offset+options.range.length) : content}),
  };
  const bundle=await rolldown({input:"app/api/media/route.ts",plugins:[{name:"fixture",
    resolveId:id=>id.startsWith("@/")?"virtual:"+id:null,
    load:id=>id.endsWith("session-engine")?"export const ensureSchema=async()=>{}; export const getBindings=()=>({MEDIA:globalThis.testMediaStore});"
      :id.endsWith("operator-auth")?"export const getOperatorUser=async()=>null;":null}]});
  try{
    const {output}=await bundle.generate({format:"es"});
    const {GET}=await import("data:text/javascript;base64,"+Buffer.from(output[0].code).toString("base64"));
    for(const [range,status,body,contentRange] of [
      [null,200,content,null],["bytes=2-5",206,"2345","bytes 2-5/10"],["bytes=6-",206,"6789","bytes 6-9/10"],
      ["bytes=-2",206,"89","bytes 8-9/10"],["bytes=10-",416,"","bytes */10"],
    ]){
      const response=await GET(new Request("http://localhost/api/media?key=clip",{headers:range?{range}:{}}));
      assert.equal(response.status,status);assert.equal(response.headers.get("content-range"),contentRange);
      assert.equal(response.headers.get("accept-ranges"),"bytes");assert.equal(await response.text(),body);
    }
  }finally{await bundle.close();delete globalThis.testMediaStore;}
});
