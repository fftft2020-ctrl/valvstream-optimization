import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {screenActuators,enumerateActuatorOptions,LBF_TO_N as N,PSI_TO_MPA} from './actuator-screen.mjs';
const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const baseline=()=>({openN:2000,closeN:7000,safetyFactor:1.2,safetyFactorInclusion:'included',source:'synthetic engineering demand'});
const input=()=>({minimumSupplyMPa:60*PSI_TO_MPA,positioner:{model:'SVI II AP'},baselineDemand:baseline(),original:{type:'88',size:'23L',travelIn:3,spring:[12,30]},candidates:[{id:'short-reserve',travelIn:2.5,loadChanged:true,status:'备查'}]});
const pick=(r,size='16',spring=[21,45],c=0)=>r.candidates[c].combinations.find(x=>x.size===size&&JSON.stringify(x.spring)===JSON.stringify(spring));
const geometry=(kind='exact-catalog')=>({baselineThroatMm:80,candidateThroatMm:80,source:'synthetic geometry comparison',baselineQualification:{kind,source:'synthetic original catalog',configurationRef:'original full assembly'},candidateQualification:{kind:'as-built',source:'synthetic candidate parameters',configurationRef:'candidate full assembly'},missingNetAreaEvidence:['synthetic parameters lacks balanced seal diameter and stage pressures']});
const bound=()=>Object.fromEntries(['open','close'].map(d=>[d,Object.fromEntries(['operatingConditions','pressureForces','sealingFriction','flowAndTravel'].map(k=>[k,{status:'assumed',basis:'synthetic testable unchanged component premise'}]))]));

