export interface ControlState {
  value: string | null;
  attributes?: { min: string | null; max: string | null; step: string | null };
  checked: boolean | null;
  selectedIndex: number | null;
  focused: boolean;
  disabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
}
/** Fixed read-only observation, with the selector encoded as data. */
export function observeControl(selector: string): string {
  return `(() => { const nodes=document.querySelectorAll(${JSON.stringify(selector)});
    if(nodes.length!==1)throw Error('control missing or ambiguous'); const e=nodes[0],r=e.getBoundingClientRect();
    const attr=name=>e.getAttribute(name)===null?null:e.getAttribute(name).slice(0,160);
    return {tag:e.tagName.toLowerCase(),type:e.type||null,attributes:{min:attr('min'),max:attr('max'),step:attr('step')},
      attributesTruncated:['min','max','step'].some(name=>(e.getAttribute(name)||'').length>160),
      valueAsNumber:Number.isFinite(e.valueAsNumber)?e.valueAsNumber:null,
      value:typeof e.value==='string'?e.value:null,checked:typeof e.checked==='boolean'?e.checked:null,
      selectedIndex:typeof e.selectedIndex==='number'?e.selectedIndex:null,focused:document.activeElement===e,
      disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}; })()`;
}
export function unchangedControl(before: ControlState, after: ControlState, focus: boolean): void {
  if (
    before.value !== after.value ||
    before.checked !== after.checked ||
    before.selectedIndex !== after.selectedIndex ||
    JSON.stringify(before.attributes) !== JSON.stringify(after.attributes)
  )
    throw new Error("layout action unexpectedly changed control value");
  if (after.disabled || (focus && !after.focused))
    throw new Error("control disabled or focus not established");
}
export function nativeCenter(control: ControlState): { x: number; y: number } {
  const r = control.rect;
  const x = Math.round(r.x + r.width / 2),
    y = Math.round(r.y + r.height / 2);
  if (
    !Object.values(r).every(Number.isFinite) ||
    r.width <= 0 ||
    r.height <= 0 ||
    x < 0 ||
    x >= 1920 ||
    y < 0 ||
    y >= 1080
  )
    throw new Error("control center outside verified native display");
  return { x, y };
}
