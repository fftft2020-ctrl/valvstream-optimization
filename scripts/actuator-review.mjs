// Source-bound comparisons; this is not a full valve-load or actuator model.
const obj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const text = x => typeof x === 'string' && !!x.trim();
function validDemand(x) {
  return obj(x) && ['openN','closeN'].every(k=>finite(x[k]) && x[k]>=0)
    && finite(x.safetyFactor) && x.safetyFactor>=1
    && ['included','excluded','unknown'].includes(x.safetyFactorInclusion) && text(x.source);
}
function compare(demand, output) {
  const margins = {};
  for (const end of ['open','close']) {
    const value=demand[end+'N'], available=output[end+'N'];
    margins[end]={rawDemandN:value, includedThresholdN:value, excludedThresholdN:value*demand.safetyFactor,
      marginIfIncludedN:available-value, marginIfExcludedN:available-value*demand.safetyFactor};
  }
  if (!Object.values(margins).every(m=>Object.values(m).every(finite))) return null;
  const included=Object.values(margins).every(m=>m.marginIfIncludedN>=0);
  const excluded=Object.values(margins).every(m=>m.marginIfExcludedN>=0);
  const verdict=demand.safetyFactorInclusion==='included' ? (included?'MARGIN':'INSUFFICIENT')
    : demand.safetyFactorInclusion==='excluded' ? (excluded?'MARGIN':'INSUFFICIENT')
    : !included?'INSUFFICIENT':excluded?'MARGIN_WITH_UNKNOWN_FACTOR_BASIS':'FACTOR_BASIS_REQUIRED';
  return {margins,verdict};
}
function baselineHeadroom(demand, comparison) {
  if (!comparison) return null;
  if (demand.safetyFactorInclusion==='unknown') return {status:'FACTOR_BASIS_REQUIRED'};
  const included=demand.safetyFactorInclusion==='included';
  const directions=Object.fromEntries(['open','close'].map(direction=>{
    const m=comparison.margins[direction];
    const adoptedDemandN=included?m.includedThresholdN:m.excludedThresholdN;
    const headroomN=included?m.marginIfIncludedN:m.marginIfExcludedN;
    const percentage=adoptedDemandN>0?headroomN/adoptedDemandN*100:null;
    return [direction,{adoptedDemandN,headroomN,headroomPercent:finite(percentage)?percentage:null,
      minimumReductionN:Math.max(0,-headroomN)}];
  }));
  return {status:'BASELINE_REFERENCE_ONLY',directions,
    limitingDirectionByN:directions.open.headroomN<=directions.close.headroomN?'open':'close',
    limitingDirectionByPercent:Object.values(directions).every(d=>finite(d.headroomPercent))
      ?(directions.open.headroomPercent<=directions.close.headroomPercent?'open':'close'):null,
    basis:'比原需求多出的力；可能的需求增加和未计损失共同占用，不是新需求预测或新方案实际余量'};
}
// These are declared directional premises, not a computed new load or verified source.
function conditionalBaselineComparison(demand, oldComparison, bound, hydraulicChangeN, geometryQualified) {
  if (!obj(bound)) return null;
  const checks=['operatingConditions','pressureForces','sealingFriction','flowAndTravel'];
  return Object.fromEntries(['open','close'].map(direction=>{
    const premises=bound[direction];
    if (!['included','excluded'].includes(demand.safetyFactorInclusion))
      return [direction,{status:'FACTOR_BASIS_REQUIRED'}];
    if (!geometryQualified)
      return [direction,{status:'GEOMETRY_QUALIFICATION_REQUIRED',reason:'原/候选须分别绑定精确配置目录或实际装配证据；类比、未知、单纯数字和来源文字不能启用原需求上限'}];
    if (!obj(premises)||!checks.every(k=>obj(premises[k])
      &&['verified','assumed','increases'].includes(premises[k].status)&&text(premises[k].basis)))
      return [direction,{status:'PREMISES_REQUIRED'}];
    if (checks.some(k=>premises[k].status==='increases') || hydraulicChangeN?.[direction]>0)
      return [direction,{status:'BASELINE_BOUND_NOT_APPLICABLE',premises,
        reason:'存在增力项，先核算抵消量或新的上限；不能假定新总需求不增加'}];
    const m=oldComparison.margins[direction];
    const included=demand.safetyFactorInclusion==='included';
    const upperBoundN=included?m.includedThresholdN:m.excludedThresholdN;
    const marginN=included?m.marginIfIncludedN:m.marginIfExcludedN;
    return [direction,{status:marginN>=0?'CONDITIONAL_MARGIN':'REDUCTION_REQUIRED',
      upperBoundN,marginN,minimumReductionN:Math.max(0,-marginN),premises,
      unverifiedPremises:checks.filter(k=>premises[k].status==='assumed'),
      basis:'原需求作为有条件上限；不是新负荷预测，输出适用性和损失仍须核对'}];
  }));
}
export function reviewActuator(input) {
  const missing=[], pending=['输出余量不等于完整合格；仍核对全行程、气路损失、安装、阀杆和动作要求'];
  const result={comparisonComplete:false,newLoadComplete:false,geometryChecked:false,geometryQualified:false,geometryQualification:null,throatAreaChangeMm2:null,
    hydraulicChangeN:null,comparisons:[],missing,pending,liveValidated:false};
  if (!obj(input)) {missing.push('缺执行机构需求、候选能力和改Cv后的负荷检查');return result;}
  const {baselineDemand,candidateDemand,geometry,capacities,loadChanged,minimumSupplyMPa}=input;
  if (!validDemand(baselineDemand)) missing.push('原开启/关闭需求、单位N、安全系数包含关系和来源须完整');
  if (typeof loadChanged!=='boolean') missing.push('须明确阀门配置是否改变');
  if (!finite(minimumSupplyMPa) || minimumSupplyMPa<=0) missing.push('缺客户最低保证供气MPa表压');
  if (loadChanged) {
    const qualify=q=>obj(q)&&['exact-catalog','as-built'].includes(q.kind)&&text(q.source)&&text(q.configurationRef);
    result.geometryQualification={baseline:geometry?.baselineQualification??{kind:'unknown'},candidate:geometry?.candidateQualification??{kind:'unknown'}};
    result.geometryQualified=!!(qualify(geometry?.baselineQualification)&&qualify(geometry?.candidateQualification));
    if (!result.geometryQualified) missing.push('原/候选几何缺精确配置绑定：须分别给baselineQualification/candidateQualification的kind、source及configurationRef；inferred/unknown不能启用条件上限');
    if (!obj(geometry) || !['baselineThroatMm','candidateThroatMm'].every(k=>finite(geometry[k])&&geometry[k]>0) || !text(geometry.source)) {
      missing.push('改Cv或结构必须核对原/候选喉径及来源，不能只写行程');
    } else {
      const change=Math.PI/4*(geometry.candidateThroatMm**2-geometry.baselineThroatMm**2);
      if (!finite(change)) missing.push('喉径面积变化计算溢出');
      else {result.geometryChecked=true;result.throatAreaChangeMm2=change;}
      const h=geometry.hydraulic;
      if (h!=null) {
        if (!obj(h) || h.areaBasis!=='verified-net' || !text(h.source) || !text(h.structureAndDirection)
            || !finite(h.pressureDropMPa) || h.pressureDropMPa<0
            || ![h.baselineSignedNetAreaMm2,h.candidateSignedNetAreaMm2].every(a=>obj(a)&&['open','close'].every(k=>finite(a[k])))) {
          missing.push('液压力变化必须有净受压面积、结构/动作方向及关闭压差依据；喉径圆面积不能代入');
        } else {
          const delta=Object.fromEntries(['open','close'].map(k=>[k,h.pressureDropMPa*(h.candidateSignedNetAreaMm2[k]-h.baselineSignedNetAreaMm2[k])]));
          if (Object.values(delta).every(finite)) result.hydraulicChangeN=delta;
          else missing.push('液压力变化计算溢出');
        }
      } else if (!Array.isArray(geometry.missingNetAreaEvidence) || !geometry.missingNetAreaEvidence.length || !geometry.missingNetAreaEvidence.every(text)) {
        missing.push('须计算有据的净面积液压力变化，或逐项记录已查资料及尚缺的净面积/结构参数');
      }
      pending.push(change===0?'本档目录喉径未变，不能宣称喉径缩小带来减力':'喉径变化已量化；圆面积变化不等于净受压面积或总推力降幅');
    }
    if (!validDemand(candidateDemand)) missing.push('新总需求未完成；先列比原需求多出的力及百分比，保留已算分量；有据或用户明确假设时另评估条件上限，旧负荷不足不等于新方案失败');
  }
  const newDemand=loadChanged===false ? baselineDemand : candidateDemand;
  result.newLoadComplete=validDemand(newDemand);
  if (!Array.isArray(capacities)||!capacities.length) missing.push('须列出具体候选执行机构能力，不能只写待核型号');
  for (const output of Array.isArray(capacities)?capacities:[]) {
    if (!obj(output)||!text(output.model)||!text(output.source)||!text(output.outputBasis)
      || !['openN','closeN'].every(k=>finite(output[k])&&output[k]>=0)
      || !finite(output.supplyMPa)||output.supplyMPa!==minimumSupplyMPa) {
      missing.push('候选能力须注明型号、来源、开关输出及与最低保证供气一致的MPa表压');continue;
    }
    const old=validDemand(baselineDemand)?compare(baselineDemand,output):null;
    const current=result.newLoadComplete?compare(newDemand,output):null;
    if (validDemand(baselineDemand)&&!old || result.newLoadComplete&&!current) missing.push('需求门槛或余量计算溢出');
    const conditional=loadChanged===true&&!current&&old
      ?conditionalBaselineComparison(baselineDemand,old,input.baselineBound,result.hydraulicChangeN,result.geometryChecked&&result.geometryQualified):null;
    const hasConditional=conditional&&Object.values(conditional).some(c=>finite(c.marginN));
    result.comparisons.push({model:output.model,availableOpenN:output.openN,availableCloseN:output.closeN,
      supplyMPa:output.supplyMPa,outputBasis:output.outputBasis,source:output.source,
      baselineDemandComparison:old,candidateDemandComparison:current,conditionalBaselineComparison:conditional,
      baselineReferenceHeadroom:baselineHeadroom(baselineDemand,old),
      candidateVerdict:current?.verdict??(hasConditional?'CONDITIONAL_BASELINE_COMPARISON':'NEW_LOAD_NOT_CALCULATED')});
  }
  result.comparisonComplete=validDemand(baselineDemand)&&result.comparisons.length>0
    &&result.comparisons.length===capacities?.length&&result.comparisons.every(r=>r.baselineDemandComparison!==null);
  return result;
}
