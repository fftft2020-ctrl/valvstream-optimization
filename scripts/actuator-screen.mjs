import {readFileSync} from 'node:fs';
import {reviewActuator} from './actuator-review.mjs';

const catalog=JSON.parse(readFileSync(new URL('../data/actuator-catalog.json',import.meta.url),'utf8'));
export const PSI_TO_MPA=0.006894757293168;
export const LBF_TO_N=4.4482216152605;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const text=v=>typeof v==='string'&&!!v.trim();
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const equal=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<1e-9;
const family=v=>typeof v==='string'||typeof v==='number'?String(v):'';
const source=id=>{const s=catalog.sources[id];return `${s.document}, ${s.revision}, p${s.pages.join(',')}`;};
const action=v=>({'Air to Open':'air-to-open','Air to Close':'air-to-close','air-to-open':'air-to-open','air-to-close':'air-to-close'}[v]||null);
const demandValid=d=>object(d)&&['openN','closeN'].every(k=>finite(d[k])&&d[k]>=0)&&finite(d.safetyFactor)&&d.safetyFactor>=1&&['included','excluded','unknown'].includes(d.safetyFactorInclusion)&&text(d.source)&&['openN','closeN'].every(k=>finite(d[k]*d.safetyFactor));
const adopted=d=>!demandValid(d)||d.safetyFactorInclusion==='unknown'?null:Object.fromEntries(['openN','closeN'].map(k=>[k,d[k]*(d.safetyFactorInclusion==='excluded'?d.safetyFactor:1)]));

function positionerBasis(input,type) {
 const missing=[];
 if(!object(input)||!text(input.model))return {requiredHeadroomPsi:null,missing:['须给定位器型号；未知型号还须显式给有来源的requiredHeadroomPsi']};
 const known=catalog.positioners[input.model],explicit=input.requiredHeadroomPsi;
 if(explicit!==undefined&&(!finite(explicit)||explicit<0||!text(input.source)))missing.push('显式定位器所需压差须为非负psi且有来源');
 if(known&&explicit!==undefined&&finite(explicit)&&explicit<known.requiredHeadroomPsi)missing.push('所给压差低于该定位器厂家已知最低要求，不能覆盖厂家值');
 if(input.circuit!==undefined&&input.circuit!=='standard'&&!(finite(explicit)&&text(input.source)))missing.push('非标准气路须提供适用的压差及来源，不能直接套标准继动器');
 if(!known&&!(finite(explicit)&&explicit>=0&&text(input.source)))missing.push('未知定位器须显式给有来源的requiredHeadroomPsi，不默认0或5psi');
 return {model:input.model,requiredHeadroomPsi:missing.length?null:explicit??known?.requiredHeadroomPsi??null,
  source:known?source(known.sourceRef)+(explicit!==undefined?`；附加依据：${input.source}`:''):input.source||null,
  manufacturerMinimumPsi:known?.requiredHeadroomPsi??null,
  maxSupplyPsi:known?.maxSupplyPsi[type==='51'?'double-acting':'single-acting']??null,missing};
}

function travelState(type,size,travelIn) {
 const p=catalog.families[type]?.sizes[size];
 if(!p||!finite(travelIn)||travelIn<=0)return {status:'UNKNOWN',reason:'缺有效型号、尺寸或正数机械行程'};
 if(type==='51') {
  if(travelIn<p.minimumTravelIn||travelIn>p.maximumTravelIn)return {status:'OUTSIDE_KNOWN_RANGE',reason:'超出此目录版本的行程范围；不评价特制配置是否可能'};
  const step=travelIn/p.travelIncrementIn;
  return Math.abs(step-Math.round(step))<1e-8||p.extraTravelIn.some(t=>equal(t,travelIn))?{status:'KNOWN',springs:[null]}:{status:'UNKNOWN',reason:'此行程未在已核验增量/特殊行程中，须补厂家资料'};
 }
 const listed=p.knownTravelIn.some(t=>equal(t,travelIn));
 if(!listed) {
  const low=Math.min(...p.knownTravelIn),high=Math.max(...p.knownTravelIn);
  return travelIn<low||travelIn>high?{status:'OUTSIDE_KNOWN_RANGE',reason:'超出此标准目录尺寸的行程范围；不评价特制配置'}:{status:'UNKNOWN',reason:'目录未收录此机械行程，不能解释成不可能'};
 }
 const springs=p.springRangesPsi[String(travelIn)];
 return springs?{status:'KNOWN',springs}:{status:'UNKNOWN',reason:'目录列机械行程，但未给该行程弹簧端点，不能借相邻档'};
}

