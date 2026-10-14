"""Extract a frozen ResNet18 sequence from labelled single-person videos.

Input CSV: video,participant,session,split,label,source,license.
Label is zero-based and applies to the complete clip, not every sampled frame.
No dataset download, relabelling, participant splitting or face-ID guessing.
"""
import argparse,csv,json
from pathlib import Path
import cv2
import numpy as np
import torch
from .vision import FaceEncoder


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',required=True); p.add_argument('--output',required=True)
    a=p.parse_args(); torch.set_num_threads(4)
    root=Path(a.input).resolve().parent; out=Path(a.output); out.mkdir(parents=True,exist_ok=True)
    if (out/'manifest.csv').exists():
        raise ValueError('Choose a fresh output directory')
    rows=list(csv.DictReader(open(a.input,newline='',encoding='utf-8-sig')))
    encoder=FaceEncoder(); results=[]; rejected=[]
    for i,row in enumerate(rows):
        cap=cv2.VideoCapture(str(root/row['video']))
        fps=cap.get(cv2.CAP_PROP_FPS); count=cap.get(cv2.CAP_PROP_FRAME_COUNT)
        features=[]
        # This adapter intentionally accepts only the protocol's full 10s clips.
        if not cap.isOpened() or fps<=0 or not 9.5<=count/fps<=10.5:
            rejected.append(dict(video=row['video'],reason='Expected a 10-second labelled clip'))
            cap.release(); continue
        for n in range(50):
            cap.set(cv2.CAP_PROP_POS_MSEC,n*200)
            ok,frame=cap.read()
            if not ok: break
            boxes=encoder.boxes(frame)
            if len(boxes)!=1: break
            features.append(encoder.encode(frame,boxes[0]))
        cap.release()
        if len(features)!=50:
            rejected.append(dict(video=row['video'],reason='Missing/ambiguous face or decode failure'))
            continue
        filename=f'window_{i:07d}.npz'
        np.savez_compressed(out/filename,x0=np.stack(features),quality=np.ones(1),age=np.zeros(1),
                            available=np.ones(1),drift=np.zeros(1))
        results.append(dict(path=filename,**{k:row[k] for k in ('participant','session','split','label','source','license')}))
    with (out/'manifest.csv').open('w',newline='',encoding='utf-8') as f:
        writer=csv.DictWriter(f,fieldnames=['path','participant','session','split','label','source','license'])
        writer.writeheader(); writer.writerows(results)
    (out/'extraction.json').write_text(json.dumps(dict(accepted=len(results),rejected=rejected,
        extractor='torchvision ResNet18 IMAGENET1K_V1',crop='OpenCV frontal Haar, unique face',
        hz=5,seconds=10),indent=2),encoding='utf-8')
    print(f'{len(results)} accepted; {len(rejected)} rejected. Audit rejection bias before using results.')


if __name__=='__main__': main()
