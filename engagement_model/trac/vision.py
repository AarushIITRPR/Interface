"""Shared preprocessing for the development face-only baseline.

Haar detector + ImageNet ResNet18, NOT RT-DETR/ByteTrack production tracking.
Missing or ambiguous faces produce no features. No full-frame substitution.
"""
import cv2
import numpy as np
import torch
from torch import nn
from torchvision.models import resnet18, ResNet18_Weights


class FaceEncoder:
    def __init__(self):
        weights=ResNet18_Weights.IMAGENET1K_V1
        self.net=resnet18(weights=weights)
        self.net.fc=nn.Identity(); self.net.eval().requires_grad_(False)
        self.transform=weights.transforms()
        self.detector=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
    def boxes(self,frame):
        return self.detector.detectMultiScale(cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY),1.1,5,minSize=(48,48))
    @torch.no_grad()
    def encode(self,frame,box):
        x,y,w,h=map(int,box)
        crop=frame[y:y+h,x:x+w]
        if not crop.size:
            raise ValueError('Empty crop')
        rgb=cv2.cvtColor(crop,cv2.COLOR_BGR2RGB)
        tensor=torch.from_numpy(np.ascontiguousarray(rgb)).permute(2,0,1)
        return self.net(self.transform(tensor)[None])[0].numpy()
