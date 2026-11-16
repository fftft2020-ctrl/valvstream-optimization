import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewActuator} from './actuator-review.mjs';
import {checkCandidate} from './check-candidate.mjs';
import {readFileSync} from 'node:fs';
const sample=()=>({minimumSupplyMPa:.4,loadChanged:true,
 baselineDemand:{openN:5000,closeN:12000,safetyFactor:1.2,safetyFactorInclusion:'included',source:'synthetic-baseline'},
 candidateDemand:{openN:4500,closeN:8000,safetyFactor:1.2,safetyFactorInclusion:'included',source:'synthetic-recalculated-total'},
 geometry:{baselineThroatMm:60,candidateThroatMm:40,source:'synthetic-parameters',baselineQualification:{kind:'as-built',source:'synthetic original parameters',configurationRef:'original assembly'},candidateQualification:{kind:'exact-catalog',source:'synthetic candidate catalogue',configurationRef:'candidate assembly'},hydraulic:{areaBasis:'verified-net',source:'synthetic-force-balance',structureAndDirection:'unbalanced; positive opposes motion, negative assists',pressureDropMPa:2,baselineSignedNetAreaMm2:{open:2000,close:-2000},candidateSignedNetAreaMm2:{open:1000,close:-1000}}},
 capacities:[{model:'synthetic-small',openN:9000,closeN:9000,supplyMPa:.4,source:'synthetic-capacity',outputBasis:'nominal upper bound; losses pending'}]});