test('short-travel reserve routes enumerate both smaller sizes and every spring before display decisions',()=>{
 const r=screenActuators(input()),c=r.candidates[0];assert.equal(c.upstreamStatus,'备查');assert.equal(c.coverage.expected,8);assert.equal(c.coverage.calculated,8);assert.equal(c.coverage.complete,true);
 assert(pick(r));assert.equal(pick(r).review.comparisonComplete,true);assert.equal(r.newLoadComplete,false);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.engineeringQualified,false);
 assert.deepEqual(c.combinations.filter(x=>x.size==='16').map(x=>x.spring),[[3,15],[6,30],[11,23],[21,45]]);
});
test('known positioner headroom changes the pneumatic force and pressure budget, never the spring return force',()=>{
 const r=screenActuators(input()),c=pick(r).capacity;
 near(c.openN,160*(60-5-45)*N);near(c.closeN,160*21*N);
 near(c.openMarginN,c.openN-2000);near(c.closeMarginN,c.closeN-7000);
 near(c.requiredSupplyPsi,45+2000/160/N+5);near(c.pressureMarginPsi,60-c.requiredSupplyPsi);
 assert.match(c.source,/2023, p141,142,143/);assert.equal(c.positionerHeadroomPsi,5);
});
test('equal analogue geometry does not become a conditional upper bound, but old comparisons remain',()=>{
 const x=input();Object.assign(x.candidates[0],{geometry:geometry('inferred'),baselineBound:bound()});let r=screenActuators(x),review=pick(r).review;
 assert.equal(review.geometryChecked,true);assert.equal(review.geometryQualified,false);assert.equal(review.comparisonComplete,true);
 assert.equal(review.comparisons[0].conditionalBaselineComparison.open.status,'GEOMETRY_QUALIFICATION_REQUIRED');
 x.candidates[0].geometry=geometry();r=screenActuators(x);assert.equal(pick(r).review.comparisons[0].conditionalBaselineComparison.open.status,'CONDITIONAL_MARGIN');
});
test('same original size must use newly enumerated springs for the new mechanical travel',()=>{
 const x=input();x.candidates[0].travelIn=3.5;const r=screenActuators(x),c=r.candidates[0];
 assert.equal(c.coverage.expected,2);assert(c.combinations.every(x=>x.role==='original-size-at-candidate-travel'));
 assert.deepEqual(c.combinations.map(x=>x.spring),[[9,30],[24,45]]);assert(!c.combinations.some(x=>JSON.stringify(x.spring)==='[12,30]'));
 near(c.combinations[0].capacity.closeN,230*9*N);near(r.original.capacity.closeN,230*12*N);
});
test('52 optional spring endpoints are specific to the candidate travel and include retained original size',()=>{
 const x=input();x.original={type:'52',size:'16',travelIn:6,spring:[10,25],airAction:'air-to-close'};x.candidates[0].travelIn=3.5;
 const c=screenActuators(x).candidates[0];assert.equal(c.coverage.expected,6);assert.equal(c.coverage.calculated,6);
 assert.deepEqual(c.combinations.filter(x=>x.size==='12').map(x=>x.spring),[[10,23],[20,38],[25,47]]);
 assert(c.combinations.every(x=>x.spring[1]!==25));
});
test('a listed mechanical travel without spring endpoints remains NEEDS_DATA, never zero-options complete',()=>{
 const x=input();x.original={type:'52',size:'20',travelIn:6,spring:[10,25],airAction:'air-to-close'};x.candidates[0].travelIn=1.25;
 const c=screenActuators(x).candidates[0];assert.equal(c.status,'NEEDS_DATA');assert.equal(c.coverage.complete,false);assert(c.coverage.unknown>0);assert(c.coverage.unverified.some(x=>x.reason.includes('弹簧端点')));
});
test('unknown family/size cannot return an empty complete receipt',()=>{
 for(const original of [{type:'other',size:'16',travelIn:3,spring:[1,2]},{type:'51',size:'46',travelIn:4}]) {
  const x=input();x.original=original;const r=screenActuators(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.original.capacity,null);assert.equal(r.candidates[0].coverage.complete,false);assert(r.coverage.unknown>0);
 }
});
test('excluded safety factor is applied once; unknown inclusion preserves both comparisons without adopting either',()=>{
 const x=input();x.baselineDemand.safetyFactor=1.5;x.baselineDemand.safetyFactorInclusion='excluded';let r=screenActuators(x),c=pick(r).capacity;
 assert.deepEqual(c.adoptedDemand,{openN:3000,closeN:10500});near(c.closeMarginN,c.closeN-10500);near(c.requiredSupplyPsi,45+3000/160/N+5);
 x.baselineDemand.safetyFactorInclusion='unknown';r=screenActuators(x);assert.equal(r.calculationComplete,false);assert.equal(pick(r).capacity.adoptedDemand,null);assert.equal(pick(r).capacity.requiredSupplyPsi,null);
 assert(pick(r).review.comparisons[0].baselineDemandComparison.margins.open.marginIfExcludedN!==null);
});
test('independently sourced candidate demand takes precedence without being confused with the original total',()=>{
 const x=input();x.candidates[0].geometry=geometry();x.candidates[0].candidateDemand={...baseline(),openN:1500,closeN:6000};
 const r=screenActuators(x),c=pick(r);assert.equal(r.candidates[0].newLoadComplete,true);assert.equal(c.pressureBudgetBasis,'candidate-total');assert.equal(c.review.comparisons[0].conditionalBaselineComparison,null);
 near(c.capacity.openMarginN,c.capacity.openN-1500);near(c.review.comparisons[0].baselineDemandComparison.margins.open.marginIfIncludedN,c.capacity.openN-2000);
 x.candidates[0].candidateDemand.safetyFactorInclusion='unknown';const unknown=screenActuators(x);assert.equal(unknown.candidates[0].status,'NEEDS_DATA');assert.equal(unknown.candidates[0].newLoadComplete,false);assert.equal(pick(unknown).capacity.requiredSupplyPsi,null);
});
test('zero demand is valid and is not replaced with fake positive values',()=>{
 const x=input();x.baselineDemand.openN=x.baselineDemand.closeN=0;x.candidates[0].loadChanged=false;
 const r=screenActuators(x),c=pick(r).capacity;assert.deepEqual(c.adoptedDemand,{openN:0,closeN:0});near(c.openMarginN,c.openN);near(c.requiredSupplyPsi,50);assert.equal(r.newLoadComplete,true);
});
test('minimum supply, safety factor, inclusion and sources have no customer defaults',()=>{
 for(const edit of [x=>delete x.minimumSupplyMPa,x=>delete x.baselineDemand.safetyFactor,x=>delete x.baselineDemand.safetyFactorInclusion,x=>delete x.baselineDemand.source]){
  const x=input();edit(x);const r=screenActuators(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.calculationComplete,false);
 }
});
test('invalid inputs and overflow stay visible without NaN, fake zero or a batch crash',()=>{
 for(const value of [null,-1,0,NaN,Infinity,'0.4',Number.MAX_VALUE]) {
  const x=input();x.minimumSupplyMPa=value;const r=screenActuators(x);assert.equal(r.status,'NEEDS_DATA');assert(!JSON.stringify(r).includes('NaN'));
 }
 for(const value of [null,-1,NaN,Infinity,'2000']){const x=input();x.baselineDemand.openN=value;assert.equal(screenActuators(x).status,'NEEDS_DATA');}
 const x=input();x.candidates.push({id:'bad',travelIn:null,loadChanged:true});const r=screenActuators(x);assert.equal(r.candidates.length,2);assert.equal(r.candidates[0].coverage.calculated,8);assert.equal(r.candidates[1].status,'NEEDS_DATA');
});
test('unknown positioner needs explicit sourced pressure; an asserted zero cannot overwrite known SVI headroom',()=>{
 const x=input();x.positioner={model:'other'};assert.equal(screenActuators(x).calculationComplete,false);
 x.positioner={model:'other',requiredHeadroomPsi:3,source:'synthetic manufacturer sheet'};let r=screenActuators(x);near(pick(r).capacity.openN,160*(60-3-45)*N);
 x.positioner={model:'SVI II AP',requiredHeadroomPsi:0,source:'unsubstantiated override'};assert.equal(screenActuators(x).calculationComplete,false);
 x.positioner={model:'other',requiredHeadroomPsi:0};assert.equal(screenActuators(x).calculationComplete,false);
});
test('51 uses manufacturer two-chamber areas, labels the conservative smaller-area case, and never doubles areas',()=>{
 const x=input();x.original={type:'51',size:'20',travelIn:4};let r=screenActuators(x),cap=r.original.capacity;
 near(cap.openN,287.4*55*N);near(cap.closeN,287.4*55*N);assert.equal(cap.upperAreaIn2,289.7);assert.match(cap.areaBasis,/保守面积/);assert.equal(r.candidates[0].coverage.expected,3);
 for(const airAction of ['Air to Open','Air to Close']) {
  x.original.airAction=airAction;r=screenActuators(x);near(r.original.capacity.openN,287.4*55*N);near(r.original.capacity.closeN,287.4*55*N);
  assert.equal(r.original.capacity.airActionInput,airAction);assert.equal(r.original.capacity.chamberMapping,null);
 }
});
test('51 chamber directions require independent sourced configuration binding and apply to every enumerated size',()=>{
 const x=input();x.original={type:'51',size:'20',travelIn:4,airAction:'Air to Open'};
 for(const opening of ['upper','lower']) {
  x.original.chamberMapping={opening,source:'synthetic assembly parameters',configurationRef:'synthetic complete assembly'};
  const r=screenActuators(x),cap=r.original.capacity;
  near(cap.openN,(opening==='upper'?289.7:287.4)*55*N);near(cap.closeN,(opening==='upper'?287.4:289.7)*55*N);
  assert.deepEqual(cap.chamberMapping,x.original.chamberMapping);
  for(const c of r.candidates[0].combinations) {
   assert.deepEqual(c.capacity.chamberMapping,x.original.chamberMapping);
   near(c.capacity.openN,(opening==='upper'?c.capacity.upperAreaIn2:c.capacity.lowerAreaIn2)*55*N);
  }
 }
});
test('51 rejects incomplete or illegal chamber mapping instead of silently falling back',()=>{
 for(const chamberMapping of [null,{},'upper',{opening:'side',source:'parameters',configurationRef:'assembly'},{opening:'upper',configurationRef:'assembly'},{opening:'lower',source:'parameters'},{opening:'upper',source:' ',configurationRef:'assembly'}]) {
  const x=input();x.original={type:'51',size:'20',travelIn:4,chamberMapping};
  const r=screenActuators(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.original.capacity,null);
  assert(r.original.missing.some(m=>m.includes('chamberMapping')));assert(r.candidates[0].combinations.every(c=>c.status==='NEEDS_DATA'&&c.capacity===null));
 }
});
test('52/53 require valve open/close mapping and do not borrow the other family short-stroke endpoints',()=>{
 const x=input();x.original={type:'52',size:'16',travelIn:6,spring:[10,25]};assert.equal(screenActuators(x).original.calculated,false);
 x.original={type:'53',size:'16',travelIn:6,spring:[10,25],airAction:'air-to-open'};x.candidates[0].travelIn=3.5;
 const r=screenActuators(x);assert.deepEqual(r.candidates[0].combinations.filter(c=>c.size==='12').map(c=>c.spring),[[12,25],[22,40],[28,50]]);
});
test('caller-provided available forces and areas do not substitute for calculations',()=>{
 const x=input(),before=screenActuators(x);x.original.openN=999999;x.original.areaIn2=999999;x.candidates[0].availableOpenN=999999;x.candidates[0].capacity={openN:999999,closeN:999999};
 const r=screenActuators(x);assert.deepEqual(r.original.capacity,before.original.capacity);assert.deepEqual(r.candidates[0].combinations.map(c=>c.capacity),before.candidates[0].combinations.map(c=>c.capacity));
});
test('changing metadata/order does not skip candidates or add per-Item branches, and the API does not mutate inputs',()=>{
 const x=input();x.candidates.push({...x.candidates[0],id:'another',status:'优先复核'});const before=JSON.stringify(x),r=screenActuators(x);assert.equal(JSON.stringify(x),before);assert.equal(r.candidates.length,2);assert.equal(r.coverage.expected,16);
 const code=readFileSync(new URL('./actuator-screen.mjs',import.meta.url),'utf8');assert(!code.includes('scratch/'));assert(!/\.item\b/.test(code));
 assert.equal(enumerateActuatorOptions({type:'52',size:'16'},1.1).complete,false);
});
test('new-flow-force increases cannot be erased by exact geometric qualification',()=>{
 const x=input();Object.assign(x.candidates[0],{geometry:geometry(),baselineBound:bound()});x.candidates[0].baselineBound.close.flowAndTravel.status='increases';
 assert.equal(pick(screenActuators(x)).review.comparisons[0].conditionalBaselineComparison.close.status,'BASELINE_BOUND_NOT_APPLICABLE');
});
test('negative theoretical endpoints are retained as deficits and never reviewed as usable available force',()=>{
 const x=input();x.minimumSupplyMPa=40*PSI_TO_MPA;
 const c=pick(screenActuators(x));near(c.capacity.openN,160*(40-5-45)*N);
 assert.equal(c.status,'NEEDS_DATA');assert(c.missing.some(m=>m.includes('不是实际可提供负推力')));
 assert.equal(c.review.comparisonComplete,false);assert.deepEqual(c.review.comparisons,[]);
});
