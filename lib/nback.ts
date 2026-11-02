export const NBACK_PACE = { timingVersion:"spatial-2500-v1", visibleMs:1000, gapMs:1500, intervalMs:2500 } as const;
export const places=["top left","top middle","top right","middle left","centre","middle right","bottom left","bottom middle","bottom right"];

export const DEMO_SLIDES=40;
// A repeatable teaching sequence, independent of the random scored stimuli.
export function demonstrationSequence(level:number){
  if(![1,2,3].includes(level))throw new Error("Expected 1-, 2- or 3-back.");
  const sequence:number[]=[];
  const targets=new Set([3,7,11,16,19,23,27,32,36,39]);
  for(let i=0;i<DEMO_SLIDES;i++){
    const earlier=sequence[i-level];
    let cell=(i*5+Math.floor(i/3)*2)%9;
    if(targets.has(i))cell=earlier;
    else{
      // Slide eight reproduces the top-right match shown in the mockup.
      if(i===7-level)cell=2;
      if(cell===earlier)cell=(cell+1)%9;
    }
    sequence.push(cell);
  }
  return sequence;
}
export function decision(seq:readonly number[],i:number,n:number){
  return i<n?"remember":seq[i]===seq[i-n]?"match":"wait";
}
