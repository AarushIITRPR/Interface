"""Train on labelled feature windows; select on validation, not test.

python -m trac.train --manifest data/manifest.csv --output runs/face --dims 512
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import time
import numpy as np
import torch
from torch.utils.data import DataLoader
from .data import read_manifest, Windows
from .model import Config, TracModel, ordinal_loss


def metrics(probabilities, labels):
    p, y = np.asarray(probabilities), np.asarray(labels, dtype=int)
    pred, k = p.argmax(1), p.shape[1]
    cm = np.zeros((k,k), dtype=int)
    np.add.at(cm, (y,pred), 1)
    den = cm.sum(0)+cm.sum(1)
    f1 = np.divide(2*cm.diagonal(), den, out=np.zeros(k), where=den>0)
    recall = np.divide(cm.diagonal(), cm.sum(1), out=np.zeros(k), where=cm.sum(1)>0)
    expected = p @ np.arange(k)
    target = np.eye(k)[y]
    return dict(n=len(y), accuracy=float((pred==y).mean()), macro_f1=float(f1.mean()),
                balanced_accuracy=float(recall.mean()), ordinal_mae=float(abs(expected-y).mean()),
                nll=float(-np.log(p[np.arange(len(y)),y].clip(1e-8)).mean()),
                brier=float(((p-target)**2).sum(1).mean()), confusion=cm.tolist(),
                missing_classes=np.where(cm.sum(1)==0)[0].tolist())


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval(); ps, ys = [], []
    unusable = 0
    for xs,q,a,v,d,y,_ in loader:
        result = model([x.to(device) for x in xs], q.to(device), a.to(device), v.to(device), d.to(device))
        usable = result['usable'].cpu()
        unusable += int((~usable).sum())
        ps.extend(result['probabilities'].cpu()[usable].tolist()); ys.extend(y[usable].tolist())
    if not ys:
        raise ValueError('No valid evidence in evaluation split')
    out = metrics(ps,ys); out['unusable'] = unusable
    out['coverage'] = len(ys)/(len(ys)+unusable)
    return out


def fit(args, prepared=None):
    torch.set_num_threads(args.threads)
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    c = Config(input_dims=tuple(args.dims), classes=args.classes, width=args.width,
               fusion=args.fusion, drift_penalty=args.drift_penalty)
    rows = prepared[0] if prepared is not None else read_manifest(args.manifest,c.classes)
    training = [r for r in rows if r['split']=='train']
    validation = [r for r in rows if r['split']=='val']
    if not training or not validation:
        raise ValueError('Separate participant-disjoint train and val splits are required')
    if len({r['label'] for r in training}) != c.classes:
        raise ValueError('Every class must occur in training')
    datasets=prepared[1] if prepared is not None else [Windows(r,c) for r in (training,validation)]
    if prepared is None and getattr(args,'cache',False):
        datasets=[list(d) for d in datasets]
    loaders = [DataLoader(d, batch_size=args.batch, shuffle=(i==0), num_workers=0)
               for i,d in enumerate(datasets)]
    device = torch.device(args.device)
    model = TracModel(c).to(device)
    opt = torch.optim.AdamW(model.parameters(),lr=args.lr,weight_decay=1e-4)
    out = Path(args.output); out.mkdir(parents=True,exist_ok=True)
    if (out/'best.pt').exists():
        raise ValueError('Output contains a checkpoint; choose a new run directory')
    best, wait, history = float('inf'), 0, []
    start = time.perf_counter()
    for epoch in range(args.epochs):
        model.train(); losses = []
        for xs,q,a,v,d,y,_ in loaders[0]:
            xs = [x.to(device) for x in xs]
            q,a,v,d,y = [x.to(device) for x in (q,a,v,d,y)]
            if args.agent_dropout:
                v = v.clone()
                # Keep base visual path; dropout only optional evidence.
                v[:,1:] *= (torch.rand_like(v[:,1:]) >= args.agent_dropout)
            result = model(xs,q,a,v,d)
            good = result['usable']
            if not good.any():
                continue
            loss = ordinal_loss(result['logits'][good], y[good])
            if not torch.isfinite(loss):
                raise RuntimeError('Non-finite loss')
            opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
            opt.step(); losses.append(loss.item())
        if not losses:
            raise ValueError('No usable training examples')
        val = evaluate(model,loaders[1],device)
        entry = dict(epoch=epoch+1,train_loss=float(np.mean(losses)),validation=val)
        history.append(entry); print(json.dumps(entry),flush=True)
        if val['ordinal_mae'] < best:
            best,wait = val['ordinal_mae'],0
            torch.save(dict(state=model.cpu().state_dict(),config=c.to_dict(),
                            data_kind=args.data_kind,validated=False,temperature=1.,
                            manifest_sha256=hashlib.sha256(Path(args.manifest).read_bytes()).hexdigest(),
                            seed=args.seed,epoch=epoch+1,validation=val),out/'best.pt')
            model.to(device)
        else:
            wait += 1
        if wait >= args.patience:
            break
    report = dict(history=history,seconds=time.perf_counter()-start,torch=torch.__version__,
                  device=str(device),configuration=vars(args),test_evaluated=False,
                  parameters=sum(p.numel() for p in model.parameters()))
    (out/'training.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    return report


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',required=True); p.add_argument('--output',required=True)
    p.add_argument('--dims',nargs='+',type=int,default=[512,768,35]); p.add_argument('--classes',type=int,default=4)
    p.add_argument('--width',type=int,default=128); p.add_argument('--fusion',choices=['latent','mean'],default='latent')
    p.add_argument('--drift-penalty',type=float,default=1.)
    p.add_argument('--agent-dropout',type=float,default=.2); p.add_argument('--lr',type=float,default=3e-4)
    p.add_argument('--epochs',type=int,default=30); p.add_argument('--batch',type=int,default=16)
    p.add_argument('--patience',type=int,default=6); p.add_argument('--seed',type=int,default=17)
    p.add_argument('--threads',type=int,default=4); p.add_argument('--device',default='cpu')
    p.add_argument('--data-kind',choices=['real','synthetic'],default='real')
    p.add_argument('--cache',action='store_true',help='Preload compact feature windows in RAM')
    return p


if __name__=='__main__':
    args=parser().parse_args()
    if args.classes < 2 or args.epochs < 1 or not 0 <= args.agent_dropout < 1:
        raise ValueError('Invalid classes, epochs, or dropout')
    fit(args)
