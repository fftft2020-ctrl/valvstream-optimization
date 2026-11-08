"""Remove repeated table fields without dropping manufacturer values or source notes."""
from collections import Counter
from copy import deepcopy
import json
import re

js=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':'))
PATTERN=r'```json\n([^\n]+)\n```\n(曲线记录[^\n]*)\n```tsv\n(.*?)\n```'

def pack_repeat(value):
    if isinstance(value,list):
        if len(value)>3 and all(isinstance(v,(int,float)) for v in value) and all(v==value[0] for v in value):return {'repeat':[value[0],len(value)]}
        return [pack_repeat(v) for v in value]
    if isinstance(value,dict):return {k:pack_repeat(v) for k,v in value.items()}
    return value

def expand_repeat(value):
    if isinstance(value,dict):
        if set(value)=={'repeat'}:
            v,n=value['repeat'];assert isinstance(v,(int,float)) and isinstance(n,int) and 1<=n<=100
            return [v]*n
        return {k:expand_repeat(v) for k,v in value.items()}
    if isinstance(value,list):return [expand_repeat(v) for v in value]
    return value

def compact(text):
    if '## 公共说明C库' in text:return text
    notes=[]
    def ref(value):
        if value not in notes:notes.append(value)
        return notes.index(value)+1
    def replace(match):
        p=json.loads(match[1]);rows=[line.split('\t') for line in match[3].splitlines()]
        ids=[int(row[0][1:]) for row in rows];configs=p.pop('configRefs')
        assert len(configs)==len(set(configs))
        assert list(dict.fromkeys(int(row[1]) for row in rows))==list(range(1,len(configs)+1))
        p['rowStart']=ids[0]
        steps=[b-a for a,b in zip(ids,ids[1:])];step=Counter(steps).most_common(1)[0][0] if steps else 1
        if step!=1:p['rowStep']=step
        overrides={str(i+1):rid for i,rid in enumerate(ids) if rid!=ids[0]+i*step}
        if overrides:p['rowOverrides']=overrides
        p['contextRefs']=[ref(part) for part in re.split(r'(?<=\n)|(?=\b\d+\.\s)|(?=(?:Cv and FL Versus Travel|CV and FL Versus Travel|Flow Characteristic|Direction:))',p.pop('context')) if part]
        if p.get('review'):p['review']=[ref(v) for v in p['review']]
        for extra in p.get('curveExtras',{}).values():extra[1]=[ref(v) for v in extra[1]]
        p=pack_repeat(p)
        for key in ['configOverrides','curveExtras','review']:
            if not p.get(key):p.pop(key,None)
        lines=[];previous=None
        for _,ci,rated,spec in rows:
            g=configs[int(ci)-1];lines.append('\t'.join(['=' if g==previous else str(g),rated,spec]));previous=g
        return '```json\n'+js(p)+'\n```\n曲线记录（G编号、额定Cv、曲线）：\n```tsv\n'+'\n'.join(lines)+'\n```'
    text=re.sub(PATTERN,replace,text,flags=re.S)
    heading='## 公共原表行H库';before,after=text.split(heading,1);m=re.search(r'```json\n(.*?)\n```',after,re.S);pool=json.loads(m[1]);packed=[]
    for row in pool:
        packed.append([len(row)]+[item for i,v in enumerate(row) if v is not None for item in (i,v)])
    after=after[:m.start(1)]+js({'sparseRows':packed})+after[m.end(1):];text=before+heading+after
    text=text.replace('## 公共尺寸原字段G库','## 公共说明C库\n\n```json\n'+js(notes)+'\n```\n\n## 公共尺寸原字段G库',1)
    def geometry(match):
        previous=[];lines=[]
        for line in match[1].splitlines():
            fields=line.split('\t');values=fields[1:];assert '=' not in values
            encoded=['=' if i<len(previous) and v==previous[i] and len(v)>1 else v for i,v in enumerate(values)]
            lines.append('\t'.join([fields[0],*encoded]));previous=values
        return '## 公共尺寸原字段G库\n\n```tsv\n'+'\n'.join(lines)+'\n```'
    text=re.sub(r'## 公共尺寸原字段G库\n\n```tsv\n(.*?)\n```',geometry,text,count=1,flags=re.S)
    start=text.index('## 精简数据读法');end=text.index('## 公共说明C库',start)
    guide='''## 精简数据读法

先按系列、型号/内件、口径/等级、流向、行程和额定Cv匹配。表id中的p、t分别是PDF页序号和表序号。以下各库都在本文件内；G/H/C编号从1开始，P坐标与覆盖字段下标从0开始。∅、null和缺项都不是0。

**每表曲线记录只有3列：G编号、额定Cv、曲线。** G直接指向尺寸库，等号=沿用上一条记录的G编号；本表配置编号按G首次出现的顺序从1计数，用于configOverrides。原行号由rowStart起按rowStep递增（省略为1）；rowOverrides按本表第几条记录覆盖原行号。curveExtras及绿色额定Cv行号都使用恢复后的原行号，不是G编号。

**尺寸G库：** 各行是G编号和原表尺寸字段，公英制原值保留；等号=沿用G库上一行同一列的值，按顺序展开，不是未知值。原字段7列及以上通常为口径in、DN、等级、喉径in/mm、行程in/mm及其他字段；4列为口径in、DN、喉径in/mm；6列为口径in、DN、喉径in/mm、行程in/mm。4/6列等级取ratingDefault，4列行程未给。特殊表以headerRefs原表头为准，9列等附加字段不能丢。DN不是实际内径。

配置默认继承本表direction、characteristic、trimFamily。configOverrides按本表配置编号覆盖字段：0口径、1等级、2喉径、3行程、4流向、5特性、6内件、7完整尺寸字段、8特殊适用范围。see-table-context必须读同表说明，不猜流向。

**说明C库、表头H库：** contextRefs按顺序取C库片段直接拼接（保留片段内的换行和空格）；review及curveExtras中的疑点列表也用C编号。C中的型号、限制和脚注不可漏读。H的sparseRows每项为[原列数,列号,文字,列号,文字,…]，列号从0起，未列位置为null；headerRefs仍为[原行号,H编号]，据此核对单位、特殊表头和范围。版权、原换行和原空值保留供追溯，不当成工程参数。

**系数与脚注：** factorRows保存本表系数；repeat:[数值,次数]仅表示相同数值重复，例如{"repeat":[0.9,10]}就是10个0.9，不能用于随开度变化的系数。curveExtras按原行号存[本行系数,疑点C编号列表,点位脚注]；缺项默认[null,[],{}]。configOverrides缺省{}、review缺省[]。greenRatedCvSourceRows只按对应页21614/21615的绿色额定Cv脚注解释。

**曲线：** 数字列表为各坐标Cv；S编号取共享模板，每点=模板点×本行额定Cv÷模板末值，S后的冒号数值覆盖首点，末点始终为本行额定Cv；末尾A为近似标记。未标A必须数值等价。开度坐标默认10、20、…、100%；有travelPercent时完全依该表，不把110%末列当100%。

P格式只保存转折点。例如P039:1,4,10表示本表第0、3、9个坐标点的Cv=1、4、10；默认坐标下是10%、40%、100%，编号3不是30%。其余点按本表坐标分段直线插值，首末点保留，不外推。P可直接作为曲线，也可放在S模板内；模板先展开再缩放/覆盖首末点。直接P的:A表示近似；S模板是否近似以各引用行A为准。

首次计算展示一条G/C/H及曲线展开示例，核对型号、单位、额定Cv、首点与工况。35002额定容量/FL/缩孔系数补充页仍在后文；未给数据不得编造。

'''
    return text[:start]+guide+text[end:]
