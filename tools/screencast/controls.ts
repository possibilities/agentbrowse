/** Fixed read-only top-level DOM observation. No caller-supplied expression. */
export const OBSERVE_CONTROLS = `(() => {
  const nodes = document.querySelectorAll('input,select,button');
  const text = value => String(value ?? '').slice(0,160);
  return { version:1, scope:'top-level', total:nodes.length, truncated:nodes.length>256,
    viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},
    controls:Array.from(nodes).slice(0,256).map(e => {
      const r=e.getBoundingClientRect(), style=getComputedStyle(e);
      const type=String(e.type || '').toLowerCase();
      const attr=name=>e.getAttribute(name)===null?null:text(e.getAttribute(name));
      const readable=e.tagName==='SELECT' || ['range','number','checkbox','radio'].includes(type);
      const options=e.tagName==='SELECT'?Array.from(e.options).slice(0,64).map(o=>({value:text(o.value),label:text(o.label),selected:o.selected,disabled:o.disabled})):undefined;
      return {tag:e.tagName.toLowerCase(),id:text(e.id),name:text(e.name),type,
        selector:e.id && e.id.length<=160 && document.querySelectorAll('#'+CSS.escape(e.id)).length===1?'#'+CSS.escape(e.id):null,
        label:text(e.getAttribute('aria-label') || Array.from(e.labels || []).map(l=>l.textContent).join(' ') || (e.tagName==='BUTTON'?e.textContent:'')),
        value:readable?text(e.value):null,
        valueAsNumber:readable && Number.isFinite(e.valueAsNumber)?e.valueAsNumber:null,
        min:attr('min'),max:attr('max'),step:attr('step'),
        attributesTruncated:['min','max','step'].some(name=>(e.getAttribute(name)||'').length>160),
        disabled:!!e.disabled,readOnly:!!e.readOnly,checked:readable && 'checked' in e?e.checked:null,
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},
        visible:style.visibility==='visible' && style.display!=='none' && Number(style.opacity)!==0 && r.width>0 && r.height>0,
        intersectsViewport:r.right>0 && r.bottom>0 && r.left<innerWidth && r.top<innerHeight,
        options,optionsTruncated:e.tagName==='SELECT' && e.options.length>64};
    })};
})()`;
