import assert from "node:assert/strict";
import test from "node:test";
import {demonstrationSequence,decision,NBACK_PACE} from "../lib/nback.ts";

for(const n of [1,2,3])test(n+"-back has 40 slides with accurate warm-up, matching and nonmatching comparisons",()=>{
  const seq=demonstrationSequence(n);
  assert.equal(seq.length,40);assert.ok(seq.every(v=>Number.isInteger(v)&&v>=0&&v<9));
  assert.equal(seq[7],2);assert.equal(seq[7-n],2);
  for(let i=0;i<40;i++)assert.equal(decision(seq,i,n),i<n?"remember":seq[i]===seq[i-n]?"match":"wait");
  assert.ok(seq.some((_,i)=>decision(seq,i,n)==="wait"));
});
test("versioned cadence includes the blank in the response window",()=>{
  assert.equal(NBACK_PACE.visibleMs,1000);assert.equal(NBACK_PACE.gapMs,1500);
  assert.equal(NBACK_PACE.visibleMs+NBACK_PACE.gapMs,NBACK_PACE.intervalMs);
  assert.equal(20*NBACK_PACE.intervalMs,50000);
});
