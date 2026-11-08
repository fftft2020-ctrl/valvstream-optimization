"""Read the actual chat attachment and verify all manufacturer fields and Cv bounds."""
from bisect import bisect_right
from collections import Counter, defaultdict
from copy import deepcopy
from fractions import Fraction
from pathlib import Path
import json
import math
import re
import runpy

def expand_points(spec, travel):
    if isinstance(spec,list):
        assert len(spec)==len(travel) and all(isinstance(v,(int,float)) and math.isfinite(v) for v in spec)
        return list(spec)
    match=re.fullmatch(r'P([0-9]+):([^:]+)',spec)
    assert match, 'invalid sparse curve'
    indices=list(map(int,match[1]));values=[float(v) for v in match[2].split(',')]
    assert len(indices)==len(values) and len(indices)>=2 and indices[0]==0 and indices[-1]==len(travel)-1
    assert increasing(indices) and increasing(travel) and all(math.isfinite(v) for v in values)
    result=[]
    for k,x in enumerate(travel):
        if k in indices:
            result.append(values[indices.index(k)]);continue
        i=max(0,min(len(indices)-2,bisect_right(indices,k)-1));a,b=indices[i:i+2]
        result.append(values[i]+(values[i+1]-values[i])*(x-travel[a])/(travel[b]-travel[a]))
    return result


def may_approximate(t,row):
    return not(t['review'] or row[5] or row[6]) and row[2][0]>0 and increasing(row[2]) and increasing(t['travelPercent']) and t['travelPercent'][-1]==100


def unpack(p,pool):
    omit=('direction','ratingDefault','configRaw','configOverrides','headerRefs','curveRows','curveExtras')
    t={k:deepcopy(v) for k,v in p.items() if k not in omit}
    m=re.fullmatch(r'\d+-p(\d+)-t(\d+)',p['id']);assert m
    t['pdfPage'],t['tableIndex']=map(int,m.groups())
    t.setdefault('travelPercent',list(range(10,101,10)))
    t['configs']=[]
    for i,raw in enumerate(p['configRaw'],1):
        if len(raw)>=7:c=[raw[0],raw[2],raw[3],raw[5]]
        elif len(raw)==4:c=[raw[0],p['ratingDefault'],raw[2],None]
        elif len(raw)==6:c=[raw[0],p['ratingDefault'],raw[2],raw[4]]
        else:raise ValueError('Unsupported raw metadata shape')
        c += [p['direction'],p['characteristic'],p['trimFamily'],raw,None]
        for k,v in p['configOverrides'].get(str(i),{}).items():c[int(k)]=v
        t['configs'].append(c)
    t['rawHeadersAndOtherRows']=[[r,pool[n-1]] for r,n in p['headerRefs']]
    t['curves']=[row+p['curveExtras'].get(str(row[0]),[None,[],{}]) for row in p['curveRows']]
    return t


def json_section(text, heading):
    tail=text.split(heading,1)[1]
    return json.loads(re.search(r'```json\n(.*?)\n```',tail,re.S)[1])