/** Same-size and smaller known catalogue sizes, always at the candidate's new travel. */
export function enumerateActuatorOptions(original,travelIn) {
 const type=family(original?.type),size=String(original?.size??''),f=catalog.families[type],current=f?.sizes[size];
 const options=[],unverified=[],notApplicable=[];
 if(!current||!finite(travelIn)||travelIn<=0)return {options,unverified:[{size,reason:'原系列/尺寸或候选机械行程缺已知参数'}],notApplicable,complete:false};
 for(const [z,p] of Object.entries(f.sizes)) {
  if(p.rank>current.rank)continue;
  const state=travelState(type,z,travelIn);
  if(state.status==='UNKNOWN'){unverified.push({size:z,reason:state.reason});continue;}
  if(state.status==='OUTSIDE_KNOWN_RANGE'){notApplicable.push({size:z,reason:state.reason,source:source(f.sourceRef)});continue;}
  for(const spring of state.springs)options.push({type,size:z,travelIn,spring:spring===null?null:[...spring],role:z===size?'original-size-at-candidate-travel':'smaller-size-at-candidate-travel'});
 }
 return {options,unverified,notApplicable,complete:unverified.length===0,scope:'仅已核验目录，不代表全厂家可供范围'};
}

function capacity(spec,minimumSupplyMPa,positioner,demand) {
 const type=family(spec?.type),size=String(spec?.size??''),f=catalog.families[type],p=f?.sizes[size],missing=[];
 const result={model:`${type}/${size}`,type,size,travelIn:spec?.travelIn,spring:spec?.spring??null,status:'NEEDS_DATA',calculated:false,capacity:null,missing};
 if(!p){missing.push('此系列/尺寸缺已核验厂家参数，不能用输入的输出力替代计算');return result;}
 const state=travelState(type,size,spec.travelIn);
 if(state.status!=='KNOWN'){missing.push(state.reason);return result;}
 if(!finite(minimumSupplyMPa)||minimumSupplyMPa<=0||!finite(positioner.requiredHeadroomPsi)){missing.push('缺有效最低供气或有据定位器压差');return result;}
 const supplyPsi=minimumSupplyMPa/PSI_TO_MPA,drivePsi=supplyPsi-positioner.requiredHeadroomPsi;
 if(!finite(supplyPsi)||!finite(drivePsi)){missing.push('供气换算超出有效数值范围');return result;}
 let airAction=action(spec.airAction),openArea,closeArea,openN,closeN,formula,areaBasis,chamberMapping=null;
 if(type==='51') {
  if(spec.spring!=null){missing.push('51为无弹簧双作用，不能套弹簧参数');return result;}
  if(spec.airAction!==undefined&&!airAction){missing.push('51气动方向字段须为air-to-open/air-to-close；该字段不能证明上下腔与阀门开关的对应');return result;}
  if(spec.chamberMapping!==undefined) {
   const m=spec.chamberMapping;
   if(!object(m)||!['upper','lower'].includes(m.opening)||!text(m.source)||!text(m.configurationRef)) {
    missing.push('51 chamberMapping须给opening=upper/lower、独立来源source及精确配置configurationRef；不完整或非法时不能静默采用腔向');return result;
   }
   chamberMapping={opening:m.opening,source:m.source,configurationRef:m.configurationRef};
  }
  openArea=chamberMapping?(chamberMapping.opening==='upper'?p.upperAreaIn2:p.lowerAreaIn2):Math.min(p.upperAreaIn2,p.lowerAreaIn2);
  closeArea=chamberMapping?(chamberMapping.opening==='upper'?p.lowerAreaIn2:p.upperAreaIn2):Math.min(p.upperAreaIn2,p.lowerAreaIn2);
  openN=openArea*drivePsi*LBF_TO_N;closeN=closeArea*drivePsi*LBF_TO_N;
  areaBasis=chamberMapping?`厂家上下腔有效面积；依据独立配置${chamberMapping.configurationRef}将${chamberMapping.opening}腔对应开启，另一腔对应关闭；来源：${chamberMapping.source}`:'缺独立腔向配置绑定，两方向取较小腔面积作保守面积名义比较；Air Action不作为腔向证据，不是未知背压/内部损失后的保证下界';
  formula='F方向=(P最低供气−定位器所需压差)×该方向有效面积；已含活塞层数，不再乘2；背压/内部损失尚未量化';
 }else {
  if(!Array.isArray(spec.spring)||spec.spring.length!==2||!spec.spring.every(finite)||!state.springs.some(s=>s.every((v,i)=>equal(v,spec.spring[i])))){
   missing.push('此行程/尺寸的弹簧端点未匹配已核验目录，不能沿用旧行程范围');return result;
  }
  const fixed=f.airAction;
  if(fixed&&spec.airAction!==undefined&&airAction!==fixed){missing.push('输入气动开关方向与已核验87/88型号不符');return result;}
  airAction=fixed||airAction;
  if(!airAction){missing.push('52/53须明确airAction=air-to-open或air-to-close；伸缩方向不能直接当阀门开关');return result;}
  const springN=p.areaIn2*spec.spring[0]*LBF_TO_N,powerN=p.areaIn2*(drivePsi-spec.spring[1])*LBF_TO_N;
  openN=airAction==='air-to-open'?powerN:springN;closeN=airAction==='air-to-open'?springN:powerN;
  openArea=closeArea=p.areaIn2;areaBasis='厂家有效面积及此机械行程对应的完整弹簧范围';
  formula='气动端=A×(P最低供气−定位器所需压差−S终)，弹簧端=A×S起；psi×in²换N，再按动作映射开关';
 }
 if(![openN,closeN].every(finite)){missing.push('端点计算溢出');return result;}
 if(p.maxSupplyPsi===null||p.maxSupplyPsi===undefined)missing.push('此确切版本最高供气缺适用依据，不能自动沿用同数字尺寸');
 else if(supplyPsi>p.maxSupplyPsi+1e-8)missing.push('最低保证供气已高于此目录机构上限；须提供减压后供气或适用铭牌');
 if(finite(positioner.maxSupplyPsi)&&supplyPsi>positioner.maxSupplyPsi+1e-8)missing.push('供气超过所用定位器继动器已知上限，须核对实际气路');
 if(type==='51'&&Math.max(openN,closeN)>p.catalogMaximumThrustN)missing.push('名义P×A超过目录最大推力值，须核厂家额定基准，不据耐压上限认定可输出');
 const threshold=adopted(demand),openMarginN=threshold?openN-threshold.openN:null,closeMarginN=threshold?closeN-threshold.closeN:null;
 const budget=threshold?pressureBudget(type,spec.spring,airAction,openArea,closeArea,threshold,supplyPsi,positioner.requiredHeadroomPsi):null;
 const out={model:`${type}/${size}`,type,size,travelIn:spec.travelIn,spring:type==='51'?null:[...spec.spring],airAction,areaIn2:p.areaIn2??Math.min(p.upperAreaIn2,p.lowerAreaIn2),areaOpenIn2:openArea,areaCloseIn2:closeArea,upperAreaIn2:p.upperAreaIn2??null,lowerAreaIn2:p.lowerAreaIn2??null,
  openN,closeN,supplyMPa:minimumSupplyMPa,supplyPsi,positionerHeadroomPsi:positioner.requiredHeadroomPsi,openMarginN,closeMarginN,adoptedDemand:threshold,
  requiredSupplyPsi:budget?.requiredSupplyPsi??null,requiredPsi:budget?.requiredSupplyPsi??null,pressureMarginPsi:budget?.pressureMarginPsi??null,
  controlDirection:threshold?(openMarginN<=closeMarginN?'open':'close'):null,limitingMarginN:threshold?Math.min(openMarginN,closeMarginN):null,
  source:source(f.sourceRef)+'；'+positioner.source,outputBasis:'目录端点名义初筛，已扣已知定位器压差；未知背压/内部摩擦/全行程未保证',areaBasis,formula,computedFromManufacturerParameters:true,
  ...(type==='51'?{airActionInput:spec.airAction??null,chamberMapping}: {})};
 result.capacity=out;result.calculated=true;
 if(openN<0||closeN<0)missing.push('最低气源不足以克服对应弹簧端点；负值是理论端点缺口，不是实际可提供负推力');
 result.status=missing.length?'NEEDS_DATA':'CALCULATED';return result;
}

