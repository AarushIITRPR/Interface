"""Prepare the authors' public CMOSE feature release, without raw video.

Adaptation: CC BY-SA 4.0; Wu et al., CVPR Workshops 2024, pp. 4636-4645.
Source https://huggingface.co/datasets/cwuau/CMOSE
This is a CLIP-level pilot, not temporal/streaming validation or original split replication.
"""
import argparse,csv,hashlib,json,re
from collections import Counter
from pathlib import Path
import numpy as np

LABELS=['Highly Disengage','Disengage','Engage','Highly Engage']
HASHES={'final_data_1.json':'65ef301538bb2d5f8419d45ea6ccbbf971eab4ac0b501b38b7aae216e3c60ef0',
        'new_bert_ac_dict.json':'a1e72f6c4da9d725bcd1e0bfa600451474d5bebea2a408490aeb2bed3d87274d'}
# Locked before any training/test evaluation. Session-disjoint custom protocol.
SPLITS={'video10':'test','video15':'val','video16':'calibration'}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',required=True); p.add_argument('--output',required=True); a=p.parse_args()
    root=Path(a.input); output=Path(a.output); output.mkdir(parents=True,exist_ok=False)
    loaded=[]
    for name,digest in HASHES.items():
        raw=(root/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=digest: raise ValueError(f'Source hash mismatch: {name}')
        loaded.append(json.loads(raw)); del raw
    visual,extra=loaded; records=[]; rejected=[]
    for key,item in sorted(visual.items()):
        match=re.fullmatch(r'(video\d+)_(\d+)_(person\d+)',key)
        if not match or key not in extra: raise ValueError('Unexpected source identity schema')
        session,clip,person=match.groups()
        xs=[np.asarray(item['embeds'],dtype='float32'),np.asarray(extra[key]['bert'],dtype='float32'),
            np.asarray(extra[key]['acoustics'],dtype='float32')]
        if xs[0].shape==(0,):
            rejected.append(dict(key=key,reason='missing released I3D embedding')); continue
        if [x.shape for x in xs]!=[(1024,),(768,),(6,)]: raise ValueError('Feature schema changed')
        if not all(np.isfinite(x).all() for x in xs):
            rejected.append(dict(key=key,reason='nonfinite features')); continue
        records.append(dict(key=key,session=session,participant=f'{session}-{person}',
            split=SPLITS.get(session,'train'),label=LABELS.index(item['label']),xs=xs,
            available=np.array([1,float(np.any(xs[1]!=0)),1],dtype='float32')))
    train=[r for r in records if r['split']=='train']
    means=[]; scales=[]
    for m in range(3):
        matrix=np.stack([r['xs'][m] for r in train if r['available'][m]])
        means.append(matrix.mean(0,dtype='float64').astype('float32'))
        scales.append(np.maximum(matrix.std(0,dtype='float64'),1e-6).astype('float32'))
    np.savez(output/'normalization.npz',**{f'mean{i}':v for i,v in enumerate(means)},
             **{f'scale{i}':v for i,v in enumerate(scales)})
    for mode,indices in [('visual',[0]),('multimodal',[0,1,2])]:
        folder=output/mode; folder.mkdir(); rows=[]
        for r in records:
            features={f'x{j}':np.clip((r['xs'][m]-means[m])/scales[m],-10,10)[None]
                      for j,m in enumerate(indices)}
            available=r['available'][indices]
            for j in range(len(indices)):
                if not available[j]: features[f'x{j}'][:]=0
            filename=r['key']+'.npz'
            np.savez_compressed(folder/filename,**features,quality=np.ones(len(indices)),
                age=np.zeros(len(indices)),available=available,drift=np.zeros(len(indices)))
            rows.append(dict(path=filename,participant=r['participant'],session=r['session'],
                split=r['split'],label=r['label'],source='CMOSE public features; custom session split',
                license='CC-BY-SA-4.0; Wu et al. CVPRW 2024'))
        with (folder/'manifest.csv').open('w',newline='',encoding='utf8') as f:
            w=csv.DictWriter(f,fieldnames=rows[0]); w.writeheader(); w.writerows(rows)
    report=dict(source='https://huggingface.co/datasets/cwuau/CMOSE',sha256=HASHES,
        labels=LABELS,rows=len(records),rejected=rejected,
        split_sessions={s:sorted({r['session'] for r in records if r['split']==s})
                        for s in ['train','val','calibration','test']},
        split_counts={s:dict(Counter(r['label'] for r in records if r['split']==s))
                      for s in ['train','val','calibration','test']},
        declared_subjects=len({r['participant'] for r in records}),
        identity_limit='IDs are session-scoped; cross-session biological identity cannot be verified from released metadata',
        transformation='Train-only per-channel standardization; clip z to [-10,10]; one token per whole clip',
        quality_limit='quality=1 is a placeholder, not measured sensor quality; no drift/age ablation possible',
        zero_text_masked=sum(not r['available'][1] for r in records),
        original_random_split_used=False)
    (output/'audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2))


if __name__=='__main__': main()
