"""Synthetic optimizer/serialization test. NOT a human-engagement experiment."""
import csv
import json
from pathlib import Path
import argparse
import numpy as np
from .train import parser, fit


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--output',required=True)
    args=cli.parse_args(); root=Path(args.output).resolve()
    root.mkdir(parents=True,exist_ok=False)
    rng=np.random.default_rng(113); rows=[]
    for split,count in [('train',64),('val',24),('calibration',16),('test',24)]:
        for i in range(count):
            y=i%4; filename=f'{split}_{i}.npz'
            x=rng.normal(0,.15,(20,8)).astype('float32')
            x[:,y]+=2.0
            np.savez_compressed(root/filename,x0=x,quality=np.ones(1),age=np.zeros(1),
                                available=np.ones(1),drift=np.zeros(1))
            rows.append(dict(path=filename,participant=f'{split}-person-{i//4}',
                session=f'{split}-session-{i//4}',split=split,label=y,
                source='SYNTHETIC SOFTWARE TEST; NOT HUMAN DATA',license='generated fixture'))
    manifest=root/'manifest.csv'
    with manifest.open('w',newline='',encoding='utf8') as f:
        w=csv.DictWriter(f,fieldnames=rows[0].keys()); w.writeheader(); w.writerows(rows)
    a=parser().parse_args(['--manifest',str(manifest),'--output',str(root/'run'),
        '--dims','8','--width','32','--epochs','12','--lr','0.003','--batch','16',
        '--data-kind','synthetic','--agent-dropout','0'])
    report=fit(a)
    if not report['history'][-1]['train_loss'] < report['history'][0]['train_loss']:
        raise RuntimeError('Synthetic optimization failed to reduce training loss')
    print(json.dumps({'status':'software training smoke passed','human_accuracy':None}))


if __name__=='__main__': main()
