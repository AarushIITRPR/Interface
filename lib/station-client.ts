export async function stationRequest(body:Record<string,unknown>){
  const r=await fetch("/api/station",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"});
  const data=await r.json();
  if(!r.ok)throw Error(data.error||"Could not connect to Meridian.");
  return data as {code?:string|null;secret?:string;expires?:number;invite?:string;paired?:boolean;displayOnline?:boolean};
}
