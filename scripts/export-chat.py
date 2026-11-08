#!/usr/bin/env python3
"""Export one concise workflow, canonical methods/cases, and the verified curve library."""
import argparse
import hashlib
import json
import posixpath
from pathlib import Path
import re
import runpy

RULE_SOURCES = ('SKILL.md','references/chat-attachment.md','references/optimization-map.md',
                'references/cost-reduction.md','references/offline-prescreen.md','references/calculation.md',
                'references/actuator-force-followup.md','references/getting-started.md','references/excel-format.md')
SECTIONS = (
    ('references/chat-workflow.md','workflow','离线优化执行清单'),
    ('references/optimization-map.md','methods','11种通用方法'),
    ('references/cost-reduction.md','cases','38条具体配置案例'),
    ('references/chat-curve-library.md','curve-library','曲线、执行机构参数与资料边界'),
)

def check_rule_sources(source):
    manifest=json.loads((source/'data/chat-rule-sources.json').read_text())
    if set(manifest['sources']) != set(RULE_SOURCES):raise ValueError('incomplete compact-rule provenance')
    for name,expected in manifest['sources'].items():
        if hashlib.sha256((source/name).read_bytes()).hexdigest()!=expected:
            raise ValueError('review compact workflow after source change: '+name)
    return manifest

def build(source):
    source=Path(source)
    check_rule_sources(source)
    version=re.search(r'^  version: "([0-9]+\.[0-9]+\.[0-9]+)"$',(source/'SKILL.md').read_text(),re.M)[1]
    texts={name:(source/name).read_text() for name,_,_ in SECTIONS}
    anchors={name:anchor for name,anchor,_ in SECTIONS}
    for name in RULE_SOURCES:anchors.setdefault(name,'workflow')
    parts=[f'# 阀门优化：Copilot单文件指南\n\n版本：{version}。上传本文件和项目原表即可。含精简执行规则、11种方法、38条案例、三系列1,275条曲线配置及常用执行机构参数；部分曲线新增误差≤5% Cv、≤1个百分点开度，只作离线估算。\n\n']
    parts += [f'- [{title}](#{anchor})\n' for _,anchor,title in SECTIONS]
    for name,anchor,title in SECTIONS:
        body=texts[name]
        if name.endswith('chat-curve-library.md'):
            body=runpy.run_path(str(source/'scripts/compact-chat-data.py'))['compact'](body)
        if name.endswith('optimization-map.md'):
            body='每台依次检查这11种方法，再匹配下一节38条案例；记录适用或不适用理由，单个候选可有多条依据。方法不是已批准的替换方案。\n\n'+'\n'.join(line for line in body.splitlines() if line.startswith('|'))
            body=body.split('| 位置 |')[0]
        if anchor=='methods' and len(re.findall(r'^\| [1-3]\.\d+ \|',body,re.M))!=11:
            raise ValueError('missing method rows')
        if anchor=='cases' and list(map(int,re.findall(r'^\| ([1-9]|[12]\d|3[0-8]) \|',body,re.M)))!=list(range(1,39)):
            raise ValueError('missing case rows')
        body=re.sub(r'\A# [^\n]+\n','',body).strip()
        def link(m):
            label,target=m.groups()
            if re.match(r'https?://|#',target):return m[0]
            resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target.split('#')[0]))
            return f'[{label}](#{anchors[resolved]})' if resolved in anchors else label+'（完整包参考）'
        body=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',link,body)
        parts.append(f'\n\n<a id="{anchor}"></a>\n\n## {title}\n\n{body}\n')
    fingerprint=hashlib.sha256(''.join(texts.values()).encode()).hexdigest()
    parts.append(f'\n来源指纹：`{fingerprint}`。完整规则和全精度数据另存；本文件不含厂家PDF、客户历史或可执行程序。\n')
    text=''.join(parts)
    if any(t[1:] not in anchors.values() for t in re.findall(r'\]\((#[^)]+)\)',text)):raise ValueError('unresolved internal link')
    runpy.run_path(str(source/'scripts/chat-curves.py'))['verify'](text,source)
    return text

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    content=build(Path(__file__).resolve().parents[1])
    with Path(args.output).open('x') as f:f.write(content)
    print(f'{len(content.encode())} bytes; 11 methods; 38 cases; 1275 curves; 47 tables')
