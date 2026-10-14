"""LOCAL RESEARCH BASELINE ONLY: single frontal face, not production tracking.

Requires an engagement-trained 512-D face checkpoint and explicit research opt-in.
Synthetic checkpoints are always rejected. No server is opened or deployed.
"""
import argparse
from collections import deque
import json
from pathlib import Path
import time
import cv2
import numpy as np
import torch
from .evaluate import load
from .model import OrdinalHead


def check_checkpoint(ck):
    if ck.get('data_kind')!='real':
        raise ValueError('Synthetic/unidentified checkpoint cannot score human video')
    if tuple(ck['config']['input_dims'])!=(512,):
        raise ValueError('This baseline supports only 512-D ResNet18 face features')


def iou(a,b):
    x=max(a[0],b[0]); y=max(a[1],b[1])
    w=max(0,min(a[0]+a[2],b[0]+b[2])-x)
    h=max(0,min(a[1]+a[3],b[1]+b[3])-y)
    overlap=w*h
    return overlap/max(1,a[2]*a[3]+b[2]*b[3]-overlap)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',required=True); p.add_argument('--source',required=True,
        help='Video path, or camera:0 for explicit live camera access')
    p.add_argument('--output',required=True); p.add_argument('--research-only',action='store_true')
    a=p.parse_args()
    if not a.research_only: p.error('Unvalidated research baseline: --research-only is required')
    torch.set_num_threads(4); model,ck=load(a.checkpoint); check_checkpoint(ck)
    # Import only after rejecting invalid checkpoints: no accidental weight download.
    from .vision import FaceEncoder
    encoder=FaceEncoder()
    root=Path(a.output); root.mkdir(parents=True,exist_ok=False)
    live=a.source.startswith('camera:')
    cap=cv2.VideoCapture(int(a.source.split(':')[1]) if live else a.source)
    if not cap.isOpened(): raise RuntimeError('Cannot open requested video source')
    fps=float(cap.get(cv2.CAP_PROP_FPS))
    if not np.isfinite(fps) or fps<=0: fps=25.
    history=deque(maxlen=50); previous=None; generation=0; score=None
    sampled=-1.; scored=-1.; started=time.monotonic(); writer=None
    # A deliberately conservative IoU continuity check is NOT identity recognition.
    try:
        with (root/'predictions.jsonl').open('w',encoding='utf8') as log, torch.no_grad():
            while True:
                ok,frame=cap.read()
                if not ok: break
                now=time.monotonic()-started if live else cap.get(cv2.CAP_PROP_POS_MSEC)/1000
                if now<0 or not np.isfinite(now): raise ValueError('Invalid video timestamps')
                if now-sampled>=.199:
                    if sampled>=0 and now-sampled>.5:
                        history.clear(); previous=None; score=None; generation+=1
                    sampled=now; boxes=encoder.boxes(frame)
                    if len(boxes)!=1:
                        history.clear(); previous=None; score=None; generation+=1
                        status='no face' if len(boxes)==0 else 'ambiguous: multiple faces'
                    else:
                        box=tuple(map(int,boxes[0]))
                        if previous is not None and iou(previous,box)<.3:
                            history.clear(); score=None; generation+=1
                        previous=box; history.append(encoder.encode(frame,box))
                        status='warming up'
                        if len(history)==50 and now-scored>=1.:
                            xs=torch.from_numpy(np.stack(history))[None]
                            z=model([xs],torch.ones(1,1),torch.zeros(1,1),torch.ones(1,1))
                            pr=OrdinalHead.probabilities(z['logits']/ck.get('temperature',1.))[0]
                            score=float((pr*torch.arange(len(pr))).sum()*100/(len(pr)-1))
                            scored=now
                        if score is not None: status='unvalidated research estimate'
                    record=dict(time=now,track_generation=generation,box_xywh=previous,
                        score=score,score_time=scored if score is not None else None,
                        status=status,production_validated=False)
                    log.write(json.dumps(record)+'\n'); log.flush()
                if previous is not None:
                    x,y,w,h=previous; cv2.rectangle(frame,(x,y),(x+w,y+h),(255,255,255),2)
                label='RESEARCH ONLY | '+('--' if score is None else f'{score:.1f}/100')
                cv2.putText(frame,label,(16,30),cv2.FONT_HERSHEY_SIMPLEX,.65,(255,255,255),2)
                if writer is None:
                    writer=cv2.VideoWriter(str(root/'annotated.avi'),cv2.VideoWriter_fourcc(*'MJPG'),
                        fps,(frame.shape[1],frame.shape[0]))
                    if not writer.isOpened(): raise RuntimeError('Video writer failed')
                writer.write(frame)
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        if writer: writer.release()
    (root/'limitations.json').write_text(json.dumps(dict(
        tracker='single-face Haar + IoU, not ByteTrack',validated=False,
        video_timing='constant-FPS visualization; JSONL retains source timestamps',
        calibration='checkpoint temperature; held-out deployment validation still required'),indent=2))


if __name__=='__main__': main()
