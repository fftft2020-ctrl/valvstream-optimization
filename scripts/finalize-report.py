#!/usr/bin/env python3
"""Add native internal links/filter to Artifact Tool output, then check every authored cell."""
import json
import math
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as E

N='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
E.register_namespace('',N)
q=lambda name:'{'+N+'}'+name

def finalize(temporary, audit_path, output):
    audit=json.loads(Path(audit_path).read_text())
    with ZipFile(temporary) as z:
        parts={name:z.read(name) for name in z.namelist()}
    wb=E.fromstring(parts['xl/workbook.xml'])
    assert [s.get('name') for s in wb.find(q('sheets'))]==['优化汇总','计算过程','优化策略']
    assert all(s.get('state','visible')=='visible' for s in wb.find(q('sheets')))
    expected={(c['sheet'],c['cell']):c['value'] for c in audit['cells']}
    for i,info in enumerate(audit['sheets'],1):
        tree=E.fromstring(parts[f'xl/worksheets/sheet{i}.xml'])
        for tag in ['hyperlinks','autoFilter','printOptions','pageMargins','pageSetup']:
            old=tree.find(q(tag))
            if old is not None:tree.remove(old)
        if i==1:
            tree.insert(list(tree).index(tree.find(q('sheetData')))+1,E.Element(q('autoFilter'),{'ref':f'A1:K{info["lastRow"]}'}))
        links=E.Element(q('hyperlinks'))
        for link in audit['links']:
            if link['sheet']!=info['name']:continue
            assert (link['targetSheet'],link['targetCell']) in expected
            E.SubElement(links,q('hyperlink'),{'ref':link['cell'],'location':f"'{link['targetSheet']}'!{link['targetCell']}",'display':str(expected[(info['name'],link['cell'])])})
        if len(links):tree.append(links)
        E.SubElement(tree,q('printOptions'),{'horizontalCentered':'1'})
        E.SubElement(tree,q('pageMargins'),{'left':'0.2','right':'0.2','top':'0.3','bottom':'0.3','header':'0.1','footer':'0.1'})
        E.SubElement(tree,q('pageSetup'),{'paperSize':'8','orientation':'landscape','fitToWidth':'1','fitToHeight':'0'})
        parts[f'xl/worksheets/sheet{i}.xml']=E.tostring(tree,encoding='utf-8',xml_declaration=True)
    names=wb.find(q('definedNames'))
    if names is None:
        names=E.Element(q('definedNames'));calc=wb.find(q('calcPr'));wb.insert(list(wb).index(calc) if calc is not None else len(wb),names)
    for old in list(names):
        if old.get('name') in ['_xlnm.Print_Area','_xlnm.Print_Titles']:names.remove(old)
    for i,info in enumerate(audit['sheets']):
        E.SubElement(names,q('definedName'),{'name':'_xlnm.Print_Area','localSheetId':str(i)}).text=f"'{info['name']}'!$A$1:${info['lastCol']}${info['lastRow']}"
        E.SubElement(names,q('definedName'),{'name':'_xlnm.Print_Titles','localSheetId':str(i)}).text=f"'{info['name']}'!$1:$1"
    parts['xl/workbook.xml']=E.tostring(wb,encoding='utf-8',xml_declaration=True)
    strings=[''.join(t.text or '' for t in s.iter(q('t'))) for s in E.fromstring(parts['xl/sharedStrings.xml'])] if 'xl/sharedStrings.xml' in parts else []
    style=E.fromstring(parts['xl/styles.xml'])
    styles=style.find(q('cellXfs'))
    actual={};count=0
    for i,info in enumerate(audit['sheets'],1):
        tree=E.fromstring(parts[f'xl/worksheets/sheet{i}.xml'])
        for row in tree.find(q('sheetData')):
            assert row.get('hidden')!='1'
            for cell in row:
                assert cell.find(q('f')) is None,'快照报告不新增公式或外部引用'
                value=cell.find(q('v'));kind=cell.get('t')
                if kind=='s':v=strings[int(value.text)]
                elif kind=='inlineStr':v=''.join(t.text or '' for t in cell.iter(q('t')))
                elif value is None:continue
                elif kind=='e':raise AssertionError('导出包含Excel错误')
                elif kind=='str':v=value.text or ''
                else:v=float(value.text)
                actual[(info['name'],cell.get('r'))]=v
                alignment=styles[int(cell.get('s','0'))].find(q('alignment'))
                assert alignment is not None and alignment.get('horizontal')=='center' and alignment.get('vertical')=='center' and alignment.get('wrapText')=='1'
        for link in tree.findall(q('hyperlinks')+'/'+q('hyperlink')):
            count+=1
            expected_link=next(l for l in audit['links'] if l['sheet']==info['name'] and l['cell']==link.get('ref'))
            assert link.get('location')==f"'{expected_link['targetSheet']}'!{expected_link['targetCell']}"
        if i==1:assert tree.find(q('autoFilter')).get('ref')==f'A1:K{info["lastRow"]}'
    for key,wanted in expected.items():
        got=actual.get(key)
        if wanted is None:assert got in [None,'']
        elif isinstance(wanted,(int,float)):assert isinstance(got,(int,float)) and math.isclose(got,wanted,rel_tol=1e-12,abs_tol=1e-12),(key,wanted,got)
        else:assert wanted==got,(key,wanted,got)
    assert set(actual).issubset(expected),'出现计划外数据'
    assert count==len(audit['links'])
    # Exclusive creation preserves existing/frozen reports; raw authoring output is kept on failure.
    with Path(output).open('xb') as stream:
        with ZipFile(stream,'w',ZIP_DEFLATED) as z:
            for name,data in parts.items():z.writestr(name,data)
    with ZipFile(output) as z:
        assert z.testzip() is None
        assert all(z.read(name)==data for name,data in parts.items())
    return {'cellsMatched':len(expected),'nativeInternalLinksMatched':count,'sheets':3}

if __name__=='__main__':
    if len(sys.argv)!=4:raise SystemExit('Usage: finalize-report.py temporary.xlsx audit.json output.xlsx')
    print(json.dumps(finalize(*sys.argv[1:]),ensure_ascii=False))
