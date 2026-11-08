"""Build shared/sparse curves from the exact source; validate total error, never stack tolerances."""
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
import json
import math
import re
import runpy

HERE=Path(__file__).resolve().parent
V=runpy.run_path(str(HERE/'chat-curves.py'))
js=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':'))
number=lambda value:format(value,'.15g')

def same(a,b):
    return len(a)==len(b) and all(math.isclose(x,y,rel_tol=1e-12,abs_tol=1e-12) for x,y in zip(a,b))

def reconstruct(template,row):
    result=[v*row[3]/template[-1] for v in template]
    result[0],result[-1]=row[2][0],row[3]
    return result

def acceptable(t,row,predicted,limits):
    if same(row[2],predicted):return True
    if not V['may_approximate'](t,row) or not V['increasing'](predicted):return False
    if not same([row[2][0],row[2][-1]],[predicted[0],predicted[-1]]):return False
    if any(abs(a-b)>limits['relativeCv']*a+1e-12 for a,b in zip(row[2],predicted)):return False
    return all(abs(V['inverse'](q,row[2],t['travelPercent'])-V['inverse'](q,predicted,t['travelPercent']))<=limits['openingPercentagePoints']+1e-10 for q in set(row[2]+predicted))

def sparse_options(cv,travel):
    options=[]
    for length in range(len(cv)-1):
        for middle in combinations(range(1,len(cv)-1),length):
            indices=(0,*middle,len(cv)-1)
            code='P'+''.join(map(str,indices))+':'+','.join(number(cv[i]) for i in indices)
            options.append(code)
    return sorted(options,key=lambda code:(len(code),code))

def build(source):
    source=Path(source);text=(source/'references/chat-curve-library.md').read_text()
    exact=json.loads((source/'data/chat-curves-exact.json').read_text());limits=exact['limits']
    groups=defaultdict(list)
    for t in exact['tables']:
        for row in t['curves']:
            if V['may_approximate'](t,row):groups[tuple(t['travelPercent'])].append((t,row))
    predictions={}
    for travel,items in groups.items():
        frequencies=Counter(V['shape'](r[2]) for _,r in items)
        templates=[]
        for t,row in sorted(items,key=lambda item:(-frequencies[V['shape'](item[1][2])],item[0]['id'],item[1][0])):
            choices=[]
            for template in templates:
                predicted=reconstruct(template,row)
                if acceptable(t,row,predicted,limits):
                    error=max(abs(a-b)/a for a,b in zip(row[2],predicted))
                    choices.append((error,template))
            if choices:template=min(choices,key=lambda item:item[0])[1]
            else:template=row[2];templates.append(template)
            predictions[t['id'],row[0]]=template
    members=defaultdict(list);shapes={}
    for t in exact['tables']:
        for row in t['curves']:
            template=predictions.get((t['id'],row[0]),row[2]);key=(tuple(t['travelPercent']),V['shape'](template))
            shapes.setdefault(key,template);members[key].append((t,row))
    library={};specs={}
    for key,items in members.items():
        travel=list(key[0]);template=shapes[key]
        if len(items)>1:
            sid='S'+str(len(library)+1);encoded=template;expanded=template
            for code in sparse_options(template,travel):
                if len(js(code))>=len(js(template)):break
                candidate=V['expand_points'](code,travel)
                if all(acceptable(t,row,reconstruct(candidate,row),limits) for t,row in items):
                    encoded,expanded=code,candidate;break
            library[sid]=encoded
            for t,row in items:
                pred=reconstruct(expanded,row);approx=not same(row[2],pred)
                spec=sid
                if approx or not same([expanded[0]*row[3]/expanded[-1]],[row[2][0]]):spec+=':'+number(row[2][0])
                if approx:spec+=':A'
                specs[t['id'],row[0]]=spec
        else:
            t,row=items[0];original=','.join(map(number,row[2]));best=original
            for code in sparse_options(row[2],travel):
                if len(code)>=len(best):break
                candidate=V['expand_points'](code,travel)
                if acceptable(t,row,candidate,limits):
                    encoded=code+('' if same(row[2],candidate) else ':A')
                    if len(encoded)<len(best):best=encoded
            specs[t['id'],row[0]]=best
    text=re.sub(r'(## 共享曲线模板\n\n```json\n).*?(\n```)',lambda m:m[1]+js(library)+m[2],text,count=1,flags=re.S)
    def replace(m):
        meta=json.loads(m[1]);lines=[]
        for line in m[3].splitlines():
            rid,config,rated,_=line.split('\t');lines.append('\t'.join([rid,config,rated,specs[meta['id'],int(rid[1:])]]))
        return '```json\n'+m[1]+'\n```\n'+m[2]+'\n```tsv\n'+'\n'.join(lines)+'\n```'
    text=re.sub(r'```json\n([^\n]+)\n```\n(曲线记录[^\n]*)\n```tsv\n(.*?)\n```',replace,text,flags=re.S)
    report=V['verify'](text,source,dense=True)
    kinds=report['curveKinds'];description=f"共有1,275条配置记录：{kinds.get('approximate',0)}条有界近似、{kinds.get('exactShared',0)}条等价共享、{kinds.get('sparseExact',0)}条等价抽点、{kinds.get('inline',0)}条完整原点。共享模板{len(library)}个，其中{report['sparseTemplates']}个只存转折点；另有{report['sparseRecords']}条独立记录只存转折点。"
    text=re.sub(r'共有1,275条配置记录：[^\n]+',description+' 配置、尺寸、系数和脚注分别保留；共享数字曲线不表示配置可互换。',text,count=1)
    return text,report

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--report',required=True);args=parser.parse_args()
    text,report=build(HERE.parent)
    with Path(args.output).open('x') as f:f.write(text)
    with Path(args.report).open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
    print(js({k:v for k,v in report.items() if k!='rows'}))
