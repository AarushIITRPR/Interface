import csv
import numpy as np
import pytest
import torch
from trac.model import Config,TracModel,TemporalExpert,ordinal_loss
from trac.contracts import Evidence,allocate
from trac.data import read_manifest

torch.set_num_threads(2)


def fixture():
    torch.manual_seed(7)
    model=TracModel(Config(input_dims=(8,6),width=16,dropout=0)).eval()
    x=[torch.randn(3,10,8),torch.randn(3,4,6)]
    return model,x,torch.ones(3,2),torch.zeros(3,2),torch.ones(3,2)


def test_ordered_probabilities():
    m,x,q,a,v=fixture(); out=m(x,q,a,v)
    assert (out['probabilities']>=0).all()
    assert torch.allclose(out['probabilities'].sum(1),torch.ones(3))
    assert ((out['score']>=0)&(out['score']<=100)).all()


def test_all_missing_no_nan_and_not_usable():
    m,x,q,a,v=fixture(); out=m(x,q,a,v*0)
    assert torch.isfinite(out['logits']).all()
    assert not out['usable'].any()


def test_masked_branch_invariant():
    m,x,q,a,v=fixture(); v[:,1]=0
    p=m(x,q,a,v)['probabilities']; x[1]=x[1]*1000
    assert torch.allclose(p,m(x,q,a,v)['probabilities'],atol=1e-6)


def test_temporal_causality():
    e=TemporalExpert(8,16,0).eval(); x=torch.randn(2,20,8)
    before=e.sequence(x); x[:,10:]=999
    assert torch.allclose(before[:,:10],e.sequence(x)[:,:10],atol=1e-5)


def test_invalid_timestamp_and_expiry():
    e=Evidence('a',2,0,1,1.1,.9)
    assert e.valid('a',2,2,3)
    assert not e.valid('a',3,2,3)
    assert not e.valid('b',2,2,3)
    assert not e.valid('a',2,1,3)
    assert not e.valid('a',2,5,3)


def test_drift_reduces_reliability():
    m,x,q,a,v=fixture()
    assert (m(x,q,a,v,torch.ones_like(a))['reliability'] < m(x,q,a,v)['reliability']).all()


def test_expired_branch_invalid():
    m,x,q,a,v=fixture(); a[:]=20
    assert not m(x,q,a,v)['usable'].any()


def test_nan_branch_is_masked():
    m,x,q,a,v=fixture(); x[0][:]=torch.nan
    out=m(x,q,a,v)
    assert torch.isfinite(out['logits']).all()
    assert (out['reliability'][:,0]==0).all()


def test_backward_and_update():
    m,x,q,a,v=fixture(); opt=torch.optim.Adam(m.parameters(),lr=.01)
    before=m.head.location.weight.detach().clone()
    loss=ordinal_loss(m(x,q,a,v)['logits'],torch.tensor([0,1,3]))
    loss.backward(); opt.step()
    assert not torch.equal(before,m.head.location.weight)


def test_budget_and_deduplication():
    c=[dict(track='a',expert='motion',cost=4.,gain=2.)]*2
    c.append(dict(track='b',expert='motion',cost=3.,gain=1.))
    out=allocate(c,5.)
    assert len(out)==1 and sum(x['cost'] for x in out)<=5.
    with pytest.raises(ValueError): allocate(c,-1)


def test_participant_leakage_rejected(tmp_path):
    np.savez(tmp_path/'a.npz',a=[1]);np.savez(tmp_path/'b.npz',a=[2])
    fields=['path','participant','session','split','label','source','license']
    with (tmp_path/'m.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(fields)
        w.writerow(['a.npz','p1','s1','train',0,'test','test'])
        w.writerow(['b.npz','p1','s2','val',1,'test','test'])
    with pytest.raises(ValueError,match='leakage'):read_manifest(tmp_path/'m.csv',4)
def test_inference_rejects_synthetic_checkpoint():
    from trac.infer import check_checkpoint
    import pytest
    with pytest.raises(ValueError, match='Synthetic'):
        check_checkpoint({'data_kind':'synthetic','config':{'input_dims':[512]}})
