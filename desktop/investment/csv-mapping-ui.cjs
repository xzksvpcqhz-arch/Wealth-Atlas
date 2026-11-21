'use strict';
const mappingModel=require('./csv-mapping.cjs');
let sequence=0;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const errorText=value=>({CSV_TOO_LARGE:'CSV 需小于 2 MB。',CSV_TOO_MANY_ROWS:'CSV 最多支持 20,000 笔。',CSV_TOO_MANY_COLUMNS:'CSV 最多支持 128 栏。',CSV_QUOTES_INVALID:'CSV 引号格式无效，请核对原文件。',CSV_HEADER_INVALID:'CSV 需要有效、非空的表头，不能含控制字符。',CSV_HEADER_DUPLICATE:'CSV 表头重复，请先核对原文件。',CSV_COLUMNS_MISMATCH:'CSV 列数与表头不一致。',CSV_MAPPING_REQUIRED:'请完成所有必需栏位的来源选择。',CSV_MAPPING_SOURCE_MISSING:'映射引用的来源栏位不存在，请重新核对表头。',CSV_MAPPING_SOURCE_DUPLICATE:'同一来源栏位不能重复对应多个投资栏位。',CSV_TRADES_EMPTY:'没有可检查的流水资料行。',CSV_SECURITY_ID_INVALID:'证券 ID 不能为空或过长。',CSV_SECURITY_ID_DUPLICATE:'同一快照的证券 ID 重复，请先合并后导入。',CSV_NAME_INVALID:'证券名称过长，请核对原文件。',CSV_NUMBER_INVALID:'金额、数量、单价需为明确的非负数字，汇率与买卖数量需为正数；不会自动改符号或补汇率。',CSV_TRADE_ID_INVALID:'成交／流水 ID 不能为空或过长。',CSV_TRADE_ID_DUPLICATE:'同一批 CSV 的成交／流水 ID 重复，请先核对原文件。',CSV_TRADE_TYPE_INVALID:'交易类型只接受 buy / sell / dividend / fee / deposit / withdrawal，不会自动猜测。',CSV_DATE_INVALID:'日期与汇率日期需为有效 YYYY-MM-DD，不会自动调换日／月。',CSV_TEMPLATE_LIMIT:'模板最多保存 10 套，请先删除不需要的模板。',CSV_TEMPLATE_NAME_INVALID:'名称需为 1–30 个字符，不能包含控制字符。',CSV_TEMPLATE_NAME_DUPLICATE:'这个模板名称已存在，请使用其他名称。',CSV_TEMPLATE_NOT_FOUND:'模板已被移除，请重新读取模板。'}[value]||'栏位映射或模板格式无效，请核对后重试。');

