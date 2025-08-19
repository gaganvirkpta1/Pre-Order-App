(function(){
  var BTN_TEXT = "Preorder Now";
  var NOTE = "This item is on preorder and will ship once back in stock.";

  function gid(v){ v=String(v||'').trim(); return /^\d+$/.test(v) ? "gid://shopify/ProductVariant/"+v : v; }
  function currentVariantId(form){ var i=form.querySelector('input[name="id"]'); return i?gid(i.value):null; }

  function addProps(form, msg){
    var p=form.querySelector('input[name="properties[Preorder]"]');
    if(!p){ p=document.createElement('input'); p.type='hidden'; p.name='properties[Preorder]'; form.appendChild(p); }
    p.value='Yes';
    if(msg){
      var m=form.querySelector('input[name="properties[Preorder Message]"]');
      if(!m){ m=document.createElement('input'); m.type='hidden'; m.name='properties[Preorder Message]'; form.appendChild(m); }
      m.value=msg;
    }
  }
  function injectMessage(btn, msg){
    var note=btn.parentNode.querySelector('[data-preorder-message]');
    if(!note){ note=document.createElement('div'); note.setAttribute('data-preorder-message','true'); note.style.marginTop='8px'; note.style.opacity='0.85'; btn.parentNode.appendChild(note); }
    note.textContent = msg || NOTE;
  }
  async function check(variantId){
    try{
      var origin=new URL(document.currentScript.src).origin;
      var shop=(window.Shopify&&Shopify.shop)||location.hostname;
      var r=await fetch(origin+"/apps/preorder/status?shop="+encodeURIComponent(shop)+"&variantId="+encodeURIComponent(variantId));
      if(!r.ok) return {checked:true,allow:false};
      return await r.json();
    }catch(e){ return {checked:true,allow:false}; }
  }
  async function enhance(form){
    var btn=form.querySelector('button[type="submit"],[type="submit"],button[name="add"]');
    var v=currentVariantId(form);
    if(!btn||!v) return;
    var s=await check(v);
    if(s.allow){
      btn.textContent=s.buttonText||BTN_TEXT;
      btn.disabled=false; btn.removeAttribute('aria-disabled');
      injectMessage(btn, s.message||NOTE);
      addProps(form, s.message);
    }
  }
  function ready(fn){ document.readyState==='loading'?document.addEventListener('DOMContentLoaded',fn):fn(); }
  ready(function(){
    document.querySelectorAll('form[action*="/cart/add"]').forEach(enhance);
    document.addEventListener('change', function(e){ var f=e.target&&e.target.form; if(f&&f.matches('form[action*="/cart/add"]')) enhance(f); }, true);
    document.addEventListener('product:variant-change', function(e){ var root=e.target||document; var f=root.querySelector&&root.querySelector('form[action*="/cart/add"]'); if(f) enhance(f); });
  });
})();
