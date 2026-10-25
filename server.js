'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=__dirname,PORT=Number(process.env.PORT||3000),PROVIDER=(process.env.LIBRETRANSLATE_URL||'').replace(/\/$/,'');
const HOSTS=(process.env.ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const rooms=new Map(),rates=new Map(),LANGS=new Set(['uz','en','ru','tr','hi','kk','ky','tg','tk','zh']);
const TTL=6*3600000,MAX_BODY=16000;
const OPENAI_KEY=process.env.OPENAI_API_KEY||'';
const MYMEMORY='https://api.mymemory.translated.net/get';
const MM_LANG={uz:'uz-UZ',en:'en-GB',ru:'ru-RU',tr:'tr-TR',hi:'hi-IN',kk:'kk-KZ',ky:'ky-KG',tg:'tg-TJ',tk:'tk-TM',zh:'zh-CN'};
async function freeTranslate(b){
  if(PROVIDER){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),18000);try{const r=await fetch(PROVIDER+'/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:b.text,source:b.source,target:b.target,format:'text',api_key:process.env.LIBRETRANSLATE_API_KEY||undefined}),signal:ctrl.signal});const data=await r.json();if(!r.ok||typeof data.translatedText!=='string')throw Error('LibreTranslate provider error');return {translatedText:data.translatedText,provider:'LibreTranslate'};}finally{clearTimeout(timer)}}
  if(b.text.length>450)throw Object.assign(new Error('Bepul MyMemory rejimida har bir matn bo‘lagi 450 belgidan oshmasin.'),{status:400});
  const url=new URL(MYMEMORY);url.searchParams.set('q',b.text);url.searchParams.set('langpair',MM_LANG[b.source]+'|'+MM_LANG[b.target]);
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),15000);try{const r=await fetch(url,{headers:{'Accept':'application/json'},signal:ctrl.signal});const data=await r.json();const t=data?.responseData?.translatedText;const status=Number(data?.responseStatus||r.status);if(!r.ok||status!==200||typeof t!=='string'||!t.trim())throw Object.assign(new Error('Bepul tarjima xizmati bu til juftligini yoki so‘rovni bajara olmadi. Limit tugagan bo‘lishi mumkin.'),{status:502});return {translatedText:t,provider:'MyMemory (bepul)',warning:'Bepul xizmat: sifat va til qamrovi kafolatlanmaydi.'};}finally{clearTimeout(timer)}
}
async function proTranslate(b){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),25000);try{const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_KEY},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',temperature:0.1,messages:[{role:'system',content:'You are a professional academic lecture translator. Translate accurately into '+b.target+' from '+b.source+'. Preserve technical terminology, formulas and names. Return only the translation.'},{role:'user',content:b.text}] }),signal:ctrl.signal});const data=await r.json();const t=data?.choices?.[0]?.message?.content;if(!r.ok||typeof t!=='string')throw Object.assign(new Error('Professional AI xizmatida xatolik: '+(data?.error?.message||r.status)),{status:502});return {translatedText:t,provider:'OpenAI Professional'};}finally{clearTimeout(timer)}}
function reply(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
function fail(res,status,msg){return reply(res,status,{error:msg})}
function safeEq(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function limited(req,kind){const ip=(req.socket.remoteAddress||'unknown'),key=ip+':'+kind,now=Date.now();let rec=rates.get(key);if(!rec||now-rec.time>60000)rec={time:now,count:0};rates.set(key,rec);return ++rec.count>(kind==='translate'?40:kind==='create'?8:150)}
function read(req){return new Promise((resolve,reject)=>{let chunks=[],size=0,ended=false;req.on('data',c=>{size+=c.length;if(size>MAX_BODY){if(!ended){ended=true;reject(Object.assign(new Error('Payload too large'),{status:413}))}req.destroy();return}chunks.push(c)});req.on('end',()=>{if(ended)return;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'))}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}))}});req.on('error',reject)})}
function cleanup(){const now=Date.now();for(const [id,r] of rooms){if(now-r.updated>TTL)rooms.delete(id);else for(const [pid,p] of r.participants)if(now-p.last>25000)r.participants.delete(pid)}for(const [k,v] of rates)if(now-v.time>120000)rates.delete(k)}setInterval(cleanup,60000).unref();
function room(id){return rooms.get(String(id||''))}
function teacher(r,key){return r&&safeEq(key,r.key)}
function student(r,id,token){const p=r?.participants.get(String(id||''));return p&&safeEq(p.token,token)}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
http.createServer(async(req,res)=>{
  const host=(req.headers.host||'').toLowerCase().split(':')[0];
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if(HOSTS.length&&!HOSTS.includes(host))return fail(res,403,'Unapproved hostname');
  if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host)return fail(res,403,'Cross-site request rejected')}catch{return fail(res,403,'Invalid origin')}}
  let u;try{u=new URL(req.url,'http://localhost')}catch{return fail(res,400,'Bad URL')}
  const api=u.pathname.startsWith('/api/');
  if(api&&limited(req,u.pathname==='/api/translate'?'translate':u.pathname==='/api/create'?'create':'api'))return fail(res,429,'Too many requests');
  try{
    if(u.pathname==='/api/health'&&req.method==='GET')return reply(res,200,{ok:true,translationConfigured:true,freeProvider:PROVIDER?'LibreTranslate':'MyMemory',professionalAvailable:!!OPENAI_KEY});
    if(u.pathname==='/api/create'&&req.method==='POST'){
      let id;do{id=String(crypto.randomInt(100000,1000000))}while(rooms.has(id));
      const key=crypto.randomBytes(32).toString('hex');rooms.set(id,{key,events:[],next:1,updated:Date.now(),participants:new Map(),mode:'free'});return reply(res,200,{id,key});
    }
    if(u.pathname==='/api/presence'&&req.method==='POST'){
      const b=await read(req),r=room(b.id);if(!r)return fail(res,404,'Session not found');
      const pid=String(b.participant||'');if(!/^[\w-]{8,100}$/.test(pid))return fail(res,400,'Invalid participant');
      if(b.action==='join'){
        if(!LANGS.has(b.lang))return fail(res,400,'Invalid language');
        let p=r.participants.get(pid);if(!p){p={token:crypto.randomBytes(24).toString('hex')};r.participants.set(pid,p)}
        Object.assign(p,{lang:b.lang,audio:!!b.audio,last:Date.now()});r.updated=Date.now();return reply(res,200,{ok:true,token:p.token});
      }
      if(!student(r,pid,b.token))return fail(res,403,'Student authentication required');
      if(b.action==='leave')r.participants.delete(pid);
      else if(b.action==='heartbeat'){if(!LANGS.has(b.lang))return fail(res,400,'Invalid language');Object.assign(r.participants.get(pid),{lang:b.lang,audio:!!b.audio,last:Date.now()})}
      else return fail(res,400,'Invalid action');r.updated=Date.now();return reply(res,200,{ok:true});
    }
    if(u.pathname==='/api/stats'&&req.method==='GET'){
      const r=room(u.searchParams.get('id'));if(!r)return fail(res,404,'Session not found');
      if(!teacher(r,u.searchParams.get('key')))return fail(res,403,'Teacher authentication required');
      const counts={};let audio=0;for(const [pid,p] of r.participants){if(Date.now()-p.last>25000){r.participants.delete(pid);continue}counts[p.lang]=(counts[p.lang]||0)+1;if(p.audio)audio++}
      return reply(res,200,{students:r.participants.size,languages:Object.keys(counts).length,audio,counts});
    }
    if(u.pathname==='/api/publish'&&req.method==='POST'){
      const b=await read(req),r=room(b.id);if(!teacher(r,b.key))return fail(res,403,'Teacher authentication required');
      if(!['text','end'].includes(b.type)||typeof b.text!=='string'||b.text.length>6000||!LANGS.has(b.lang))return fail(res,400,'Invalid event');
      r.events.push({seq:r.next++,type:b.type,text:b.text,lang:b.lang,mode:r.mode,time:Date.now()});if(r.events.length>300)r.events.shift();r.updated=Date.now();return reply(res,200,{ok:true});
    }
    if(u.pathname==='/api/events'&&req.method==='GET'){
      const r=room(u.searchParams.get('id'));if(!r)return fail(res,404,'Session not found');
      if(!teacher(r,u.searchParams.get('key'))&&!student(r,u.searchParams.get('participant'),u.searchParams.get('token')))return fail(res,403,'Join the lesson first');
      const since=Math.max(0,Number(u.searchParams.get('since')||0));return reply(res,200,{events:r.events.filter(e=>e.seq>since).slice(-100),latest:r.next-1});
    }
    if(u.pathname==='/api/mode'&&req.method==='POST'){
      const b=await read(req),r=room(b.id);if(!teacher(r,b.key))return fail(res,403,'Teacher authentication required');
      if(!['free','professional'].includes(b.mode))return fail(res,400,'Invalid mode');
      if(b.mode==='professional'&&!OPENAI_KEY)return fail(res,503,'Professional AI uchun OPENAI_API_KEY sozlanmagan');
      r.mode=b.mode;r.updated=Date.now();return reply(res,200,{mode:r.mode});
    }
    if(u.pathname==='/api/translate'&&req.method==='POST'){
      const b=await read(req);if(!LANGS.has(b.source)||!LANGS.has(b.target)||typeof b.text!=='string'||b.text.length>4000)return fail(res,400,'Invalid translation request');
      if(b.source===b.target)return reply(res,200,{translatedText:b.text});
      const mode=b.mode==='professional'?'professional':'free';
      if(mode==='professional'){
        const r=room(b.id);if(!r||r.mode!=='professional')return fail(res,403,'Professional AI sessiyada yoqilmagan');
        if(!teacher(r,b.key)&&!student(r,b.participant,b.token))return fail(res,403,'Session authorization required');
        if(!OPENAI_KEY)return fail(res,503,'Professional AI ulanmagan');
      }
      try{return reply(res,200,mode==='professional'?await proTranslate(b):await freeTranslate(b))}
      catch(e){return fail(res,e.status||502,e.message||'Tarjima xizmati javob bermadi')}

    }
    if(api)return fail(res,404,'Unknown API');if(req.method!=='GET'&&req.method!=='HEAD')return fail(res,405,'Method not allowed');
    const allowed=new Set(['/','/index.html','/app.js','/help.js','/style.css','/theme.css','/muallif_kuchkarov.png','/favicon.ico']);if(!allowed.has(u.pathname))return fail(res,404,'Not found');
    const file=u.pathname==='/'?'index.html':u.pathname.slice(1);fs.readFile(path.join(ROOT,file),(err,data)=>{if(err)return fail(res,404,'Not found');res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store, max-age=0'});res.end(req.method==='HEAD'?undefined:data)});
  }catch(e){if(!res.headersSent)return fail(res,e.status||500,e.status?e.message:'Server error')}
}).listen(PORT,()=>console.log('LECTOR TRANSLATE KUCHKAROV secure server listening on '+PORT));
