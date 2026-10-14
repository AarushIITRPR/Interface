"""Small reproducible validation-only sweep; never selects on test results."""
import argparse
import itertools
import json
from pathlib import Path
from .train import parser,fit


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',required=True); p.add_argument('--output',required=True)
    p.add_argument('--dims',nargs='+',type=int,default=[512]); p.add_argument('--classes',type=int,default=4)
    p.add_argument('--epochs',type=int,default=30); a=p.parse_args()
    root=Path(a.output); root.mkdir(parents=True,exist_ok=False); summary=[]
    for fusion,lr,seed in itertools.product(['mean','latent'],[1e-4,3e-4],[17,31,53]):
        name=f'{fusion}-{lr}-{seed}'
        args=parser().parse_args(['--manifest',a.manifest,'--output',str(root/name),
            '--dims',*map(str,a.dims),'--classes',str(a.classes),'--epochs',str(a.epochs),
            '--fusion',fusion,'--lr',str(lr),'--seed',str(seed)])
        report=fit(args)
        summary.append(dict(run=name,fusion=fusion,lr=lr,seed=seed,
            validation_mae=min(x['validation']['ordinal_mae'] for x in report['history'])))
        (root/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
    # Compare configuration MEANS across all seeds, not cherry-picked best seed.
    groups=[]
    for fusion,lr in itertools.product(['mean','latent'],[1e-4,3e-4]):
        values=[s['validation_mae'] for s in summary if s['fusion']==fusion and s['lr']==lr]
        groups.append(dict(fusion=fusion,lr=lr,mean_validation_mae=sum(values)/len(values)))
    (root/'selection.json').write_text(json.dumps(sorted(groups,key=lambda x:x['mean_validation_mae']),indent=2))


if __name__=='__main__': main()
