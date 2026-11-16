import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getReviewRecord} from './review-result.mjs';
import {displayNumber as format} from './presentation.mjs';
import {LBF_TO_N,actuatorCombinationInsufficient} from './actuator-screen.mjs';

const text = x => typeof x === 'string' && !!x.trim();
const finite = x => typeof x === 'number' && Number.isFinite(x);
const display = (v,kind) => finite(v) ? format(v,kind) : text(v) ? v : '待核';
const model = c => `${c.type}系列，${c.size}号`;
export const caseName = n => ({Max:'最大',MAX:'最大',Norm:'正常',NORM:'正常',Min:'最小',MIN:'最小'}[n] || n);

export async function reportStrategies() {
  const result=[];
  for (const [file,cases] of [['optimization-map.md',false],['cost-reduction.md',true]]) {
    const lines=(await readFile(new URL('../references/'+file,import.meta.url),'utf8')).split('\n');
    for(const line of lines) {
      if(!(cases ? /^\| (?:[1-9]|[12]\d|3[0-8]) \|/ : /^\| [1-3]\.\d+ \|/).test(line)) continue;
      const fields=line.split('|').slice(1,-1).map(s=>s.trim().replace(/\bCv\b/g,'CV').replace(/`([^`]+)`/g,'$1'));
      result.push({id:cases?'案例'+fields[0].padStart(2,'0'):fields[0],name:cases?fields[2]:fields[1],use:cases?fields[1]:fields[2],check:fields[3]});
    }
  }
  assert.equal(result.length,49,'策略源应保留11种方法和38条案例');
  return result;
}

// Formula text uses the already-calculated parameters; outputs below come from the result, not a second sizing algorithm.
function formula(cap,direction) {
  const a=display(direction==='open'?cap.areaOpenIn2:cap.areaCloseIn2,'area');
  const pressure=`${display(cap.supplyPsi,'pressure')} − ${display(cap.positionerHeadroomPsi,'pressure')}`;
  if(cap.type==='51') return `${a} × (${pressure})`;
  const powered=(direction==='open')===(cap.airAction==='air-to-open');
  return powered ? `${a} × (${pressure} − ${display(cap.spring[1],'pressure')})` : `${a} × ${display(cap.spring[0],'pressure')}`;
}

export function buildReportModel(result,plan,strategies) {
  assert.equal(plan.schemaVersion,1,'报告输入版本必须为1');
  assert.equal(plan.inputSha256,result.inputSha256,'报告计划与计算输入不对应');
  assert(Array.isArray(plan.schemes),'须给本次采用方案；空清单允许生成空汇总');
  const ids=new Set(),used=new Set(),schemes=[];
  for(const s of plan.schemes) {
    assert(text(s.schemeId)&&!ids.has(s.schemeId),'方案编号须非空且唯一');ids.add(s.schemeId);
    const v=result.valves.find(v=>v.id===s.valveId);assert(v,'位号不在计算结果中');
    assert(v.selectedSchemeIds.includes(s.candidateId),'方案不在可展示名单中');
    const r=getReviewRecord(v,s.candidateId);
    assert(!r.rejected.length&&!r.notPreparedReason,'已排除或待补条件方案不能进入报告');
    assert(['capacity','actuator','bonnet-only','special'].includes(s.scope),'须明确本次改动范围');
    assert(text(s.benefit)&&text(s.reason),'须有实际好处及本条修改原因');
    assert(s.originalSizeIn===null||finite(s.originalSizeIn)&&s.originalSizeIn>0,'原阀尺寸须为in数值或明确null');
    assert(s.quantity===null||Number.isInteger(s.quantity)&&s.quantity>0,'数量须为正整数或明确null');
    assert(Array.isArray(s.strategyIds)&&s.strategyIds.length,'须给采用策略');
    for(const id of s.strategyIds){assert(strategies.some(t=>t.id===id),'未知策略编号：'+id);used.add(id);}
    assert(Array.isArray(s.configurationRows)&&s.configurationRows[0]?.label==='型号','配置首行必须为原/新型号');
    const config=s.configurationRows.map(row=>({...row}));
    for(const row of config){assert(text(row.label)&&text(row.kind),'配置须给名称和数值含义kind');for(const k of ['original','optimized'])assert(finite(row[k])||text(row[k]),'缺配置须写待核，不能空白');}
    const onlyBonnet=s.scope==='bonnet-only';
    if(onlyBonnet) assert(config.every(row=>['型号','阀盖'].includes(row.label)),'仅阀盖方案不重复其他配置');
    const operating=[];
    if(s.scope==='capacity') {
      assert.deepEqual((s.originalCases||[]).map(c=>c.name),v.sourceCases.map(c=>c.name),'受影响方案必须保留全部源工况及顺序');
      for(const original of s.originalCases) {
        const computed=r.check.input?.cases.find(c=>c.name===original.name),velocity=r.check.cases.find(c=>c.name===original.name);
        assert(computed&&velocity,'工况计算缺失');
        assert(text(original.flowUnit)&&text(original.pressureUnit),'须保留原流量、压力单位及基准');
        for(const field of ['flowValue','p1','p2','temperatureC','originalRequiredCv','originalOpeningPercent','originalOutletVelocityMps'])
          assert(finite(original[field])||text(original[field]),'源工况缺项须明确：'+field);
        operating.push({...original,optimizedRequiredCv:computed.requiredCv ?? '待核',optimizedOpeningPercent:computed.estimatedTravelPercent ?? (computed.massFlowKgH===0?0:'待核'),optimizedOutletVelocityMps:velocity.velocityMps ?? velocity.roughVelocityMps ?? '待核',coarseVelocity:velocity.velocityMps===null&&velocity.roughVelocityMps!==null});
      }
      const cv=config.find(row=>row.label==='额定CV');
      if(v.baseline.ratedCv!==r.check.input.candidate.ratedCv)assert(cv,'改变CV须列原/新额定CV');
      if(v.baseline.bodyNominalMm!==r.check.input.candidate.bodyNominalMm)assert(config.some(row=>row.label==='尺寸'&&row.original!==row.optimized),'改变阀体尺寸须列原/新尺寸');
      if(cv){assert.equal(cv.original,v.baseline.ratedCv);assert.equal(cv.optimized,r.check.input.candidate.ratedCv);}
    } else assert(!s.originalCases?.length,'未改变容量/流动的方案不重复工况');
    let selected=null;
    if(s.selectedActuator) {
      const choice=s.selectedActuator;
      selected=r.actuatorScreen?.combinations.find(c=>String(c.type)===String(choice.type)&&String(c.size)===String(choice.size)&&c.travelIn===choice.travelIn&&JSON.stringify(c.spring)===JSON.stringify(choice.spring));
      assert(selected,'采用执行机构未绑定本轮具体组合');
      if(r.actuatorScreen.newLoadComplete)assert(!actuatorCombinationInsufficient(selected),'采用执行机构不满足明确新需求');
      if(r.actuation?.selection)assert.deepEqual(choice,r.actuation.selection,'不能在排版中更换已选执行机构');
      const original=v.actuators.original;
      const spring=c=>c.spring===null?'无弹簧':c.spring.join('–');
      for(const row of [
        {label:'执行机构',kind:'text',original:model(original),optimized:model(selected)},
        {label:'行程',kind:'length',unit:'in',original:original.travelIn,optimized:selected.travelIn},
        {label:'弹簧',kind:'text',unit:'psi',original:spring(original),optimized:spring(selected)}
      ]) {
        const supplied=config.find(c=>c.label===row.label);
        if(supplied){assert.equal(supplied.original,row.original,'原机构配置不对应：'+row.label);assert.equal(supplied.optimized,row.optimized,'采用机构配置不对应：'+row.label);}
        else if(row.original!==row.optimized)config.push(row);
      }
    }
    if(s.scope==='actuator'||s.scope==='capacity')assert(selected,'受力相关方案须指定完整执行机构组合，不取枚举第一条');
    if(onlyBonnet)assert(!s.selectedActuator&&!s.demandAssumption,'仅阀盖方案不列开关力');
    assert(config.some(row=>!['型号','额定CV','行程','开度'].includes(row.label)&&row.original!==row.optimized),'只有CV、行程或型号文字变化，不能冒充实际降本');
    const demandRows=[],actuatorRows=[];
    let demandHeader='优化方案';
    if(['capacity','actuator'].includes(s.scope)) {
      const baseline=v.actuators.baselineDemand?.adopted ?? v.actuators.original.capacity?.adoptedDemand;
      const current=r.actuatorScreen.adoptedDemand ?? (selected.pressureBudgetBasis==='old-load-only'?null:selected.capacity?.adoptedDemand);
      if(s.demandAssumption){assert(text(s.demandAssumption.source)&&s.demandAssumption.kind==='not-increased','假设须有本任务授权来源');assert(!current,'已有新需求不能替换成假设上限');demandHeader='优化方案（假设上限）';}
      for(const [direction,label] of [['open','要求的开启力'],['close','要求的关闭力']]) {
        const old=baseline?.[direction+'N'],nu=current?.[direction+'N'];
        demandRows.push({label,unit:'lbf',kind:'force',original:finite(old)?old/LBF_TO_N:'待核',optimized:finite(nu)?nu/LBF_TO_N:s.demandAssumption&&finite(old)?'≤ '+format(old/LBF_TO_N,'force'):'待核'});
      }
      const old=v.actuators.original.capacity,nu=selected.capacity;
      if(!old||!nu)actuatorRows.push({label:'执行机构输出',kind:'text',unit:'lbf',original:'待核',optimized:'待核'});
      else if(old.openN!==nu.openN||old.closeN!==nu.closeN) {
        for(const [label,key,kind,unit] of [['最低供气','supplyPsi','pressure','psi'],['定位器所需压差','positionerHeadroomPsi','pressure','psi'],['开启有效面积','areaOpenIn2','area','in²'],['关闭有效面积','areaCloseIn2','area','in²']])
          actuatorRows.push({label,kind,unit,original:old[key],optimized:nu[key]});
        for(const [direction,label] of [['open','开启'],['close','关闭']]) {
          actuatorRows.push({label:label+'输出算式',kind:'text',unit:'lbf',original:formula(old,direction),optimized:formula(nu,direction)});
          actuatorRows.push({label:label+'输出',kind:'force',unit:'lbf',original:old[direction+'N']/LBF_TO_N,optimized:nu[direction+'N']/LBF_TO_N});
        }
      }
    }
    const conditional=/有条件|证据不足/.test(r.status)||r.check.deviations?.length||r.notPreparedReason;
    schemes.push({...s,tag:s.tag||v.id,configurationRows:config,operatingCases:operating,demandRows,demandHeader,actuatorRows,benefit:conditional&&!s.benefit.startsWith('有条件')?'有条件：'+s.benefit:s.benefit});
  }
  return {schemes,strategies:strategies.filter(s=>!s.id.startsWith('案例')||used.has(s.id))};
}
