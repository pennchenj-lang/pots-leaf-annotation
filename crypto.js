'use strict';
// Asset decryption only. No passwords, keys or annotation records are uploaded.
window.PotsCloudAssets=(()=>{
 const encoder=new TextEncoder(),decoder=new TextDecoder(),magic=encoder.encode('POTSENC1');
 const assetBase=new URL('./',document.currentScript.src);
 let key=null,activeGroup=null;
 const cache=new Map();
 function allowed(path){return path==='/data/bootstrap.enc'||/^\/data\/images\/(G\d{2}|P\d{3})_\d{2}\.enc$/.test(path);}
 async function fetchBytes(path,options={}){
  const response=await fetch(new URL(path.slice(1),assetBase),{credentials:'same-origin',...options});
  if(!response.ok)throw new Error('云端文件暂时无法读取，请稍后重试。');
  return response.arrayBuffer();
 }
 async function decrypt(path,bytes,cryptoKey){
  if(!allowed(path))throw new Error('文件地址不在本次标注范围内。');
  const data=new Uint8Array(bytes);
  if(data.length<36||magic.some((b,i)=>b!==data[i]))throw new Error('云端文件格式异常，请联系分享者。');
  return crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(8,20),additionalData:encoder.encode(path),tagLength:128},cryptoKey,data.slice(20));
 }
 function drop(path,entry){if(entry.url)URL.revokeObjectURL(entry.url);if(entry.pending)entry.controller.abort();cache.delete(path);}
 function prune(){
  if(cache.size<=12)return;
  const candidates=[...cache.entries()].filter(([,e])=>e.group!==activeGroup).sort((a,b)=>a[1].used-b[1].used);
  while(cache.size>12&&candidates.length){const [path,entry]=candidates.shift();drop(path,entry);}
 }
 function activate(group){
  if(activeGroup===group)return;
  activeGroup=group;
  for(const [path,entry]of cache)if(entry.pending&&entry.group!==group)drop(path,entry);
  prune();
 }
 async function unlock(passphrase){
  if(!isSecureContext||!crypto.subtle)throw new Error('请使用支持安全连接的 Chrome 或 Edge 浏览器打开。');
  const response=await fetch(new URL('data/crypto.json',assetBase),{cache:'no-store'});
  if(!response.ok)throw new Error('云端标注资料暂未就绪，请稍后重试。');
  const config=await response.json();
  if(config.format!=='POTSENC1'||config.kdf!=='PBKDF2-SHA256'||config.iterations!==600000||typeof config.saltBase64!=='string')throw new Error('标注资料配置不兼容，请联系分享者。');
  let salt;try{salt=Uint8Array.from(atob(config.saltBase64),c=>c.charCodeAt(0));}catch(e){throw new Error('标注资料配置不兼容，请联系分享者。');}
  if(salt.length!==32)throw new Error('标注资料配置不兼容，请联系分享者。');
  const passwordBytes=encoder.encode(passphrase);
  const material=await crypto.subtle.importKey('raw',passwordBytes,'PBKDF2',false,['deriveKey']);passwordBytes.fill(0);
  const derived=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:config.iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
  const bytes=await fetchBytes('/data/bootstrap.enc',{cache:'no-store'});
  let plain;try{plain=await decrypt('/data/bootstrap.enc',bytes,derived);}catch(e){throw new Error('访问密码不正确，或文件读取不完整。请检查密码后重试。');}
  let bootstrap;try{bootstrap=JSON.parse(decoder.decode(plain));}catch(e){throw new Error('照片清单格式异常，请联系分享者。');}
  if(!bootstrap.manifest?.groups?.length||!bootstrap.manifest_sha256)throw new Error('照片清单不完整，请联系分享者。');
  key=derived;return bootstrap;
 }
 function image(group,view,{retry=false}={}){
  if(!key)return Promise.reject(new Error('请先输入访问密码。'));
  const path=`/data/images/${group}_${view.id}.enc`;
  if(!allowed(path))return Promise.reject(new Error('无效照片编号。'));
  const old=cache.get(path);
  if(old&&!retry){old.used=performance.now();return old.promise;}
  if(old)drop(path,old);
  const entry={group,used:performance.now(),pending:true,controller:new AbortController()};
  entry.promise=(async()=>{
   try{
    const bytes=await fetchBytes(path,{signal:entry.controller.signal,cache:retry?'reload':'default'});
    const plain=await decrypt(path,bytes,key);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',plain))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==(view.display_sha256||view.sha256))throw new Error('照片校验失败，请重试；不要在异常照片上标注。');
    if(entry.controller.signal.aborted)throw new DOMException('Group changed','AbortError');
    const mime=view.browser_mime||'image/jpeg';
    if(!['image/jpeg','image/png','image/webp'].includes(mime))throw new Error('照片类型不支持。');
    entry.url=URL.createObjectURL(new Blob([plain],{type:mime}));entry.pending=false;prune();return entry.url;
   }catch(e){if(cache.get(path)===entry)cache.delete(path);if(e.name==='AbortError')throw e;throw new Error(e.message==='The operation failed for an operation-specific reason'?'照片读取或解锁失败，请重试。':(e.message||'照片读取失败，请重试。'));}
  })();
  cache.set(path,entry);prune();return entry.promise;
 }
 return Object.freeze({unlock,image,activate});
})();
