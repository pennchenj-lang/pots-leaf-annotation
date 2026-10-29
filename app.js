'use strict';
const $=id=>document.getElementById(id), NS='http://www.w3.org/2000/svg';
const COLORS=['#137b70','#a44cc0','#bd6e11','#3877c3','#cc4f64','#648426','#7560b3','#b25e34'];
const clone=x=>JSON.parse(JSON.stringify(x));
let manifest,state,manifestHash,groupId,current,selectedLeaf='L1',tool='anchor',filter='all';
let db,stateKey,directoryHandle=null,directoryReady=false,testMode=false;
let autosaveTimer=null,saveQueue=Promise.resolve(),busy=false,conflicted=false,space=false,toastTimer;
const revisions={},generation={},savedGeneration={},viewports={};
let history=[];
function openDatabase(){return new Promise((resolve,reject)=>{const r=indexedDB.open('pots-remote-leaf-review-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('浏览器无法保存数据，请使用普通窗口并允许网站存储。'));r.onblocked=()=>reject(new Error('请关闭其他旧标注标签页后刷新。'));});}
function dbGet(key){return new Promise((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function dbPut(key,value){return new Promise((resolve,reject)=>{const t=db.transaction('records','readwrite');t.objectStore('records').put(value,key);t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('浏览器保存中断'));});}
function newState(){const t=new Date().toISOString();return {schema:'same-leaf-annotations-v1',data_type:testMode?'synthetic_ui_test':'user_leaf_identity_annotations',origin:'remote_browser_annotation',manifest_sha256:manifestHash,review_device_id:crypto.randomUUID(),created_at:t,updated_at:t,current_group_id:'G15',groups:{}};}
function commitAnnotation(gid,annotation,nextGroup,expected){return new Promise((resolve,reject)=>{
 const t=db.transaction('records','readwrite'),store=t.objectStore('records'),r=store.get(stateKey);let result,error;
 r.onsuccess=()=>{const latest=r.result||state;
  if((latest.groups[gid]?.revision??null)!==expected){conflicted=true;error=new Error('另一标签页已更新此组。请下载冲突草稿备份，再刷新继续。');t.abort();return;}
  result={...latest,groups:{...latest.groups,[gid]:annotation},current_group_id:nextGroup,updated_at:new Date().toISOString()};store.put(result,stateKey);
 };
 t.oncomplete=()=>resolve(result);t.onerror=()=>reject(error||t.error||new Error('浏览器保存失败，请下载标注文件保留进度。'));t.onabort=()=>reject(error||t.error||new Error('浏览器保存失败，请下载标注文件保留进度。'));
});}
function commitImport(imported,nextGroup){return new Promise((resolve,reject)=>{
 const t=db.transaction('records','readwrite'),store=t.objectStore('records'),r=store.get(stateKey);let result,error;
 r.onsuccess=()=>{const latest=r.result||state;
  for(const [gid,a]of Object.entries(imported))if(hasMeaningfulAnnotation(latest.groups[gid])&&JSON.stringify(cleanAnnotation(latest.groups[gid]))!==JSON.stringify(cleanAnnotation(a))){error=new Error(gid+' 在另一标签页中已有不同标注，导入已停止，原数据保留。');t.abort();return;}
  result={...latest,groups:{...latest.groups,...imported},current_group_id:nextGroup,updated_at:new Date().toISOString()};store.put(result,stateKey);
 };
 t.oncomplete=()=>resolve(result);t.onerror=()=>reject(error||t.error);t.onabort=()=>reject(error||t.error||new Error('导入保存中断，原数据保留'));
});}
function hasMeaningfulAnnotation(a){return !!a&&(a.status!=='draft'||!!a.note?.trim()||a.leaves?.some(l=>Object.values(l.views||{}).some(v=>v.anchor||v.outline?.length||Object.keys(v.keypoints||{}).length||['visible','partial','not_visible'].includes(v.visibility))));}
function sourceBindings(g){return g.views.map(v=>({view_id:v.id,original_sha256:v.sha256,display_sha256:v.display_sha256||v.sha256,width:v.width,height:v.height,display_to_original_3x3:v.display_to_original_3x3}));}
function validateAnnotation(gid,a){
 const g=manifest.groups.find(g=>g.id===gid);if(!g||!a||typeof a!=='object')throw new Error('无效组号或标注');
 if(!['draft','completed','skipped'].includes(a.status)||!Array.isArray(a.leaves)||a.leaves.length>40)throw new Error('标注状态或叶片数量无效');
 const seen=new Set(),views=Object.fromEntries(g.views.map(v=>[v.id,v]));
 const xy=(p,v)=>{if(p==null)return null;if(!Array.isArray(p)||p.length!==2||p.some(x=>typeof x!=='number'||!Number.isFinite(x))||p[0]<0||p[1]<0||p[0]>v.width-1||p[1]>v.height-1)throw new Error('点位超出照片范围或坐标无效');return [...p];};
 const leaves=a.leaves.map(l=>{
  if(!l||!/^L[1-9]\d{0,2}$/.test(l.id)||seen.has(l.id))throw new Error('叶片编号无效或重复');seen.add(l.id);
  const raw=l.views||{};if(typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!views[k]))throw new Error('标注中有未知照片');
  let matched=0;const checked={};for(const [vid,v]of Object.entries(views)){
   const x=raw[vid]||{},visibility=x.visibility||'uncertain';if(!['visible','partial','not_visible','uncertain'].includes(visibility))throw new Error('可见性状态无效');
   const anchor=xy(x.anchor,v),line=x.outline||[],points=x.keypoints||{};
   if(!Array.isArray(line)||line.length>2000||typeof points!=='object'||Array.isArray(points)||Object.keys(points).some(k=>!['T','B'].includes(k)))throw new Error('叶缘或关键点格式无效');
   const outline=line.map(p=>{const q=xy(p,v);if(!q)throw new Error('叶缘不能包含空点');return q;}),keypoints={};for(const [key,p]of Object.entries(points))if(p!=null)keypoints[key]=xy(p,v);
   if(['not_visible','uncertain'].includes(visibility)&&(anchor||outline.length||Object.keys(keypoints).length))throw new Error('不可见或无法确认的叶片不能保留点位，请先修改状态或清除点位');
   if(['visible','partial'].includes(visibility)&&anchor)matched++;
   checked[vid]={visibility,anchor,outline,outline_closed:false,keypoints,keypoints_position_reviewed:false,anchor_role:'leaf_identity_locator_not_material_correspondence'};
  }
  if(a.status==='completed'&&matched<2)throw new Error(`${l.id} 至少需要两张照片中的身份定位`);
  return {id:l.id,views:checked};
 });
 if(a.status==='completed'&&(!leaves.length||a.confirmed_same_leaf!==true))throw new Error('请确认同一叶片后完成本组');
 if(typeof a.note!=='string'||a.note.length>4000)throw new Error('备注最多 4000 字');
 return {status:a.status,leaves,note:a.note,confirmed_same_leaf:a.status==='completed'&&a.confirmed_same_leaf===true,coordinate_system:'EXIF-oriented native image pixels, x right/y down',source_images:sourceBindings(g)};
}
function exportData(){return {...clone(state),annotation_scope:{allowed_group_ids:manifest.groups.map(g=>g.id),first_group_id:'G15'},exported_at:new Date().toISOString()};}
function exportFilename(){return 'POTS_同叶标注_'+state.review_device_id+'.json';}
function downloadObject(value,name=exportFilename()){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function directoryStatus(text,kind=''){const el=$('directoryStatus');el.textContent=text;el.className=kind;}
async function writeDirectory(){
 if(!directoryHandle)return false;
 try{
  if(await directoryHandle.queryPermission({mode:'readwrite'})!=='granted'){directoryReady=false;$('resumeDirectory').hidden=false;directoryStatus('文件夹授权尚未恢复：当前进度只保存在浏览器。点击“恢复文件夹授权”或下载标注文件。','saving');return false;}
  directoryReady=true;const handle=await directoryHandle.getFileHandle(exportFilename(),{create:true}),stream=await handle.createWritable();
  try{await stream.write(JSON.stringify(exportData(),null,2));await stream.close();}catch(e){try{await stream.abort();}catch(_){}throw e;}
  $('resumeDirectory').hidden=true;directoryStatus(`自动保存已开启：${directoryHandle.name} / ${exportFilename()} · ${new Date().toLocaleTimeString('zh-CN')}`,'saved');return true;
 }catch(e){directoryReady=false;directoryStatus('文件夹写入失败：浏览器内进度仍在，请下载标注文件，或重新选择可写文件夹。','error');return false;}
}
function blank(){return {status:'draft',leaves:[{id:'L1',views:{}}],note:'',confirmed_same_leaf:false};}
function cleanAnnotation(a){return {status:a.status||'draft',leaves:clone(a.leaves||[]),note:a.note||'',confirmed_same_leaf:!!a.confirmed_same_leaf};}
function group(){return manifest.groups.find(g=>g.id===groupId);}
function leaf(){return current.leaves.find(l=>l.id===selectedLeaf);}
function matchesFilter(g,scope){return scope==='all'||g.source===scope;}
function filteredGroups(){return manifest.groups.filter(g=>matchesFilter(g,filter));}
function color(id){const n=Number(id.replace(/\D/g,''))||1;return COLORS[(n-1)%COLORS.length];}
function leafName(id){return '叶 '+id.replace(/^L/,'');}
function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function statusText(text,kind=''){const el=$('saveStatus');el.textContent=text;el.className=kind;}
function completionIssues(annotation=current){
 const problems=[];
 if(!annotation.leaves.length)problems.push('请先添加并标注至少一片叶子');
 for(const l of annotation.leaves){
   const vs=Object.values(l.views||{}), n=vs.filter(v=>['visible','partial'].includes(v.visibility)&&Array.isArray(v.anchor)&&v.anchor.length===2).length;
   if(n<2)problems.push(`${leafName(l.id)}还需要在${2-n}张照片中定位`);
   if(vs.some(v=>['not_visible','uncertain'].includes(v.visibility)&&v.anchor))problems.push(`${leafName(l.id)}有未确认状态的定位点`);
 }
 return problems;
}
function pushHistory(){history.push(clone(current));if(history.length>80)history.shift();}
function changed(fn,{clearConfirm=true,rerender=true}={}){
 if(busy||conflicted)return;
 pushHistory();fn();current.status='draft';if(clearConfirm)current.confirmed_same_leaf=false;
 generation[groupId]=(generation[groupId]||0)+1;
 statusText('尚有修改，正在自动保存…','saving');
 if(rerender)render();else renderReviewStatus();
 clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>persist().catch(()=>{}),700);
}
async function persist({annotation=clone(current),nextGroup=groupId}={}){
 clearTimeout(autosaveTimer);autosaveTimer=null;
 if(conflicted)throw new Error('此组在另一个页面已修改，请刷新后继续。');
 const gid=groupId,snapshot=cleanAnnotation(annotation),version=generation[gid]||0;
 const job=async()=>{
   if(conflicted)throw new Error('保存冲突，请刷新页面。');
   if(gid===groupId)statusText('正在保存到当前浏览器…','saving');
   const checked=validateAnnotation(gid,snapshot), savedAt=new Date().toISOString(),revision=savedAt+'_'+crypto.randomUUID();
   checked.saved_at=savedAt;checked.revision=revision;
   state=await commitAnnotation(gid,checked,nextGroup,revisions[gid]??null);
   revisions[gid]=revision;savedGeneration[gid]=version;
   const diskSaved=await writeDirectory();
   if(gid===groupId&&version===(generation[gid]||0)){
     statusText((diskSaved?'已保存到所选文件夹':'已保存到当前浏览器')+' · '+new Date(savedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),'saved');
   }
   renderProgress();return {ok:true,revision,saved_at:savedAt,annotation:checked};
 };
 const task=saveQueue.catch(()=>{}).then(job);saveQueue=task;
 return task.catch(e=>{statusText(e.message,'error');toast(e.message);renderBusy();throw e;});
}
function renderBusy(){
 $('backup').textContent=conflicted?'下载冲突草稿备份':'下载标注文件';
 document.querySelectorAll('button,select,textarea,#confirm').forEach(el=>el.disabled=busy||conflicted);
 if(!busy&&!conflicted){$('undo').disabled=!history.length;$('deleteLeaf').disabled=!leaf();
 const gs=filteredGroups(),i=gs.findIndex(g=>g.id===groupId);$('previous').disabled=i<=0;}
}
function renderProgress(){
 if(!manifest)return;const groups=manifest.groups;
 const statusOf=g=>g.id===groupId?current.status:state.groups[g.id]?.status;
 const done=groups.filter(g=>statusOf(g)==='completed').length,skip=groups.filter(g=>statusOf(g)==='skipped').length;
 $('progress').textContent=`已完成 ${done} / ${groups.length} 组 · 暂时跳过 ${skip} 组`;
}
function renderReviewStatus(){
 $('confirm').checked=!!current.confirmed_same_leaf;
 const issues=completionIssues();
 $('completionHint').textContent=issues.length?issues.join('；'):'定位已齐全。核对对应关系后，勾选确认即可进入下一组。';
 renderProgress();
}
function chooseGroup(id){
 groupId=id;current=cleanAnnotation(state.groups[id]||blank());
 revisions[id]=state.groups[id]?.revision??null;
 selectedLeaf=current.leaves[0]?.id||null;history=[];tool='anchor';
 generation[id]=generation[id]||0;savedGeneration[id]=generation[id];
 statusText(state.groups[id]?'已恢复当前浏览器保存的标注':'这组尚未标注',state.groups[id]?'saved':'');
 location.hash=id;render();
}
async function navigate(id,{complete=false,skip=false}={}){
 if(busy||conflicted||!id)return false;
 if(complete){
   const issues=completionIssues();if(issues.length){toast(issues.join('；'));return false;}
   if(!current.confirmed_same_leaf){toast('请核对相同编号，并勾选同叶确认。');$('confirm').focus();return false;}
 }
 busy=true;renderBusy();clearTimeout(autosaveTimer);
 try{
   const outgoing=clone(current);
   if(complete)outgoing.status='completed';
   if(skip){outgoing.status='skipped';outgoing.confirmed_same_leaf=false;}
   await persist({annotation:outgoing,nextGroup:id});
   if(id!==groupId)chooseGroup(id);else{current=cleanAnnotation(state.groups[groupId]);render();toast(complete?'本组已保存完成。':skip?'已保留当前标记，并暂时跳过。':'已保存。');}
   return true;
 }catch(e){return false;}finally{busy=false;renderBusy();}
}
function nextId(){const gs=filteredGroups(),i=gs.findIndex(g=>g.id===groupId);return gs[i+1]?.id||groupId;}
function render(){
 const g=group(),gs=filteredGroups();
 PotsCloudAssets.activate(g.id);
 $('groupTitle').textContent=(g.label||g.id)+' · '+g.id;
 $('groupMeta').textContent=`${g.views.length} 张照片 · ${current.status==='completed'?'已完成，可继续修改':current.status==='skipped'?'已暂时跳过':'待核对'}`;
 $('groupJump').replaceChildren(...gs.map(item=>{const opt=document.createElement('option');opt.value=item.id;opt.textContent=(item.label||item.id)+(item.label&&item.label!==item.id?' · '+item.id:'');opt.selected=item.id===groupId;return opt;}));
 $('sourceFilter').value=filter;
 $('leafTabs').replaceChildren(...current.leaves.map(l=>{
   const b=document.createElement('button');b.type='button';b.className='leafbutton'+(l.id===selectedLeaf?' active':'');b.textContent=leafName(l.id);
   b.style.setProperty('--leaf-color',color(l.id));b.style.setProperty('--leaf-soft',color(l.id)+'18');b.setAttribute('aria-pressed',String(l.id===selectedLeaf));
   b.onclick=()=>{selectedLeaf=l.id;render();};return b;
 }));
 document.querySelectorAll('[data-tool]').forEach(b=>{b.classList.toggle('active',b.dataset.tool===tool);b.setAttribute('aria-pressed',String(b.dataset.tool===tool));});
 const instructions={anchor:'点击同一片叶子的可见部分即可。编号相同表示同一片叶，不要求点在叶子的同一物理位置。',
 T:'当前标叶尖 T：只点真实可见的叶尖。身份定位仍需另用“同叶定位”各点一次。',
 B:'当前标叶基 B：只点真实可见的叶身与叶柄连接处。不要猜遮挡位置。',
 outline:'当前描可见叶缘：沿一段连续可见叶缘依次点选，遇遮挡就停止。线段保持开放，不自动补缺口。',
 pan:'当前只移动图片：滚轮缩放，拖动移动；不会新增标记。'};
 $('instruction').textContent=instructions[tool];
 $('views').className='views'+(g.views.length===2?' two':'');$('views').replaceChildren(...g.views.map(makeView));
 $('note').value=current.note;renderReviewStatus();renderBusy();
 $('next').textContent=nextId()===groupId?'保存并完成本组 ✓':'保存并下一组 →';
}
function elem(name,attrs={}){const el=document.createElementNS(NS,name);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);return el;}
function getViewport(view){const key=groupId+'/'+view.id;return viewports[key]||(viewports[key]={x:0,y:0,w:view.width,h:view.height});}
function clampViewport(vp,view){vp.w=Math.max(view.width/12,Math.min(view.width,vp.w));vp.h=vp.w*view.height/view.width;vp.x=Math.max(0,Math.min(view.width-vp.w,vp.x));vp.y=Math.max(0,Math.min(view.height-vp.h,vp.y));}
function makeView(view,index){
 const card=document.createElement('article');card.className='viewcard';card.dataset.viewId=view.id;
 const heading=document.createElement('div');heading.className='viewheading';
 const name=document.createElement('strong');name.textContent='照片 '+(index+1)+(view.source_view_id?' · '+view.source_view_id:'');heading.append(name);
 const zooms=document.createElement('div');zooms.className='zoomtools';
 const minus=document.createElement('button'),plus=document.createElement('button'),reset=document.createElement('button');
 minus.textContent='−';minus.title='缩小';plus.textContent='＋';plus.title='放大';reset.textContent='全图';reset.title='复位到完整照片';zooms.append(minus,plus,reset);heading.append(zooms);card.append(heading);
 const area=document.createElement('div');area.className='canvas';
 const svg=elem('svg',{viewBox:`0 0 ${view.width} ${view.height}`,preserveAspectRatio:'xMidYMid meet',role:'img','aria-label':`${groupId} 照片 ${index+1}，点击标注${selectedLeaf?leafName(selectedLeaf):'叶片'}`});
 svg.classList.toggle('pan',tool==='pan');
 const imageGroup=groupId;
 let imageReady=false;
 const img=elem('image',{x:0,y:0,width:view.width,height:view.height,preserveAspectRatio:'none'});
 const loadCover=document.createElement('div');loadCover.className='image-loading';
 const loadText=document.createElement('span');loadText.textContent='正在从云端读取照片…';loadCover.append(loadText);
 const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载照片';retry.hidden=true;loadCover.append(retry);
 async function loadImage(force=false){
  imageReady=false;card.dataset.imageReady='false';loadCover.hidden=false;retry.hidden=true;loadText.textContent='正在从云端读取照片…';
  try{const url=await PotsCloudAssets.image(imageGroup,view,{retry:force});if(!card.isConnected)return;img.setAttribute('href',url);}
  catch(e){if(e.name==='AbortError'||!card.isConnected)return;loadText.textContent=e.message||'照片暂时无法加载，已有标注保留。';retry.hidden=false;}
 }
 retry.onclick=()=>loadImage(true);
 img.addEventListener('load',()=>{imageReady=true;card.dataset.imageReady='true';loadCover.hidden=true;});
 img.addEventListener('error',()=>{imageReady=false;card.dataset.imageReady='false';loadCover.hidden=false;loadText.textContent='照片显示失败，已有标注保留。';retry.hidden=false;});
 svg.append(img);const marks=elem('g');svg.append(marks);area.append(svg);card.append(area);
 area.append(loadCover);requestAnimationFrame(()=>loadImage());
 const bottom=document.createElement('div');bottom.className='viewbottom';
 const visibilityLabel=document.createElement('label');visibilityLabel.className='visibility';visibilityLabel.append(document.createTextNode((selectedLeaf?leafName(selectedLeaf):'当前叶')+'在这张图中'));
 const select=document.createElement('select');select.setAttribute('aria-label',`照片 ${index+1} 中的叶片可见状态`);
 for(const [value,text]of [['','待标注'],['visible','看得清'],['partial','有遮挡，但能确定'],['not_visible','未显示 / 被完全挡住'],['uncertain','无法确定是不是这片叶']]){const o=document.createElement('option');o.value=value;o.textContent=text;select.append(o);}
 select.value=leaf()?.views[view.id]?.visibility||'';visibilityLabel.append(select);bottom.append(visibilityLabel);
 select.onchange=()=>{
   if(!leaf()){toast('请先添加一片叶。');render();return;}
   const value=select.value;
   changed(()=>{if(!value){delete leaf().views[view.id];return;}
     const data=leaf().views[view.id]||(leaf().views[view.id]={anchor:null,outline:[],keypoints:{}});data.visibility=value;
     if(['not_visible','uncertain'].includes(value)){data.anchor=null;data.outline=[];data.keypoints={};}
   });
 };
 const status=document.createElement('div');status.className='viewstatus';
 const obs=leaf()?.views[view.id];status.textContent=obs?.anchor?`${leafName(selectedLeaf)}已定位${obs.visibility==='partial'?' · 有遮挡':''}`:obs?.visibility==='not_visible'?'已记录：本图未显示':obs?.visibility==='uncertain'?'已记录：对应关系不确定':'尚未点击身份定位点';bottom.append(status);
 const clears=document.createElement('div');clears.className='viewclear';
 for(const [label,key]of [['清除此图当前叶','all'],['清除叶缘','outline'],['清除 T / B','keypoints']]){
   const b=document.createElement('button');b.textContent=label;b.type='button';b.className='subtle';
   b.onclick=()=>{if(!leaf()||!leaf().views[view.id])return;changed(()=>{if(key==='all')delete leaf().views[view.id];else leaf().views[view.id][key]=key==='outline'?[]:{};});};clears.append(b);
 }
 bottom.append(clears);const hint=document.createElement('p');hint.className='viewhelp';hint.textContent='滚轮缩放 · 拖动移动 · 空格键只移动 · 可撤销';bottom.append(hint);card.append(bottom);
 const vp=getViewport(view);
 function applyViewport(){clampViewport(vp,view);svg.setAttribute('viewBox',`${vp.x} ${vp.y} ${vp.w} ${vp.h}`);draw();}
 function coordinate(e,matrix){const p=new DOMPoint(e.clientX,e.clientY);return p.matrixTransform(matrix||svg.getScreenCTM().inverse());}
 function zoom(factor,center){const p=center||{x:vp.x+vp.w/2,y:vp.y+vp.h/2};const newW=Math.max(view.width/12,Math.min(view.width,vp.w*factor)),s=newW/vp.w;vp.x=p.x-(p.x-vp.x)*s;vp.y=p.y-(p.y-vp.y)*s;vp.w=newW;vp.h*=s;applyViewport();}
 function draw(){
   marks.replaceChildren();const rect=svg.getBoundingClientRect();
   const scale=Math.min((rect.width||450)/vp.w,(rect.height||500)/vp.h),unit=1/scale;
   for(const l of current.leaves){const data=l.views[view.id];if(!data)continue;const col=color(l.id),active=l.id===selectedLeaf;
     if(Array.isArray(data.outline)&&data.outline.length){const pts=data.outline.map(p=>p.join(',')).join(' ');marks.append(elem('polyline',{points:pts,stroke:col,class:'svg-outline',opacity:active?1:.65}));for(const p of data.outline)marks.append(elem('circle',{cx:p[0],cy:p[1],r:2.8*unit,fill:col}));}
     const points=[];if(data.anchor)points.push([data.anchor,l.id]);for(const k of ['T','B'])if(data.keypoints?.[k])points.push([data.keypoints[k],l.id+'·'+k]);
     for(const [p,label] of points){marks.append(elem('circle',{cx:p[0],cy:p[1],r:(active?7:5)*unit,fill:col,class:'svgpoint',opacity:active?1:.75}));const t=elem('text',{x:p[0]+10*unit,y:p[1]-10*unit,fill:col,'font-size':16*unit,class:'point-label','stroke-width':3*unit});t.textContent=label;marks.append(t);}
   }
 }
 minus.onclick=()=>zoom(1.4);plus.onclick=()=>zoom(1/1.4);reset.onclick=()=>{Object.assign(vp,{x:0,y:0,w:view.width,h:view.height});applyViewport();};
 svg.addEventListener('wheel',e=>{e.preventDefault();if(busy)return;zoom(e.deltaY<0?1/1.2:1.2,coordinate(e));},{passive:false});
 let drag=null;
 svg.addEventListener('pointerdown',e=>{
   if(busy||conflicted||![0,1].includes(e.button))return;
   if(!imageReady){toast('请等照片加载完成后再标注。');return;}
   e.preventDefault();svg.setPointerCapture(e.pointerId);
   drag={pointer:e.pointerId,x:e.clientX,y:e.clientY,vx:vp.x,vy:vp.y,inverse:svg.getScreenCTM().inverse(),moved:false,pan:tool==='pan'||space||e.button===1};
 });
 svg.addEventListener('pointermove',e=>{
   if(!drag||drag.pointer!==e.pointerId)return;
   if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>6)drag.moved=true;
   if(drag.moved){const a=new DOMPoint(drag.x,drag.y).matrixTransform(drag.inverse),b=coordinate(e,drag.inverse);vp.x=drag.vx-(b.x-a.x);vp.y=drag.vy-(b.y-a.y);svg.classList.add('dragging');applyViewport();}
 });
 svg.addEventListener('pointerup',e=>{
   if(!drag||drag.pointer!==e.pointerId)return;const action=drag;drag=null;svg.classList.remove('dragging');
   if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);
   if(action.moved||action.pan||busy||conflicted)return;
   if(!leaf()){toast('请先点击“再标一片叶”。');return;}
   const p=coordinate(e);if(p.x<0||p.y<0||p.x>=view.width||p.y>=view.height)return;
   const xy=[Math.min(view.width-1,Math.round(p.x*1000)/1000),Math.min(view.height-1,Math.round(p.y*1000)/1000)];
   changed(()=>{let data=leaf().views[view.id];if(!data)data=leaf().views[view.id]={visibility:'visible',anchor:null,outline:[],keypoints:{}};
     if(!['visible','partial'].includes(data.visibility))data.visibility='visible';
     if(tool==='anchor')data.anchor=xy;
     else if(tool==='outline'){data.outline=data.outline||[];data.outline.push(xy);}
     else if(['B','T'].includes(tool)){data.keypoints=data.keypoints||{};data.keypoints[tool]=xy;}
   });
 });
 svg.addEventListener('pointercancel',()=>{drag=null;svg.classList.remove('dragging');});
 requestAnimationFrame(applyViewport);return card;
}
function undo(){if(!history.length||busy||conflicted)return;current=history.pop();current.status='draft';current.confirmed_same_leaf=false;
 if(!current.leaves.some(l=>l.id===selectedLeaf))selectedLeaf=current.leaves[0]?.id||null;
 generation[groupId]=(generation[groupId]||0)+1;render();statusText('已撤销，正在保存…','saving');clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>persist().catch(()=>{}),700);
}
$('undo').onclick=undo;
$('addLeaf').onclick=()=>changed(()=>{const n=Math.max(0,...current.leaves.map(l=>Number(l.id.replace(/^L/,''))||0))+1;selectedLeaf='L'+n;current.leaves.push({id:selectedLeaf,views:{}});});
$('deleteLeaf').onclick=()=>{if(!leaf())return;const name=leafName(selectedLeaf);changed(()=>{current.leaves=current.leaves.filter(l=>l.id!==selectedLeaf);selectedLeaf=current.leaves[0]?.id||null;});toast(name+'已删除，可点击撤销恢复。');};
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{tool=b.dataset.tool;render();});
$('confirm').onchange=()=>{const checked=$('confirm').checked;changed(()=>current.confirmed_same_leaf=checked,{clearConfirm:false,rerender:false});};
$('note').oninput=()=>{const value=$('note').value;changed(()=>current.note=value,{rerender:false});};
$('backup').onclick=async e=>{
 e.preventDefault();if(!current||busy)return;
 busy=true;renderBusy();let notSaved=conflicted;
 try{
  if(!conflicted){try{await persist();}catch(err){notSaved=true;}}
  const exported=exportData();
  if(notSaved)exported.unsaved_local_recovery={status:conflicted?'draft_conflict':'draft_unsaved',group_id:groupId,current_group_id:groupId,source:group().source,manifest_sha256:manifestHash,annotation:cleanAnnotation(current),based_on_revision:revisions[groupId]??null,requires_reconciliation:true};
  downloadObject(exported);
  toast(notSaved?'已下载文件，另含当前未保存草稿；这些草稿需要核对后合并。':'已下载标注文件。完成后把这份 JSON 发给研究者即可。');
 }finally{busy=false;renderBusy();}
};
$('chooseDirectory').onclick=async()=>{
 if(!window.showDirectoryPicker){toast('这个浏览器不支持选择保存文件夹，请使用“下载标注文件”。');return;}
 try{
  const handle=await window.showDirectoryPicker({id:'pots-leaf-review',mode:'readwrite',startIn:'desktop'});
  directoryHandle=handle;
  try{await dbPut(stateKey+':directory',handle);}catch(e){toast('目录句柄暂不能记住；本次仍可保存，刷新后需重新选择文件夹。');}
  await persist();
 }catch(e){if(e.name!=='AbortError')toast('未能连接保存文件夹，请重试或下载标注文件。');}
};
$('resumeDirectory').onclick=async()=>{
 if(!directoryHandle)return;
 try{const permission=await directoryHandle.requestPermission({mode:'readwrite'});if(permission==='granted')await persist();else directoryStatus('尚未获得写入授权：请下载标注文件保留进度。','saving');}catch(e){toast('文件夹授权未恢复，请重新选择文件夹。');}
};
$('importBackup').onclick=()=>$('importFile').click();
$('importFile').onchange=async()=>{
 const file=$('importFile').files[0];$('importFile').value='';if(!file||busy||conflicted)return;
 busy=true;renderBusy();
 try{
  if(file.size>20000000)throw new Error('文件过大，请选择本页面导出的 JSON 文件');
  const incoming=JSON.parse(await file.text());
  if(incoming.schema!=='same-leaf-annotations-v1'||incoming.manifest_sha256!==manifestHash||incoming.data_type!==state.data_type||incoming.unsaved_local_recovery)throw new Error('文件来源、照片清单或数据类型不符，或含待合并草稿，暂不能导入');
  if(!incoming.groups||typeof incoming.groups!=='object'||Array.isArray(incoming.groups))throw new Error('标注文件格式不正确');
  const imported={};for(const [gid,a]of Object.entries(incoming.groups)){
   const checked=validateAnnotation(gid,a),expected=sourceBindings(manifest.groups.find(g=>g.id===gid));
   if(!Array.isArray(a.source_images)||a.source_images.length!==expected.length)throw new Error('标注缺少照片来源绑定');
   for(const e of expected){const old=a.source_images.find(x=>x.view_id===e.view_id);if(!old||Object.keys(e).some(k=>JSON.stringify(old[k])!==JSON.stringify(e[k])))throw new Error('照片来源或原始尺寸不一致');}
   if(hasMeaningfulAnnotation(state.groups[gid])&&JSON.stringify(cleanAnnotation(state.groups[gid]))!==JSON.stringify(cleanAnnotation(checked)))throw new Error(gid+' 已有不同标注。为避免覆盖，请先保留现有文件，使用另一浏览器导入核对。');
   imported[gid]={...checked,saved_at:new Date().toISOString(),revision:'import_'+crypto.randomUUID()};
  }
  if((generation[groupId]||0)!==(savedGeneration[groupId]||0))throw new Error('当前页有未保存修改，请先暂存或下载再导入');
  const next=manifest.groups.some(g=>g.id===incoming.current_group_id)?incoming.current_group_id:'G15';
  state=await commitImport(imported,next);for(const [id,a]of Object.entries(state.groups))revisions[id]=a.revision;
  filter='all';chooseGroup(next);await writeDirectory();toast('已导入 '+Object.keys(imported).length+' 组标注，后续修改会继续保存。');
 }catch(e){toast(e.message||'未能导入标注文件');}finally{busy=false;renderBusy();}
};
$('saveDraft').onclick=async()=>{if(busy)return;busy=true;renderBusy();try{await persist();toast('本组已保存，可以稍后继续。');}catch(e){}finally{busy=false;renderBusy();}};
$('next').onclick=()=>navigate(nextId(),{complete:true});
$('skip').onclick=()=>navigate(nextId(),{skip:true});
$('previous').onclick=()=>{const gs=filteredGroups(),i=gs.findIndex(g=>g.id===groupId);if(i>0)navigate(gs[i-1].id);};
$('groupJump').onchange=()=>{const destination=$('groupJump').value;$('groupJump').value=groupId;navigate(destination);};
$('sourceFilter').onchange=async()=>{
 const nextFilter=$('sourceFilter').value;$('sourceFilter').value=filter;
 if(busy||conflicted)return;busy=true;renderBusy();
 try{
   const filtered=manifest.groups.filter(g=>matchesFilter(g,nextFilter));
   if(!filtered.length){toast('这个范围中没有照片。');return;}
   const next=filtered.some(g=>g.id===groupId)?groupId:filtered[0].id;
   await persist({nextGroup:next});filter=nextFilter;chooseGroup(next);
 }catch(e){}finally{busy=false;renderBusy();}
};
window.addEventListener('keydown',e=>{
 if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}
 if(e.code==='Space'){e.preventDefault();space=true;document.querySelectorAll('svg').forEach(s=>s.classList.add('pan'));}
});
window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;document.querySelectorAll('svg').forEach(s=>s.classList.toggle('pan',tool==='pan'));}});
window.addEventListener('blur',()=>space=false);
window.addEventListener('beforeunload',e=>{if(groupId&&(generation[groupId]||0)!==(savedGeneration[groupId]||0)){e.preventDefault();e.returnValue='';}});
async function boot(b){
 try{
  manifest=b.manifest;manifestHash=b.manifest_sha256||b.annotation_scope?.canonical_manifest_sha256;testMode=b.test_mode===true;
  if(!manifest?.groups?.length||!manifestHash)throw new Error('尚未找到可标注的照片组');
  const permitted=b.annotation_scope?.allowed_group_ids||manifest.groups.filter(g=>(/^G\d+$/.test(g.id)&&Number(g.id.slice(1))>=15)||/^P\d+$/.test(g.id)).map(g=>g.id);
  manifest={...manifest,groups:manifest.groups.filter(g=>permitted.includes(g.id))};
  if(!manifest.groups.length)throw new Error('没有在当前任务范围内的照片');
  $('sourceFilter').querySelector('[value="all"]').textContent='全部 '+manifest.groups.length+' 组';
  db=await openDatabase();stateKey='state:'+manifestHash+':from-G15:'+(testMode?'test':'review');state=await dbGet(stateKey);
  if(!state){state=newState();await dbPut(stateKey,state);}
  if(state.manifest_sha256!==manifestHash||state.data_type!==(testMode?'synthetic_ui_test':'user_leaf_identity_annotations'))throw new Error('已存数据与当前任务不符，请保留备份并联系研究者');
  for(const [id,a]of Object.entries(state.groups))revisions[id]=a.revision;
  directoryHandle=await dbGet(stateKey+':directory');
  if(directoryHandle){try{directoryReady=await directoryHandle.queryPermission({mode:'readwrite'})==='granted';}catch(e){directoryReady=false;}
   if(directoryReady)directoryStatus('已连接上次所选文件夹：'+directoryHandle.name+'。下次修改将自动更新文件。','saved');
   else{$('resumeDirectory').hidden=false;directoryStatus('已记住保存文件夹，请点击“恢复文件夹授权”；当前进度仍保存在浏览器。','saving');}}
  if(!window.showDirectoryPicker){$('chooseDirectory').hidden=true;directoryStatus('当前浏览器不支持自动写入文件夹。进度会保存在浏览器，请使用“下载标注文件”备份。','saving');}
  const saved=state.current_group_id,id=manifest.groups.some(g=>g.id===saved)?saved:manifest.groups.some(g=>g.id==='G15')?'G15':manifest.groups[0].id;
  $('loading').hidden=true;$('workspace').hidden=false;$('backup').hidden=false;chooseGroup(id);
 }catch(e){$('loading').textContent=(e.message||'页面读取失败')+'。请保留已有文件，刷新重试。';$('loading').classList.add('error-banner');throw e;}
}
$('unlockForm').onsubmit=async e=>{
 e.preventDefault();const button=$('unlockButton'),input=$('cloudPassword');if(button.disabled)return;
 button.disabled=true;$('unlockError').hidden=true;button.textContent='正在打开照片…';
 let passphrase=input.value;input.value='';
 try{const bootstrap=await PotsCloudAssets.unlock(passphrase);passphrase='';$('unlockPanel').hidden=true;$('loading').hidden=false;await boot(bootstrap);}
 catch(error){passphrase='';$('loading').hidden=true;$('unlockPanel').hidden=false;$('unlockError').textContent=error.message||'暂时无法打开，请重试。';$('unlockError').hidden=false;input.focus();}
 finally{button.disabled=false;button.textContent='进入标注页面';}
};
