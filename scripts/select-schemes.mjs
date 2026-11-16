/** Pure display selection. It preserves engineering decisions; ordinal rules are not a qualification score. */
export function selectSchemes(records, limit=3) {
  if(!Number.isInteger(limit)||limit<1)throw new RangeError('展示数必须为正整数');
  const priority=['优先复核','有条件候选','证据不足'];
  const order={benefit:['actuator','physical','control','unknown'],evidence:['new-load','bound','curve','old-load','concept','unknown'],risk:['unchanged','pending','geometry-unknown','unknown']};
  const ranked=records.map(s=>{
    const upstream=s.upstreamPriority||s.status||'证据不足';
    const rejected=Array.isArray(s.rejected)?s.rejected:[];
    const archived=rejected.length>0||/备查|不建议|不继续|排除|失败/.test(upstream);
    const selectionBasis={priority:upstream,benefit:order.benefit.includes(s.benefitClass)?s.benefitClass:'unknown',evidence:order.evidence.includes(s.evidenceClass)?s.evidenceClass:'unknown',risk:order.risk.includes(s.riskClass)?s.riskClass:'unknown',route:s.route||'方向待核'};
    return {...s,status:rejected.length?'已排除':upstream,selectionBasis,display:{selected:false,reason:rejected.length?rejected.join('；'):archived?'沿用上游不继续/备查结论，不因容量检查状态重新升级':s.notPreparedReason||''},eligible:!archived&&!s.notPreparedReason};
  });
  const cmp=(a,b)=>{
    const pa=priority.indexOf(a.status),pb=priority.indexOf(b.status);
    let n=(pa<0?priority.length:pa)-(pb<0?priority.length:pb);if(n)return n;
    for(const k of ['benefit','evidence','risk']) {n=order[k].indexOf(a.selectionBasis[k])-order[k].indexOf(b.selectionBasis[k]);if(n)return n;}
    return a.id.localeCompare(b.id,'en');
  };
  const eligible=ranked.filter(s=>s.eligible).sort(cmp), representatives=[];
  for(const s of eligible)if(!representatives.some(r=>r.route===s.route))representatives.push(s);
  // Compare independent routes first; the final ID tie-break affects display only, never engineering acceptance.
  const chosen=[...representatives,...eligible.filter(s=>!representatives.includes(s))].slice(0,limit);
  for(const s of eligible) {
    s.display.selected=chosen.includes(s);
    s.display.reason=s.display.selected?'保留上游行动结论；按收益依据、证据及风险比较，优先覆盖同台独立方向':representatives.includes(s)?`展示限额${limit}项；独立方向比较后后排，仍是有条件线索，未判失败`:`同方向已有 ${representatives.find(r=>r.route===s.route).id} 展示；本档保留作取舍备查，不能据此推断无收益`;
  }
  return {records:ranked.sort((a,b)=>a.id.localeCompare(b.id,'en')).map(({eligible,...s})=>s),selectedSchemeIds:chosen.map(s=>s.id)};
}