def parse(text):
    library=json_section(text,'## 共享曲线模板')
    pool=json_section(text,'## 公共原表行H库')
    if isinstance(pool,dict):
        assert set(pool)=={'sparseRows'}
        restored=[]
        for row in pool['sparseRows']:
            length=row[0];assert isinstance(length,int) and 0<length<100 and len(row)%2==1
            values=[None]*length;used=set()
            for i,value in zip(row[1::2],row[2::2],strict=True):
                assert isinstance(i,int) and 0<=i<length and i not in used
                values[i]=value;used.add(i)
            restored.append(values)
        pool=restored
    notes=json_section(text,'## 公共说明C库') if '## 公共说明C库' in text else None
    def note(n):
        assert isinstance(n,int) and notes is not None and 1<=n<=len(notes)
        return notes[n-1]
    raw=re.search(r'## 公共尺寸原字段G库\n\n```tsv\n(.*?)\n```',text,re.S)[1]
    def uncell(s):
        if s=='∅':return None
        return re.sub(r'\\([\\nt])',lambda m:{'\\':'\\','n':'\n','t':'\t'}[m[1]],s)
    geometry=[]
    for i,line in enumerate(raw.splitlines(),1):
        parts=line.split('\t');assert parts[0]=='G'+str(i)
        values=[]
        for j,x in enumerate(parts[1:]):
            if x=='=':
                assert geometry and j<len(geometry[-1]), 'invalid geometry ditto'
                values.append(geometry[-1][j])
            else:values.append(uncell(x))
        geometry.append(values)
    tables={}
    for meta,rawrows in re.findall(r'```json\n([^\n]+)\n```\n曲线记录[^\n]*\n```tsv\n(.*?)\n```',text,re.S):
        p=json.loads(meta)
        if 'rowStart' in p:
            p=runpy.run_path(str(Path(__file__).with_name('compact-chat-data.py')))['expand_repeat'](p)
            start=p.pop('rowStart');step=p.pop('rowStep',1);overrides=p.pop('rowOverrides',{})
            assert isinstance(start,int) and start>0 and isinstance(step,int) and step>0
            p['context']=''.join(note(n) for n in p.pop('contextRefs'))
            p['review']=[note(n) for n in p.get('review',[])]
            p.setdefault('configOverrides',{});p.setdefault('curveExtras',{})
            for extra in p['curveExtras'].values():extra[1]=[note(n) for n in extra[1]]
            refs=[];expanded=[];previous=None
            lines=rawrows.splitlines()
            assert all(k.isdigit() and 1<=int(k)<=len(lines) for k in overrides)
            for i,line in enumerate(lines):
                g,rated,spec=line.split('\t')
                g=previous if g=='=' else int(g)
                assert isinstance(g,int) and 1<=g<=len(geometry)
                if g not in refs:refs.append(g)
                rid=overrides.get(str(i+1),start+i*step)
                expanded.append('\t'.join(['R'+str(rid),str(refs.index(g)+1),rated,spec]));previous=g
            p['configRefs']=refs;rawrows='\n'.join(expanded)
        assert p['id'] not in tables
        assert all(isinstance(n,int) and 1<=n<=len(geometry) for n in p['configRefs'])
        assert all(isinstance(n,int) and 1<=n<=len(pool) for _,n in p['headerRefs'])
        p['configRaw']=[geometry[n-1] for n in p.pop('configRefs')]
        p['curveRows']=[]
        for line in rawrows.splitlines():
            rid,ci,rated,spec=line.split('\t');rated=json.loads(rated);ci=int(ci)
            assert 1<=ci<=len(p['configRaw']) and rid.startswith('R')
            if spec.startswith('S'):
                a=spec.split(':');assert 1<=len(a)<=3 and a[0] in library
                cv=[a[0],float(a[1]) if len(a)>1 else expand_points(library[a[0]],p.get('travelPercent',list(range(10,101,10))))[0]*rated/expand_points(library[a[0]],p.get('travelPercent',list(range(10,101,10))))[-1]]
                if len(a)==3:assert a[2]=='A';cv.append('A')
            elif spec.startswith('P'):cv=[spec]
            else:cv=[json.loads(x) for x in spec.split(',')]
            p['curveRows'].append([int(rid[1:]),ci,cv,rated])
        tables[p['id']]=unpack(p,pool)
    supplement=json_section(text,'### 额定容量、FL与缩孔系数对应（PDF第8页）')
    return tables,library,[supplement]

def increasing(values):
    return all(b>a for a,b in zip(values,values[1:]))

def shape(values):
    return tuple(Fraction(str(v))/Fraction(str(values[-1])) for v in values)

def inverse(q, cv, travel):
    assert cv[0]-1e-10<=q<=cv[-1]+1e-10
    i=max(0,min(len(cv)-2,bisect_right(cv,q)-1))
    return travel[i]+(q-cv[i])/(cv[i+1]-cv[i])*(travel[i+1]-travel[i])