function pressureBudget(type,spring,airAction,openArea,closeArea,threshold,supplyPsi,drop) {
 const requiredActuatorPsi=type==='51'?Math.max(threshold.openN/LBF_TO_N/openArea,threshold.closeN/LBF_TO_N/closeArea):spring[1]+(airAction==='air-to-open'?threshold.openN/openArea:threshold.closeN/closeArea)/LBF_TO_N;
 return {requiredSupplyPsi:requiredActuatorPsi+drop,pressureMarginPsi:supplyPsi-requiredActuatorPsi-drop};
}

/**
 * Inputs are physical configuration and sourced demands, never precomputed forces.
 * Geometry qualifications: baselineQualification/candidateQualification each
 * {kind:'exact-catalog'|'as-built'|'inferred'|'unknown',source,configurationRef}.
 * Model 51 chamber mapping requires original.chamberMapping
 * {opening:'upper'|'lower',source,configurationRef}; airAction alone is not evidence.
 * This enumerates every candidate including reserve records; it does not rank.
 */
export function screenActuators(input) {
 const missing=[],pending=['仅已核验目录端点初筛；仍需新总负荷、完整行程、背压/摩擦、安装/附件和厂家供货核验'];
 const result={schemaVersion:1,catalogVersion:catalog.version,status:'NEEDS_DATA',calculationComplete:false,engineeringQualified:false,newLoadComplete:false,missing,pending,original:null,candidates:[],coverage:{expected:0,calculated:0,unknown:0,complete:false}};
 if(!object(input)){missing.push('缺执行机构初筛输入');return result;}
 const {minimumSupplyMPa,baselineDemand,original}=input;
 result.baselineDemand={source:baselineDemand?.source??null,adopted:adopted(baselineDemand)};
 if(!finite(minimumSupplyMPa)||minimumSupplyMPa<=0)missing.push('minimumSupplyMPa须显式为有效正数MPa表压，不内置客户气源');
 if(!demandValid(baselineDemand))missing.push('原需求须给非负开关N、安全系数>=1、包含关系included/excluded/unknown及来源；不默认客户值');
 else if(baselineDemand.safetyFactorInclusion==='unknown')missing.push('安全系数包含关系unknown，保留两种比较但不能确定采用门槛');
 const pos=positionerBasis(input.positioner,family(original?.type));result.positioner=pos;missing.push(...pos.missing);
 const orig=capacity(original,minimumSupplyMPa,pos,baselineDemand);result.original=orig;missing.push(...orig.missing.map(m=>'原机构：'+m));
 if(orig.capacity)orig.review=reviewActuator({minimumSupplyMPa,baselineDemand,loadChanged:false,capacities:[orig.capacity]});
 if(!Array.isArray(input.candidates)||!input.candidates.length){missing.push('须提供候选清单；空清单不能证明已遍历');return result;}
 const ids=new Set();
 for(const c of input.candidates) {
  const local=[];
  if(!object(c)||!text(c.id)||ids.has(c.id))local.push('候选id须非空且唯一，不丢弃重复/非法记录');
  if(text(c?.id))ids.add(c.id);
  if(typeof c?.loadChanged!=='boolean')local.push('须明确候选是否改变阀门配置');
  const enumeration=enumerateActuatorOptions(original,c?.travelIn),combinations=[];
  const demand=c?.loadChanged===false?baselineDemand:demandValid(c?.candidateDemand)?c.candidateDemand:baselineDemand;
  const factorBasisComplete=demandValid(demand)&&demand.safetyFactorInclusion!=='unknown';
  if(!factorBasisComplete)local.push('采用需求的安全系数或包含关系未定，不能确定余量和所需供气');
  for(const option of enumeration.options) {
   const calculated=capacity({...option,airAction:original?.airAction,chamberMapping:original?.chamberMapping},minimumSupplyMPa,pos,demand);
   const review=reviewActuator({minimumSupplyMPa,baselineDemand,candidateDemand:c?.candidateDemand,loadChanged:c?.loadChanged,geometry:c?.geometry,baselineBound:c?.baselineBound,capacities:calculated.capacity?[calculated.capacity]:[]});
   combinations.push({...option,...calculated,role:option.role,review,pressureBudgetBasis:c?.loadChanged===false?'unchanged-load':demand===c?.candidateDemand?'candidate-total':'old-load-only'});
  }
  const calculated=combinations.filter(r=>r.calculated).length,unknown=enumeration.unverified.length+enumeration.options.length-calculated;
  const complete=enumeration.complete&&calculated===enumeration.options.length;
  if(!complete)local.push('已知组合尚未全算或存在缺目录参数的尺寸/行程，不能声称遍历完成');
  const newLoadComplete=typeof c?.loadChanged==='boolean'&&demandValid(c.loadChanged?c.candidateDemand:baselineDemand)&&factorBasisComplete;
  if(!newLoadComplete)local.push('新总需求未完成；已保留原需求对照差额及百分比；条件上限仅在另有前提时列出');
  for(const combo of combinations) {local.push(...combo.missing.map(m=>`${combo.model} ${combo.spring?.join('-')??'无弹簧'}：${m}`));local.push(...combo.review.missing);}
  const screeningComplete=complete&&factorBasisComplete&&demandValid(baselineDemand)&&baselineDemand.safetyFactorInclusion!=='unknown'&&pos.missing.length===0&&finite(minimumSupplyMPa)&&minimumSupplyMPa>0;
  const candidate={id:c?.id??null,adoptedDemand:adopted(c?.loadChanged===false?baselineDemand:c?.candidateDemand),upstreamStatus:c?.status??null,status:local.length?'NEEDS_DATA':'SCREENED_KNOWN_CATALOG',screeningComplete,newLoadComplete,factorBasisComplete,missing:[...new Set(local)],coverage:{expected:enumeration.options.length,calculated,unknown,complete,unverified:enumeration.unverified,notApplicable:enumeration.notApplicable},combinations};
  result.candidates.push(candidate);
 }
 result.coverage={expected:result.candidates.reduce((n,c)=>n+c.coverage.expected,0),calculated:result.candidates.reduce((n,c)=>n+c.coverage.calculated,0),unknown:result.candidates.reduce((n,c)=>n+c.coverage.unknown,0),complete:result.candidates.every(c=>c.coverage.complete)};
 result.calculationComplete=orig.calculated&&result.candidates.every(c=>c.screeningComplete);
 result.newLoadComplete=result.candidates.every(c=>c.newLoadComplete);
 result.status=!missing.length&&result.candidates.every(c=>c.status==='SCREENED_KNOWN_CATALOG')?'SCREENED_KNOWN_CATALOG':'NEEDS_DATA';
 return result;
}

// Negative endpoint output means the guaranteed supply cannot overcome the spring at that endpoint.
export function actuatorCombinationInsufficient(combo) {
 return !!combo.capacity && (combo.capacity.openN<0 || combo.capacity.closeN<0)
  || combo.review.comparisons.some(c=>c.candidateVerdict==='INSUFFICIENT');
}