// Mapping controls own no financial persistence. Only the existing workbench's
// explicit check/save flow may consume their canonical CSV output.
function createCsvMappingUi({store,onInvalidate=()=>{}}={}){
 const prefix='ni-csv-'+(++sequence);
 let host=null,dialog=null,trigger=null,kind='snapshot',raw='',headers=[],rows=[],mapping={},selected='',dirty=false;
 let book=null,loadError=false,sourceError='',message='',revision=0,loading=false,saving=false,action=null,alive=true,loadTicket=0,showRequiredErrors=false;
 const fields=()=>mappingModel.fieldsFor(kind);
 const valid=()=>headers.length>0&&mappingModel.checkMapping(kind,headers,mapping).ok;
 const selectedTemplate=()=>book?.templates.find(item=>item.id===selected&&item.kind===kind);
 function say(value){message=value;if(host?.isConnected)host.querySelector('[data-csv-status]').textContent=message;}
 function invalidate(){revision++;onInvalidate();}
 function updateControls(){
  if(!host?.isConnected)return;
  const target=selectedTemplate();
  for(const name of ['apply','rename','delete'])host.querySelector('[data-csv-'+name+']').disabled=saving||loading||!target;
  host.querySelector('[data-csv-save]').disabled=saving||loading||!book||!valid();
  host.querySelector('[data-csv-reload]').disabled=saving||loading;
  const assigned=fields().filter(f=>f.required&&headers.includes(mapping[f.id])).length;
  host.querySelector('[data-csv-count]').textContent=`必需栏位 ${assigned} / ${fields().filter(f=>f.required).length}`;
 }
 function renderTemplates(){
  if(!host?.isConnected)return;
  const available=book?.templates.filter(item=>item.kind===kind)??[];
  if(!available.some(item=>item.id===selected))selected='';
  host.querySelector('[data-csv-template]').innerHTML=`<option value="">${loading?'正在读取模板…':loadError?'模板暂不可读，请重试':available.length?'请选择模板（选择后仍需应用）':'尚无此类型模板，完成映射后可另存'}</option>`+available.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  host.querySelector('[data-csv-template]').value=selected;updateControls();
 }
 function render(){
  if(!host?.isConnected)return;
  host.innerHTML=`<div class="ni-csv-heading"><h3>CSV 栏位映射模板</h3><span data-csv-count></span></div><p>把券商表头与投资栏位对应起来，下次导入时复用。只保存资料类型、表头和栏位规则，不保存 CSV 行内容、账户、金额或汇率数值。</p><div class="ni-csv-template-row"><label for="${prefix}-template">复用已保存模板<select id="${prefix}-template" data-csv-template></select></label><button type="button" data-csv-apply>应用所选模板</button><button type="button" data-csv-save>另存当前映射</button></div><div class="ni-csv-secondary"><span>模板只保存在当前工作区的本机，不写入 Obsidian。</span><div class="ni-actions"><button type="button" data-csv-rename>重命名模板</button><button type="button" data-csv-delete>删除模板</button><button type="button" data-csv-reload>重新读取模板</button></div></div><div class="ni-csv-issues" role="status" ${sourceError?'':'hidden'}>${esc(sourceError)}</div><div class="ni-csv-table">${fields().map(field=>`<div class="ni-csv-map-row"><label for="${prefix}-${field.id}"><span>${esc(field.label)} <small>${field.required?'必需':'可选'}</small></span><small>${field.id}</small></label><select id="${prefix}-${field.id}" data-csv-field="${field.id}" aria-label="${esc(field.label)}的 CSV 来源栏位" aria-describedby="${prefix}-sample-${field.id}" ${headers.length?'':'disabled'}><option value="">${field.required?'请选择来源栏位':'不使用（证券名称沿用 ID）'}</option>${headers.map(header=>`<option value="${esc(header)}" ${mapping[field.id]===header?'selected':''}>${esc(header)}</option>`).join('')}</select><span id="${prefix}-sample-${field.id}" class="ni-csv-sample" data-csv-sample="${field.id}">${esc(mapping[field.id]?rows[0]?.[mapping[field.id]]||'（空白）':'—')}</span></div>`).join('')}</div><p class="ni-csv-format">${kind==='snapshot'?'证券名称可不映射；现金、快照日与汇率仍需在上方明确填写。':'日期与汇率日期使用 YYYY-MM-DD；类型沿用 buy / sell / dividend / fee / deposit / withdrawal。不自动猜测类型、金额符号或汇率。'}</p><p data-csv-status role="status">${esc(message)}</p>`;
  renderTemplates();if(showRequiredErrors)for(const select of host.querySelectorAll('[data-csv-field]'))select.setAttribute('aria-invalid',String(fields().find(field=>field.id===select.dataset.csvField).required&&!select.value));
 }
 async function readBook(){
  const ticket=++loadTicket;loading=true;loadError=false;renderTemplates();
  try{
   if(!store)throw Error('unavailable');
   const value=await store.read();if(!alive||ticket!==loadTicket)return;
   book=mappingModel.validateBook(value);loadError=false;say('模板已读取；没有写入任何投资记录。');
  }catch{if(alive&&ticket===loadTicket){book=null;loadError=true;say('本机模板无法读取，原模板未被覆盖。请重新读取；仍可手动设置栏位并检查导入。');}}
  finally{if(alive&&ticket===loadTicket){loading=false;renderTemplates();}}
 }
 function update(next){
  if(next.kind===kind&&next.raw===raw)return;
  const sameKind=next.kind===kind;kind=next.kind;raw=String(next.raw??'');sourceError='';
  try{const parsed=mappingModel.parseCsv(raw);headers=parsed.headers;rows=parsed.rows;}
  catch(error){headers=[];rows=[];sourceError=raw?errorText(error.code):'先选择或粘贴 CSV，再设置来源栏位。';}
  showRequiredErrors=false;if(!sameKind){mapping={};selected='';dirty=false;}else{mapping=Object.fromEntries(fields().map(f=>[f.id,headers.includes(mapping[f.id])?mapping[f.id]:'']));}
  invalidate();closeDialog();render();
 }
 function closeDialog(){
  if(saving)return;
  action=null;
  if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}
  const oldTrigger=trigger,control=['apply','save','rename','delete'].find(name=>oldTrigger?.hasAttribute('data-csv-'+name));trigger=null;
  if(oldTrigger)queueMicrotask(()=>{if(!alive||!host?.isConnected)return;const replacement=control?host.querySelector('[data-csv-'+control+']'):null;const target=oldTrigger.isConnected&&!oldTrigger.disabled?oldTrigger:replacement&&!replacement.disabled?replacement:host.querySelector('[data-csv-template]');target?.focus();});
 }
 function apply(template){
  const checked=mappingModel.checkMapping(kind,headers,template.mapping);
  if(!checked.ok){say('模板未应用：来源栏位与当前 CSV 不匹配。原映射已保留，请核对表头。');return;}
  mapping=structuredClone(template.mapping);dirty=false;showRequiredErrors=false;invalidate();render();say('模板已应用到栏位选择；尚未检查或保存任何投资记录。');
 }
 function openDialog(operation,target=null){
  if(saving||dialog)return;
  trigger=host.ownerDocument.activeElement;action={operation,target:target?structuredClone(target):null,revision,book:book?structuredClone(book):null};
  const copy={save:['另存 CSV 映射模板','仅保存资料类型、表头和栏位规则，不保存 CSV 内容、账户、金额或汇率数值。','保存模板'],rename:['重命名模板','只修改模板名称，不改变映射或任何投资记录。','保存名称'],delete:['删除这套映射模板？','仅删除所选模板，当前栏位选择与检查结果仍保留，不会删除 CSV 或投资记录。','确认删除模板'],apply:['替换当前未保存的映射？','应用模板会替换当前栏位选择；取消可保留当前映射。确认也不会保存投资记录。','确认应用模板']}[operation];
  const node=host.ownerDocument.createElement('dialog');node.className='ni-csv-dialog';node.setAttribute('aria-labelledby',prefix+'-dialog-title');node.setAttribute('aria-describedby',prefix+'-dialog-description');
  node.innerHTML=`<form><header><h3 id="${prefix}-dialog-title" tabindex="-1">${copy[0]}</h3><button type="button" data-csv-close aria-label="关闭模板确认弹窗">关闭</button></header><div class="ni-csv-dialog-body"><p id="${prefix}-dialog-description">${copy[1]}${target?' 模板：'+esc(target.name):''}</p>${['save','rename'].includes(operation)?`<label for="${prefix}-name">模板名称<input id="${prefix}-name" name="templateName" value="${esc(operation==='rename'?target.name:'')}" autocomplete="off" required aria-describedby="${prefix}-name-help"></label><p id="${prefix}-name-help">1–30 个字符，不得重复或包含控制字符。模板最多 10 套。</p>`:''}<p role="alert" data-csv-dialog-error></p></div><footer><button type="button" data-csv-close>取消</button><button type="submit" data-csv-confirm>${copy[2]}</button></footer></form>`;
  // Sibling of the financial form: never nest forms or submit investment data
  // when Enter is used in the template-name field.
  host.closest('.native-investment').append(node);dialog=node;
  node.querySelectorAll('[data-csv-close]').forEach(button=>button.addEventListener('click',closeDialog));
  node.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  node.addEventListener('click',event=>{if(event.target!==node||saving)return;const rect=node.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDialog();});
  node.querySelector('form').addEventListener('submit',confirmDialog);
  node.showModal();(node.querySelector('input')||node.querySelector('h3')).focus();
 }
 async function confirmDialog(event){
  event.preventDefault();event.stopPropagation();const pending=action;if(!pending||saving)return;
  const report=value=>{if(dialog)dialog.querySelector('[data-csv-dialog-error]').textContent=value;};
  if(pending.revision!==revision||pending.target&&JSON.stringify(selectedTemplate())!==JSON.stringify(pending.target)){report('资料或模板已经变化，请取消后重新确认。未执行操作。');return;}
  if(pending.operation==='apply'){const target=pending.target;closeDialog();apply(target);return;}
  let next;
  try{
   if(!pending.book||!book||JSON.stringify(book)!==JSON.stringify(pending.book))throw Error('模板已改变，请重新读取后再试。');
   if(pending.operation==='save'){
    if(!valid())throw Error('请先完成必需栏位对应关系。');
    next=mappingModel.addTemplate(book,{id:globalThis.crypto.randomUUID(),name:dialog.querySelector('input').value,kind,headers:headers.slice(),mapping:structuredClone(mapping)});
   }else if(pending.operation==='rename')next=mappingModel.renameTemplate(book,pending.target.id,dialog.querySelector('input').value);
   else next=mappingModel.deleteTemplate(book,pending.target.id);
  }catch(error){report(error.code?errorText(error.code):error.message);dialog.querySelector('input')?.focus();return;}
  saving=true;dialog.querySelectorAll('button,input').forEach(input=>input.disabled=true);dialog.querySelector('[data-csv-confirm]').textContent='正在保存…';
  try{
   const saved=await store.write(pending.book,next);if(!alive)return;
   book=mappingModel.validateBook(saved);
   if(pending.operation==='save'){selected=book.templates.at(-1).id;dirty=false;}else if(pending.operation==='delete')selected='';
   revision++;saving=false;closeDialog();renderTemplates();say('模板已保存到当前工作区的本机；没有修改或导入投资记录。');
  }catch{if(alive){saving=false;dialog?.querySelectorAll('button,input').forEach(input=>input.disabled=false);if(dialog)dialog.querySelector('[data-csv-confirm]').textContent='重试保存';report('模板保存失败或已在其他窗口更新，原模板与投资资料未被覆盖。请取消后重新读取模板再试。');}}
 }
 function click(event){
  const button=event.target.closest('button');if(!button||saving)return;
  if(button.hasAttribute('data-csv-reload')){void readBook();return;}
  const target=selectedTemplate();
  if(button.hasAttribute('data-csv-save')&&book&&valid())openDialog('save');
  else if(button.hasAttribute('data-csv-apply')&&target){if(!mappingModel.checkMapping(kind,headers,target.mapping).ok){say('模板未应用：来源栏位不匹配，原映射已保留。');return;}if(dirty)openDialog('apply',target);else apply(target);}
  else if(button.hasAttribute('data-csv-rename')&&target)openDialog('rename',target);
  else if(button.hasAttribute('data-csv-delete')&&target)openDialog('delete',target);
 }
 function change(event){
  if(event.target.matches('[data-csv-template]')){selected=event.target.value;updateControls();say('已选择模板，尚未应用；当前映射没有改变。');return;}
  const id=event.target.dataset.csvField;if(!id)return;
  mapping[id]=event.target.value;event.target.setAttribute('aria-invalid',String(fields().find(f=>f.id===id).required&&!event.target.value));
  host.querySelector('[data-csv-sample="'+id+'"]').textContent=mapping[id]?rows[0]?.[mapping[id]]||'（空白）':'—';dirty=true;invalidate();updateControls();say('映射已更改，请重新检查导入资料。');
 }
 function unmount(){
  if(dialog){dialog.close();dialog.remove();dialog=null;action=null;}
  if(host){host.removeEventListener('click',click);host.removeEventListener('change',change);}host=null;
 }
 return{
  mount(target,source){unmount();host=target;host.classList.add('ni-csv');host.addEventListener('click',click);host.addEventListener('change',change);update(source);render();if(!book&&!loading)void readBook();},
  update,
  canonicalCsv(nextKind,nextRaw){update({kind:nextKind,raw:nextRaw});const result=mappingModel.validateMapped(kind,raw,mapping);showRequiredErrors=!result.ok;if(!result.ok){for(const select of host?.querySelectorAll('[data-csv-field]')??[])select.setAttribute('aria-invalid',String(fields().find(f=>f.id===select.dataset.csvField).required&&!select.value));throw Error(result.errors.map(errorText).join('；'));}return result.csv;},
  unmount,
  destroy(){alive=false;loadTicket++;unmount();},
 };
}
module.exports={createCsvMappingUi};