def verify(text, source, dense=False):
    exact=json.loads((Path(source)/'data/chat-curves-exact.json').read_text())
    tables,library,supplements=parse(text)
    originals={t['id']:t for t in exact['tables']}
    assert set(tables)==set(originals) and supplements==exact['supplements']
    count=Counter();coverage=Counter();maxcv=maxtravel=0.;rows=[];sparse_records=0;domains=defaultdict(set)
    for tid,t in tables.items():
        old=originals[tid]
        assert {k:v for k,v in t.items() if k!='curves'}=={k:v for k,v in old.items() if k!='curves'},tid
        for a,b in zip(old['curves'],t['curves'],strict=True):
            assert a[:2]==b[:2] and a[3:]==b[3:],(tid,a[0],'configuration/factors/notes changed')
            coverage[tid.split('-')[0]]+=1
            if isinstance(b[2][0],str) and b[2][0].startswith('S'):
                domains[b[2][0]].add(tuple(old['travelPercent']))
                template=expand_points(library[b[2][0]],old['travelPercent'])
                predicted=[v*b[3]/template[-1] for v in template]
                predicted[0],predicted[-1]=b[2][1],b[3]
                approx=len(b[2])==3
                count['approximate' if approx else 'exactShared']+=1
            elif isinstance(b[2][0],str):
                spec=b[2][0];approx=spec.endswith(':A')
                predicted=expand_points(spec[:-2] if approx else spec,old['travelPercent'])
                sparse_records+=1;count['approximate' if approx else 'sparseExact']+=1
            else:predicted=b[2];approx=False;count['inline']+=1
            assert len(predicted)==len(a[2]) and all(math.isfinite(v) for v in predicted)
            assert math.isclose(predicted[0],a[2][0],rel_tol=1e-12,abs_tol=1e-12) and predicted[-1]==a[2][-1]
            ec=et=0.
            if not approx:
                assert all(math.isclose(x,y,rel_tol=1e-12,abs_tol=1e-12) for x,y in zip(a[2],predicted)),(tid,a[0],'unmarked approximation')
            else:
                assert may_approximate(old,a) and increasing(predicted)
                ec=max(abs(x-y)/x for x,y in zip(a[2],predicted))
                # Difference of piecewise linear inverses is extremal at this union.
                et=max(abs(inverse(q,a[2],old['travelPercent'])-inverse(q,predicted,old['travelPercent'])) for q in sorted(set(a[2]+predicted)))
                assert ec<=exact['limits']['relativeCv']+1e-12 and et<=exact['limits']['openingPercentagePoints']+1e-10,(tid,a[0],ec,et)
                if dense:
                    for i in range(1001):
                        q=a[2][0]+(a[2][-1]-a[2][0])*i/1000
                        assert abs(inverse(q,a[2],old['travelPercent'])-inverse(q,predicted,old['travelPercent']))<=exact['limits']['openingPercentagePoints']+1e-10
            maxcv,maxtravel=max(maxcv,ec),max(maxtravel,et)
            rows.append({'id':tid+'-r'+str(a[0]),'approximate':approx,'relativeCvError':ec,'openingErrorPercentagePoints':et})
    assert set(domains)==set(library) and all(len(d)==1 for d in domains.values()), 'template coordinate mismatch or unused template'
    assert dict(coverage)==exact['coverage']
    for meta in exact['sources']:assert meta['filename'] in text and meta['sha256'] in text
    assert sum(count.values())==1275 and len(tables)==47
    return {'tables':len(tables),'configurations':sum(count.values()),'coverage':dict(coverage),'curveKinds':dict(count),'templates':len(library),'sparseTemplates':sum(isinstance(v,str) for v in library.values()),'sparseRecords':sparse_records,'maxCvRelativeError':maxcv,'maxOpeningErrorPercentagePoints':maxtravel,'densePositionsPerApproximateCurve':1001 if dense else 0,'allNonCurveFieldsPreserved':True,'rows':rows}

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('markdown');parser.add_argument('--dense',action='store_true');parser.add_argument('--report')
    args=parser.parse_args();report=verify(Path(args.markdown).read_text(),Path(__file__).resolve().parents[1],args.dense)
    if args.report:Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},ensure_ascii=False))