test('reference headroom needs no no-increase premise and cannot qualify a new load',()=>{
 const x=sample();delete x.candidateDemand;delete x.geometry;
 const r=reviewActuator(x),c=r.comparisons[0],h=c.baselineReferenceHeadroom;
 assert.equal(h.status,'BASELINE_REFERENCE_ONLY');assert.equal(h.directions.open.headroomN,4000);
 assert.equal(h.directions.open.headroomPercent,80);assert.equal(h.directions.close.headroomPercent,-25);
 assert.equal(h.directions.close.minimumReductionN,3000);assert.equal(h.limitingDirectionByN,'close');
 assert.equal(r.newLoadComplete,false);assert.equal(c.candidateDemandComparison,null);
 assert.equal(c.conditionalBaselineComparison,null);assert.equal(c.candidateVerdict,'NEW_LOAD_NOT_CALCULATED');
});
test('reference headroom applies the adopted factor and distinguishes limiting units',()=>{
 const x=sample();x.baselineDemand={...x.baselineDemand,openN:1000,closeN:10000,safetyFactor:1.2,safetyFactorInclusion:'excluded'};
 x.capacities[0]={...x.capacities[0],openN:1800,closeN:13000};
 const h=reviewActuator(x).comparisons[0].baselineReferenceHeadroom;
 assert.equal(h.directions.open.adoptedDemandN,1200);assert.equal(h.directions.open.headroomN,600);
 assert.equal(h.directions.open.headroomPercent,50);assert.equal(h.limitingDirectionByN,'open');
 assert.equal(h.limitingDirectionByPercent,'close');
});
test('zero demand and unknown factor never create invented percentage or adopted headroom',()=>{
 const x=sample();x.baselineDemand.openN=0;
 let h=reviewActuator(x).comparisons[0].baselineReferenceHeadroom;
 assert.equal(h.directions.open.headroomN,9000);assert.equal(h.directions.open.headroomPercent,null);
 assert.equal(h.limitingDirectionByPercent,null);
 x.baselineDemand.safetyFactorInclusion='unknown';h=reviewActuator(x).comparisons[0].baselineReferenceHeadroom;
 assert.deepEqual(h,{status:'FACTOR_BASIS_REQUIRED'});
 x.baselineDemand.safetyFactorInclusion='included';x.baselineDemand.openN=Number.MIN_VALUE;
 assert.equal(reviewActuator(x).comparisons[0].baselineReferenceHeadroom.directions.open.headroomPercent,null);
});
test('old load can fail while independently recalculated new load fits; no cross-scope rejection',()=>{
 const r=reviewActuator(sample());assert.equal(r.comparisons[0].baselineDemandComparison.verdict,'INSUFFICIENT');assert.equal(r.comparisons[0].candidateVerdict,'MARGIN');
 assert.equal(r.hydraulicChangeN.open,-2000);assert.equal(r.hydraulicChangeN.close,2000);
});
test('smaller throat actively computes supported hydraulic change even if total load is missing',()=>{
 const x=sample();delete x.candidateDemand;const r=reviewActuator(x);
 assert.equal(r.hydraulicChangeN.open,-2000);assert.equal(r.newLoadComplete,false);
 assert.equal(r.comparisons[0].candidateVerdict,'NEW_LOAD_NOT_CALCULATED');assert.equal(r.comparisonComplete,true);
});
test('same throat produces zero circular-area change, not invented force savings',()=>{
 const x=sample();x.geometry.candidateThroatMm=60;delete x.geometry.hydraulic;
 x.geometry.missingNetAreaEvidence=['pilot balance diameter not present in supplied parameters'];
 const r=reviewActuator(x);assert.equal(r.throatAreaChangeMm2,0);assert.equal(r.hydraulicChangeN,null);assert(r.pending.some(x=>x.includes('喉径未变')));
});
test('throat area cannot stand in for net pressure area, even with numeric inputs',()=>{
 const x=sample();x.geometry.hydraulic.areaBasis='throat-circle';const r=reviewActuator(x);
 assert.equal(r.hydraulicChangeN,null);assert(r.missing.some(x=>x.includes('净受压面积')));
});
test('unknown net area must name the searched source and actual missing dimensions',()=>{
 const x=sample();delete x.geometry.hydraulic;assert(reviewActuator(x).missing.some(x=>x.includes('逐项记录')));
 x.geometry.missingNetAreaEvidence=['catalog lists throat, not pilot-seat or balance diameter'];assert(!reviewActuator(x).missing.some(x=>x.includes('逐项记录')));
});
test('both directions, safety factor branches and failed candidates stay visible',()=>{
 const x=sample();x.loadChanged=false;x.baselineDemand={...x.baselineDemand,closeN:8000,safetyFactorInclusion:'unknown'};
 const r=reviewActuator(x),a=r.comparisons[0];assert.equal(a.candidateVerdict,'FACTOR_BASIS_REQUIRED');
 assert.equal(a.candidateDemandComparison.margins.close.marginIfIncludedN,1000);assert.equal(a.candidateDemandComparison.margins.close.marginIfExcludedN,-600);
 x.baselineDemand.openN=10000;assert.equal(reviewActuator(x).comparisons.length,1);assert.equal(reviewActuator(x).comparisons[0].candidateVerdict,'INSUFFICIENT');
});
test('stroke-only declaration, absent models and supply mismatch cannot complete comparison',()=>{
 assert.equal(reviewActuator({strokeShortened:true}).comparisonComplete,false);
 const x=sample();x.capacities[0].supplyMPa=.6;assert.equal(reviewActuator(x).comparisonComplete,false);
 x.capacities=[];assert.equal(reviewActuator(x).comparisonComplete,false);
});
test('invalid numbers and overflow are rejected without NaN-as-success',()=>{
 for(const n of [NaN,Infinity,'2000']){const x=sample();x.geometry.hydraulic.baselineSignedNetAreaMm2.open=n;assert.equal(reviewActuator(x).hydraulicChangeN,null);}
 const x=sample();x.baselineDemand.closeN=Number.MAX_VALUE;x.baselineDemand.safetyFactor=2;
 assert.equal(reviewActuator(x).comparisonComplete,false);
});
test('candidate checker exposes missing actuator work and rejects only relevant new load failure',()=>{
 const x=JSON.parse(readFileSync(new URL('./fixtures/candidate.json',import.meta.url)));
 assert.equal(checkCandidate(x).actuatorReview.comparisonComplete,false);
 x.actuatorReview=sample();let r=checkCandidate(x);assert.equal(r.status,'READY_FOR_SOFTWARE_CHECK');
 delete x.actuatorReview.candidateDemand;r=checkCandidate(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.rejected.length,0);
 x.actuatorReview.loadChanged=false;r=checkCandidate(x);assert.equal(r.status,'REJECTED');
});
const boundSample=()=>{
 const x=sample();delete x.candidateDemand;delete x.geometry.hydraulic;
 x.geometry.missingNetAreaEvidence=['synthetic parameters lacks balance/seal dimensions; assess unchanged-load premise'];
 const premises=()=>Object.fromEntries(['operatingConditions','pressureForces','sealingFriction','flowAndTravel'].map(k=>[k,{status:k==='operatingConditions'?'verified':'assumed',basis:'synthetic comparison: same operating envelope; unchanged force components require confirmation'}]));
 x.baselineBound={open:premises(),close:premises()};return x;
};
test('conditional old-demand bound gives directional margins without inventing a new total',()=>{
 const x=boundSample();x.capacities[0].closeN=12500;
 const r=reviewActuator(x),c=r.comparisons[0];
 assert.equal(r.newLoadComplete,false);assert.equal(c.candidateDemandComparison,null);
 assert.equal(c.candidateVerdict,'CONDITIONAL_BASELINE_COMPARISON');
 assert.equal(c.conditionalBaselineComparison.close.upperBoundN,12000);
 assert.equal(c.conditionalBaselineComparison.close.marginN,500);
 assert.equal(c.conditionalBaselineComparison.close.status,'CONDITIONAL_MARGIN');
 assert.equal(c.conditionalBaselineComparison.close.unverifiedPremises.length,3);
});
test('failure to cover an upper bound asks for a reduction, not rejection of the new configuration',()=>{
 const x=boundSample(),c=reviewActuator(x).comparisons[0].conditionalBaselineComparison;
 assert.equal(c.close.status,'REDUCTION_REQUIRED');assert.equal(c.close.minimumReductionN,3000);
 const input=JSON.parse(readFileSync(new URL('./fixtures/candidate.json',import.meta.url)));
 input.actuatorReview=x;const r=checkCandidate(input);
 assert.equal(r.status,'NEEDS_DATA');assert.equal(r.rejected.length,0);
});
test('increase in one direction blocks only that directional bound',()=>{
 const x=boundSample();x.baselineBound.open.pressureForces.status='increases';
 let c=reviewActuator(x).comparisons[0].conditionalBaselineComparison;
 assert.equal(c.open.status,'BASELINE_BOUND_NOT_APPLICABLE');assert.equal(c.close.status,'REDUCTION_REQUIRED');
 x.baselineBound.open.pressureForces.status='assumed';x.geometry.hydraulic=sample().geometry.hydraulic;
 c=reviewActuator(x).comparisons[0].conditionalBaselineComparison;
 assert.equal(c.open.status,'CONDITIONAL_MARGIN');assert.equal(c.close.status,'BASELINE_BOUND_NOT_APPLICABLE');
});
test('Cv or travel alone and undecided factor basis do not establish a conditional bound',()=>{
 const x=boundSample();x.baselineBound.open={cvReduced:true,strokeShortened:true};
 assert.equal(reviewActuator(x).comparisons[0].conditionalBaselineComparison.open.status,'PREMISES_REQUIRED');
 x.baselineDemand.safetyFactorInclusion='unknown';
 assert.equal(reviewActuator(x).comparisons[0].conditionalBaselineComparison.close.status,'FACTOR_BASIS_REQUIRED');
});
test('conditional bounds count an excluded factor once and prefer an actual new demand',()=>{
 const x=boundSample();x.baselineDemand.safetyFactorInclusion='excluded';
 let c=reviewActuator(x).comparisons[0];assert.equal(c.conditionalBaselineComparison.close.upperBoundN,14400);
 assert.equal(c.conditionalBaselineComparison.close.minimumReductionN,5400);
 x.candidateDemand=sample().candidateDemand;c=reviewActuator(x).comparisons[0];
 assert.equal(c.conditionalBaselineComparison,null);assert.equal(c.candidateVerdict,'MARGIN');
});
test('equal numeric throats and a text source do not prove an exact original configuration',()=>{
 const x=boundSample();x.geometry.candidateThroatMm=x.geometry.baselineThroatMm;delete x.geometry.baselineQualification;
 const r=reviewActuator(x);assert.equal(r.geometryChecked,true);assert.equal(r.geometryQualified,false);
 assert.equal(r.comparisonComplete,true);assert.equal(r.comparisons[0].conditionalBaselineComparison.open.status,'GEOMETRY_QUALIFICATION_REQUIRED');
 assert(r.missing.some(s=>s.includes('精确配置')));
});
test('inferred or unknown geometry blocks only the new-load upper bound, not old-load arithmetic',()=>{
 for(const kind of ['inferred','unknown']) {
  const x=boundSample();x.geometry.baselineQualification.kind=kind;const r=reviewActuator(x);
  assert.equal(r.comparisons[0].baselineDemandComparison.verdict,'INSUFFICIENT');
  assert.equal(r.comparisons[0].conditionalBaselineComparison.close.status,'GEOMETRY_QUALIFICATION_REQUIRED');
  assert.equal(r.newLoadComplete,false);
 }
});
test('qualification also needs configuration binding and source on both sides',()=>{
 for(const end of ['baseline','candidate'])for(const field of ['source','configurationRef']) {
  const x=boundSample();delete x.geometry[end+'Qualification'][field];assert.equal(reviewActuator(x).geometryQualified,false);
 }
});
