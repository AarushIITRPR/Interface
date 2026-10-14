"""Bounded real-data clip-feature pilot. Not full TRAC streaming validation.

Two validation-only learning rates, three configurations, then three seeds at
each configuration's selected learning rate. Test is touched only after selection.
"""
import argparse,contextlib,hashlib,json,time
from pathlib import Path
import numpy as np
import torch
from .train import parser,fit,metrics
from .evaluate import load,collect
from .data import read_manifest,Windows
from .model import OrdinalHead,Config


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',required=True);p.add_argument('--output',required=True)
    p.add_argument('--epochs',type=int,default=10)
    p.add_argument('--resume',action='store_true');a=p.parse_args()
    root=Path(a.output);root.mkdir(parents=True,exist_ok=a.resume);started=time.time()
    if (root/'results.json').exists():raise ValueError('Test already evaluated; preserve this run')
    configs=[('visual_mean','visual',[1024],'mean'),
             ('multi_mean','multimodal',[1024,768,6],'mean'),
             ('multi_latent','multimodal',[1024,768,6],'latent')]
    selected={};runs=[];prepared={};evaluation_data={}
    def run(name,mode,dims,fusion,lr,seed):
        out=root/f'{name}-lr{lr}-seed{seed}'
        if a.resume and (out/'training.json').exists():
            report=json.loads((out/'training.json').read_text())
            cfg=report['configuration']
            if cfg['epochs']!=a.epochs or cfg['lr']!=lr or cfg['seed']!=seed:
                raise ValueError('Resume configuration mismatch')
            entry=dict(name=name,mode=mode,lr=lr,seed=seed,path=str(out),
                val_mae=min(e['validation']['ordinal_mae'] for e in report['history']),seconds=report['seconds'])
            runs.append(entry);print('Preserved completed run: '+out.name,flush=True);return entry
        if out.exists():
            # Preserve interrupted checkpoints; do not resume a partial optimizer.
            out=root/(out.name+'-retry')
            if out.exists():raise ValueError('Retry directory exists; inspect it before continuing')
        if mode not in prepared:
            rows=read_manifest(Path(a.data)/mode/'manifest.csv',4)
            config=Config(input_dims=tuple(dims),width=32)
            prepared[mode]=(rows,[list(Windows([r for r in rows if r['split']==s],config)) for s in ['train','val']])
        args=parser().parse_args(['--manifest',str(Path(a.data)/mode/'manifest.csv'),
            '--output',str(out),'--dims',*map(str,dims),'--width','32','--classes','4',
            '--fusion',fusion,'--lr',str(lr),'--seed',str(seed),'--epochs',str(a.epochs),
            '--patience','4','--batch','128','--cache','--agent-dropout','0.2'])
        print(f'Training {name}, lr={lr}, seed={seed}',flush=True)
        with (root/(out.name+'.log')).open('w',encoding='utf8') as log,contextlib.redirect_stdout(log):
            report=fit(args,prepared=prepared[mode])
        entry=dict(name=name,mode=mode,lr=lr,seed=seed,path=str(out),
            val_mae=min(e['validation']['ordinal_mae'] for e in report['history']),
            seconds=report['seconds'])
        runs.append(entry)
        (root/'progress.json').write_text(json.dumps(runs,indent=2))
        print(json.dumps(entry),flush=True);return entry
    # No locked test access in this phase.
    for name,mode,dims,fusion in configs:
        candidates=[run(name,mode,dims,fusion,lr,17) for lr in [0.0003,0.001]]
        best=min(candidates,key=lambda r:r['val_mae']);selected[name]=best['lr']
    (root/'locked_selection.json').write_text(json.dumps(selected,indent=2))
    for name,mode,dims,fusion in configs:
        for seed in [31,53]:run(name,mode,dims,fusion,selected[name],seed)
    # Calibration and test are now evaluated for the preselected ablations.
    results=[]
    for entry in runs:
        if entry['lr']!=selected[entry['name']]:continue
        model,ck=load(Path(entry['path'])/'best.pt')
        manifest=Path(a.data)/entry['mode']/'manifest.csv'
        if hashlib.sha256(manifest.read_bytes()).hexdigest()!=ck['manifest_sha256']:
            raise ValueError('Manifest changed since training')
        if entry['mode'] not in evaluation_data:
            rows=prepared[entry['mode']][0]
            evaluation_data[entry['mode']]={s:list(Windows([r for r in rows if r['split']==s],model.config)) for s in ['calibration','test']}
        cached=evaluation_data[entry['mode']]
        z,y,_,_=collect(model,[],dataset=cached['calibration'])
        temps=torch.logspace(-1,1,81); losses=[]
        for t in temps:
            prob=OrdinalHead.probabilities(z/t)
            losses.append(-prob[torch.arange(len(y)),y].clamp_min(1e-8).log().mean().item())
        temperature=float(temps[int(np.argmin(losses))])
        z,y,ids,missing=collect(model,[],dataset=cached['test'])
        probabilities=OrdinalHead.probabilities(z/temperature).numpy()
        uncal=metrics(OrdinalHead.probabilities(z).numpy(),y.numpy())
        result=dict(**entry,temperature=temperature,test=metrics(probabilities,y.numpy()),
            uncalibrated_test=uncal,usable_coverage=len(y)/(len(y)+missing),
            full_pipeline_validated=False,streaming_validated=False)
        # Preserve model provenance and calibration in a separate artifact.
        ck.update(temperature=temperature,preprocessing='CMOSE train-only standardization, z clip [-10,10]',
            data_source='CMOSE I3D/BERT/acoustic clip features',validated=False)
        torch.save(ck,Path(entry['path'])/'research-calibrated.pt')
        record=dict(summary=result,participants=ids,labels=y.tolist(),probabilities=probabilities.tolist())
        (Path(entry['path'])/'test.json').write_text(json.dumps(record,indent=2))
        results.append(result)
        (root/'results.json').write_text(json.dumps(dict(results=results,
            selected_lrs=selected,elapsed_seconds=time.time()-started,
            scope='CMOSE custom session-held-out clip feature pilot, not original leaderboard or full TRAC'),indent=2))
        print('Test complete: '+entry['name']+' seed '+str(entry['seed']),flush=True)
    aggregate=[]
    for name,_,_,_ in configs:
        group=[r for r in results if r['name']==name]
        row={'configuration':name,'seeds':len(group)}
        for key in ['accuracy','macro_f1','balanced_accuracy','ordinal_mae','nll','brier']:
            values=[r['test'][key] for r in group]
            row[key]={'mean':float(np.mean(values)),'seed_sd':float(np.std(values,ddof=1))}
        aggregate.append(row)
    (root/'aggregate.json').write_text(json.dumps(aggregate,indent=2))
    print(json.dumps(aggregate,indent=2))


if __name__=='__main__':main()
