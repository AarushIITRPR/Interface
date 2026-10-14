"""Held-out evaluation and optional temperature fit on calibration split only.

Does not mark a checkpoint production-validated. Only load trusted checkpoints.
"""
import argparse
import hashlib
import json
from pathlib import Path
import torch
from torch.utils.data import DataLoader
from .model import Config, TracModel, OrdinalHead
from .data import read_manifest, Windows
from .train import metrics


def load(path):
    ck=torch.load(path,map_location='cpu',weights_only=True)
    model=TracModel(Config(**ck['config'])); model.load_state_dict(ck['state']); model.eval()
    return model,ck


@torch.no_grad()
def collect(model,rows,dataset=None):
    logits=[]; labels=[]; people=[]; missing=0
    for xs,q,a,v,d,y,ids in DataLoader(Windows(rows,model.config) if dataset is None else dataset,batch_size=16):
        z=model(xs,q,a,v,d); good=z['usable']
        missing+=int((~good).sum())
        logits.append(z['logits'][good]); labels.append(y[good])
        people.extend([s for s,g in zip(ids,good.tolist()) if g])
    if not logits or not sum(len(x) for x in logits): raise ValueError('No usable examples')
    return torch.cat(logits),torch.cat(labels),people,missing


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',required=True); p.add_argument('--manifest',required=True)
    p.add_argument('--output',required=True); p.add_argument('--split',choices=['val','test'],default='test')
    p.add_argument('--calibrate',action='store_true'); a=p.parse_args()
    torch.set_num_threads(4)
    output=Path(a.output)
    if output.exists(): raise ValueError('Evaluation output already exists')
    model,ck=load(a.checkpoint); rows=read_manifest(a.manifest,model.config.classes)
    manifest_hash=hashlib.sha256(Path(a.manifest).read_bytes()).hexdigest()
    if manifest_hash!=ck['manifest_sha256']: raise ValueError('Manifest changed since training')
    temp=float(ck.get('temperature',1.))
    if a.calibrate:
        z,y,_,_=collect(model,[r for r in rows if r['split']=='calibration'])
        # Fixed positive grid preserves ordered thresholds; no test optimization.
        options=torch.logspace(-1,1,81)
        scores=[]
        for t in options:
            pr=OrdinalHead.probabilities(z/t)
            scores.append(-pr[torch.arange(len(y)),y].clamp_min(1e-8).log().mean().item())
        temp=float(options[scores.index(min(scores))])
    z,y,ids,missing=collect(model,[r for r in rows if r['split']==a.split])
    probabilities=OrdinalHead.probabilities(z/temp).numpy()
    report=metrics(probabilities,y.numpy())
    report.update(temperature=temp,split=a.split,data_kind=ck['data_kind'],
        coverage=len(y)/(len(y)+missing),unusable=missing,production_validated=False,
        checkpoint_sha256=hashlib.sha256(Path(a.checkpoint).read_bytes()).hexdigest(),
        manifest_sha256=manifest_hash,
        predictions=[dict(participant=i,label=int(t),probabilities=pr.tolist())
                     for i,t,pr in zip(ids,y,probabilities)])
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k!='predictions'}))


if __name__=='__main__': main()
