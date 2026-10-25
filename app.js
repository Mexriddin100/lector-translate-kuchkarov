const $=id=>document.getElementById(id);const langs={uz:'O‘zbek',en:'English',ru:'Русский',tr:'Türkçe',hi:'हिन्दी',kk:'Қазақша',ky:'Кыргызча',tg:'Тоҷикӣ',tk:'Türkmençe',zh:'中文（普通话）'};const speechLang={uz:'uz-UZ',en:'en-US',ru:'ru-RU',tr:'tr-TR',hi:'hi-IN',kk:'kk-KZ',ky:'ky-KG',tg:'tg-TJ',tk:'tk-TM',zh:'zh-CN'};for(const id of ['source','target','studentLang']){for(const [v,n] of Object.entries(langs))$(id).add(new Option(n,v));} $('source').value='uz';$('target').value='en';$('studentLang').value='en';let activeMode="free",professionalAvailable=false;let entries=[],translations=[],session=null,recognition=null,joined=null,seq=0,poll=null,processing=Promise.resolve(),listening=false;let speechPlayback=false,recognitionRunning=false,lastAcceptedSpeech="",lastAcceptedAt=0,restartTimer=null;
let audioContext=null,micStream=null,micAnalyser=null,micSamples=null,voiceSeenAt=0,recognitionStartedAt=0,recognitionGeneration=0,contentGeneration=0;
let micNoiseFloor=0.008, speechGateEnabled=false, gateFrame=null;
// Only commit speech recognized during a real microphone voice interval.
let lastInterimVoiceAt=0, lastInterimText='', lastInterimAt=0, lastVoiceAtRecognitionStart=0;
let previousResultKeys=new Set();

// Terminology support. Only user-confirmed substitutions are applied: do not invent missing words.
const defaultTerms=['elektrokimyo','elektroliz','elektrolit','galvanik element','elektrod','anod','katod','oksidlanish','qaytarilish','korroziya','elektr yurituvchi kuch','Faradey qonuni','Nernst tenglamasi','kimyoviy reaksiya','sulfat kislota','natriy xlorid','mol','molyar konsentratsiya'];
const getStored=(k,def)=>{try{return localStorage.getItem(k)||def}catch{return def}};
$('terms').value=getStored('lector_terms_v13',defaultTerms.join('\n'));
$('corrections').value=getStored('lector_corrections_v13','elektro kimyo => elektrokimyo\nelektro liz => elektroliz');
$('saveTerms').onclick=()=>{try{localStorage.setItem('lector_terms_v13',$('terms').value);localStorage.setItem('lector_corrections_v13',$('corrections').value)}catch{};applyRecognitionHints();notify('micstatus','Ilmiy terminlar lug‘ati saqlandi')};
function correctedTranscript(input){let t=String(input||'');for(const line of $('corrections').value.split(/\r?\n/)){const parts=line.split('=>');if(parts.length!==2)continue;const from=parts[0].trim(),to=parts[1].trim();if(!from||!to||from.length>100||to.length>100)continue;const escaped=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');try{t=t.replace(new RegExp('(^|[^\\p{L}\\p{N}])('+escaped+')(?=$|[^\\p{L}\\p{N}])','giu'),(_m,prefix)=>prefix+to)}catch{}}return t}
function applyRecognitionHints(){if(!recognition||!('phrases' in recognition)||!('SpeechRecognitionPhrase' in window))return;try{const words=$('terms').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,100);recognition.phrases=words.map(x=>new window.SpeechRecognitionPhrase(x,5))}catch(e){logSpeech('Term hints not supported: '+e.message)}}
function logSpeech(msg){if(!$('speechDebug').checked)return;const el=$('speechLog');el.textContent=(new Date().toLocaleTimeString()+' '+msg+'\n'+el.textContent).slice(0,7000)}
let lastRenderedInterim='';

function speechWords(s){return (s.toLocaleLowerCase().match(/[\p{L}]+/gu)||[]).filter(w=>w.length>1)}
function suspiciousNumericPrefix(text){
 // Detect the repeatedly observed recognizer artefact, including concatenations.
 // This is deliberately limited to the observed artefact, not legitimate measurements.
 return /^(?:(?:0?30224)+)(?=\s|$)/.test(text);
}
function cleanRecognitionArtefact(text){
 let cleaned=text.replace(/^(?:(?:0?30224)+)\s*/,'').trim();
 return cleaned;
}

async function setupVoiceGate(){
 try{
  if(!navigator.mediaDevices?.getUserMedia)return;
  micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
  audioContext=new AC();const source=audioContext.createMediaStreamSource(micStream);
  micAnalyser=audioContext.createAnalyser();micAnalyser.fftSize=1024;source.connect(micAnalyser);
  micSamples=new Float32Array(micAnalyser.fftSize);speechGateEnabled=true;
  const monitor=()=>{if(!speechGateEnabled)return;const level=voiceLevel();if(level!==null){if(level>Math.max(0.014,micNoiseFloor*2.8))voiceSeenAt=Date.now();else micNoiseFloor=micNoiseFloor*0.995+level*0.005}gateFrame=requestAnimationFrame(monitor)};monitor();
 }catch(e){speechGateEnabled=false;notify('micstatus','Ovoz filtri ulanmagan; brauzer nutqni aniqlash davom etadi')}
}
function voiceLevel(){if(!speechGateEnabled||!micAnalyser)return null;micAnalyser.getFloatTimeDomainData(micSamples);let sum=0;for(const v of micSamples)sum+=v*v;return Math.sqrt(sum/micSamples.length)}
function stopVoiceGate(){speechGateEnabled=false;if(gateFrame!==null){cancelAnimationFrame(gateFrame);gateFrame=null}if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null}if(audioContext){audioContext.close().catch(()=>{});audioContext=null}micAnalyser=null}
function isSuspiciousSilence(text){
 const level=voiceLevel(),now=Date.now();
 if(level!==null){
  if(level>Math.max(0.014,micNoiseFloor*2.8))voiceSeenAt=now;
  else micNoiseFloor=micNoiseFloor*0.995+level*0.005;
 }
 const digits=(text.match(/\d/g)||[]).length,letters=(text.match(/[^\W\d_]/gu)||[]).length;
 // Brauzer gap tugagach takrorlaydigan raqamli gallyutsinatsiyalarni ajratish.
 if(digits>=4&&digits>letters*0.65&&(!speechGateEnabled||now-voiceSeenAt>1000))return true;
 // Audio darajasi past va gap boshlanmagan bo'lsa, yakuniy natijani qabul qilmaymiz.
 return speechGateEnabled&&now-voiceSeenAt>3500;
}

const notify=(id,msg)=>$(id).textContent=msg;let statsTimer=null,presenceTimer=null,studentToken=null;const participantId='p_'+((window.crypto&&typeof window.crypto.randomUUID==='function')?window.crypto.randomUUID().replace(/-/g,''):Math.random().toString(36).slice(2)+Date.now().toString(36));async function presence(action){if(!joined)return;try{await fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:joined,participant:participantId,lang:$('studentLang').value,audio:$('speak').checked,action,token:studentToken})}).then(async r=>{if(r.ok&&action==='join')studentToken=(await r.json()).token})}catch{}}async function updateStats(){if(!session)return;try{const r=await fetch('/api/stats?id='+encodeURIComponent(session.id)+'&key='+encodeURIComponent(session.key));if(!r.ok)throw Error('Server unavailable');const d=await r.json();$('statStudents').textContent=d.students;$('statLanguages').textContent=d.languages;$('statAudio').textContent=d.audio;$('statBreakdown').textContent=Object.entries(d.counts).map(([lang,n])=>`${langs[lang]||lang}: ${n}`).join(' · ')||'Hali talaba ulanmagan'}catch{$('statBreakdown').textContent='Monitoring serveriga ulanish yo‘q'}}const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function render(){ $('original').innerHTML=entries.length?entries.map((x,i)=>`<p><small>${i+1}.</small> ${escapeHTML(x.text)} <button class="editLine" data-entry="${i}" type="button">Tahrirlash</button></p>`).join(''):'<p class="placeholder">Hali ma’lumot yo‘q.</p>';$('translated').innerHTML=translations.length?translations.map(x=>`<p>${escapeHTML(x)}</p>`).join(''):'<p class="placeholder">Tarjima hali yo‘q.</p>';$('count').textContent=entries.length+' ta bo‘lak'}
$('original').addEventListener('click',async e=>{const b=e.target.closest('button[data-entry]');if(!b)return;const i=Number(b.dataset.entry);if(!entries[i])return;const changed=prompt('Stenogramma matnini tahrirlang:',entries[i].text);if(changed===null||!changed.trim())return;entries[i].text=changed.trim();render();if(confirm('Tuzatilgan satrni qayta tarjima qilasizmi?')){try{const out=await translate(entries[i].text,entries[i].lang,$('target').value);translations[i]=out;render();notify('translateStatus','Tuzatilgan matn qayta tarjima qilindi')}catch(err){notify('translateStatus',err.message)}}});
async function translate(text,source,target,modeOverride){if(source===target)return text;const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,source,target,mode:modeOverride|| (joined?'free':activeMode),id:joined||session?.id,key:joined?undefined:session?.key,participant:joined?participantId:undefined,token:joined?studentToken:undefined})});const d=await r.json();if(!r.ok)throw Error(d.error||'Tarjima xatosi');return d.translatedText}
function restartRecognition(){
 if(!listening||speechPlayback||!recognition||recognitionRunning)return;
 clearTimeout(restartTimer);
 restartTimer=setTimeout(()=>{if(listening&&!speechPlayback&&!recognitionRunning){try{recognition.start()}catch(e){logSpeech('RESTART ERROR: '+e.message);stopMicSession('Mikrofon qayta ishga tushmadi: '+e.message)}}},900);
}
function say(text,lang){
 if(!$('speak').checked||!('speechSynthesis'in window))return;
 const u=new SpeechSynthesisUtterance(text);u.lang=speechLang[lang]||lang;u.rate=.96;
 // Karnay ovozi mikrofonga qayta tushmasligi uchun nutqni aniqlashni vaqtincha to'xtatamiz.
 if(listening){speechPlayback=true;clearTimeout(restartTimer);if(recognition&&recognitionRunning){try{recognition.abort()}catch{}}notify('micstatus','Tarjima ovoz chiqarib o‘qilmoqda; mikrofon vaqtincha pauzada')}
 const done=()=>{if(speechPlayback){speechPlayback=false;restartRecognition()}};
 u.onend=done;u.onerror=done;
 try{speechSynthesis.speak(u)}catch{done()}
}
async function publish(text,lang){if(!session)return;try{await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:session.id,key:session.key,type:'text',text,lang})})}catch{notify('micstatus','Aloqa uzildi: sessiyaga yuborish amalga oshmadi')}}
function addText(text){text=String(text||'').trim();if(!text){notify('micstatus','Matn kiriting, so‘ng «Matnni qo‘shish» tugmasini bosing.');return false;}const generation=contentGeneration;const source=$('source').value,target=$('target').value;entries.push({text,lang:source});render();publish(text,source);if($('autoTranslate').checked)processing=processing.then(async()=>{try{const out=await translate(text,source,target);if(generation!==contentGeneration)return;translations.push(out);render();say(out,target);notify('translateStatus','Tarjima bajarildi')}catch(e){if(generation!==contentGeneration)return;translations.push('[Tarjima xatosi: '+e.message+']');render();notify('translateStatus',e.message)}});return true}
$('add').onclick=()=>{const value=$('manual').value;if(addText(value)){$('manual').value='';notify('micstatus','Matn stenogrammaga qo‘shildi.')}};
$('clear').onclick=()=>{if(confirm('Stenogramma tozalansinmi? Tarjima saqlanadi.')){entries=[];previousResultKeys.clear();render()}};
$('clearTranslation').onclick=()=>{translations=[];contentGeneration++;render();notify('translateStatus','Tarjima oynasi tozalandi')};
$('clearBoth').onclick=()=>{if(confirm('Stenogramma va tarjima birgalikda tozalansinmi?')){entries=[];translations=[];previousResultKeys.clear();contentGeneration++;render();notify('translateStatus','Ikkala oyna tozalandi')}};

$('translateAll').onclick=async()=>{translations=[];notify('translateStatus','Tarjima bajarilmoqda...');for(const e of entries){try{translations.push(await translate(e.text,e.lang,$('target').value))}catch(err){notify('translateStatus',err.message);break}render()}if(translations.length===entries.length)notify('translateStatus','Barcha matn tarjima qilindi')};
function normalizeSpeech(s){return String(s||'').trim().replace(/\s+/g,' ').toLocaleLowerCase()}
function acceptRecognizedSpeech(result){
 let text=String(result?.transcript||'').trim().replace(/\s+/g,' ');
 if(!text||speechPlayback||!listening)return false;
 const now=Date.now();
 // The browser can emit a final result after silence.  A recent interim heard
 // during speech is stronger evidence than the final callback timestamp.
 const hasRecentVoice=voiceSeenAt>lastVoiceAtRecognitionStart && now-voiceSeenAt<2600;
 const hasInterimEvidence=lastInterimVoiceAt>lastVoiceAtRecognitionStart && now-lastInterimVoiceAt<4500;
 // V17: browser speech recognition is authoritative; audio gate may miss quiet voices.
 // Do not discard real recognized words solely because the analyser missed them.
 logSpeech('FINAL raw: '+JSON.stringify(text)+' confidence='+result?.confidence);
 const rawKey=normalizeSpeech(text);
 if(previousResultKeys.has(rawKey))return false;
 previousResultKeys.add(rawKey);
 // Repeated 30224 is a confirmed artefact on this machine. Remove it even
 // when concatenated to the start of a real phrase; preserve other numbers.
 if(suspiciousNumericPrefix(text)){logSpeech('Filtered observed 30224 prefix');text=cleanRecognitionArtefact(text)}
 text=correctedTranscript(text);
 if(!text)return false;
 // A purely numeric final result without corroborating interim evidence is
 // withheld, rather than deleting numeric values within spoken sentences.
 if(/^\d+$/.test(text)&&!hasInterimEvidence)return false;
 // Do not reject valid final transcripts on uncertain silence detection.
 const confidence=Number(result?.confidence);
 // Past confidence ham ko‘rinadi: noto‘g‘ri rad etishdan saqlanamiz.
 const norm=normalizeSpeech(text);
 if(norm===lastAcceptedSpeech&&now-lastAcceptedAt<12000)return false;
 lastAcceptedSpeech=norm;lastAcceptedAt=now;logSpeech('ACCEPT: '+text);addText(text);return true;
}
// V21: permission check, observable start, bounded retries and actionable errors.
let micStartupTimer=null, micRetryCount=0, micLastError='', micStarting=false;
let micLastResultAt=0, micLastInterim='', micLastInterimAt=0, micLastStartAt=0, micLastEndAt=0, micLastEvent='';
function resetMicButtons(){ $('start').disabled=false; $('stop').disabled=true; }
function stopMicSession(message){
 listening=false;micStarting=false;recognitionRunning=false;clearTimeout(restartTimer);clearTimeout(micStartupTimer);micLastEvent='stopped';
 stopVoiceGate();if(recognition){try{recognition.abort()}catch{}}resetMicButtons();
 if(message)notify('micstatus',message);
}
function microphoneErrorMessage(error){
 const messages={
 'not-allowed':'Mikrofonga ruxsat berilmagan. Sayt manzili yonidagi belgi → Sayt sozlamalari → Mikrofon → Ruxsat berish.',
 'service-not-allowed':'Brauzer nutqni aniqlash xizmatiga ruxsat bermadi. Chrome yoki Edge brauzerini tekshiring.',
 'audio-capture':'Mikrofon topilmadi yoki band. Windows mikrofon sozlamalarini tekshiring.',
 'network':'Brauzerning nutqni aniqlash xizmati internetga ulana olmadi. Internetni va Chrome/Edge xizmatini tekshiring.',
 'language-not-supported':'Tanlangan ma’ruza tilida nutqni tanish brauzer tomonidan qo‘llab-quvvatlanmayapti.',
 'no-speech':'Nutq eshitilmadi. Mikrofon yaqinida gapiring.',
 'aborted':'Nutqni aniqlash to‘xtatildi.'};
 return messages[error]||('Nutqni tanish xatosi: '+error);
}
$('start').onclick=async()=>{
 if(listening||micStarting)return;
 const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!SR){notify('micstatus','Bu brauzer nutqni tanishni qo‘llamaydi. Kompyuterda yangilangan Chrome yoki Edge brauzerini ishlating.');return}
 if(!window.isSecureContext){notify('micstatus','Mikrofon uchun HTTPS kerak. Render sayti https:// orqali ochilsin.');return}
 micStarting=true;$('start').disabled=true;$('stop').disabled=false;
 notify('micstatus','Mikrofon ruxsati tekshirilmoqda...');
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Brauzer mikrofonni ochish imkoniyatini bermadi.');
  // Check the actual device permission and release it before SpeechRecognition owns the microphone.
  const stream=await navigator.mediaDevices.getUserMedia({audio:true});
  stream.getTracks().forEach(track=>track.stop());
 }catch(e){
  const reason=e.name==='NotAllowedError'||e.name==='PermissionDeniedError'?'Mikrofonga ruxsat berilmagan. Manzil yonidagi belgi orqali ruxsat bering.':
   e.name==='NotFoundError'?'Mikrofon topilmadi. Kompyuter mikrofonini ulang yoki sozlamadan tanlang.':
   e.name==='NotReadableError'?'Mikrofonni boshqa dastur band qilgan. Boshqa dasturlarni yoping.':e.message;
  micStarting=false;resetMicButtons();notify('micstatus',reason);return;
 }
 if(!micStarting)return;
 try{
  recognition=new SR();recognition.lang=speechLang[$('source').value];recognition.continuous=false;
  recognition.interimResults=true;recognition.maxAlternatives=1;applyRecognitionHints();
 }catch(e){micStarting=false;resetMicButtons();notify('micstatus','Nutqni aniqlash ishga tushmadi: '+e.message);return}
 listening=true;micStarting=false;micRetryCount=0;micLastError='';lastAcceptedSpeech='';recognitionRunning=false;micLastInterim='';micLastEvent='starting';
 voiceSeenAt=Date.now();recognitionStartedAt=Date.now();
 recognition.onstart=()=>{
  clearTimeout(micStartupTimer);micLastError='';micLastStartAt=Date.now();micLastEvent='started';recognitionStartedAt=Date.now();
  previousResultKeys.clear();lastRenderedInterim='';lastInterimText='';lastInterimVoiceAt=0;
  lastInterimAt=0;lastVoiceAtRecognitionStart=voiceSeenAt;recognitionRunning=true;
  if(!speechPlayback)notify('micstatus','🎙 Mikrofon faol. Gapiring — nutq stenogrammada paydo bo‘ladi.');
 };
 recognition.onresult=e=>{
  if(speechPlayback||!listening)return;
  let interim='';
  for(let i=e.resultIndex;i<e.results.length;i++){
   const result=e.results[i],candidate=result[0];
   if(result.isFinal){micLastResultAt=Date.now();micRetryCount=0;micLastInterim='';acceptRecognizedSpeech(candidate);}
   else{
    interim+=candidate.transcript;lastInterimText=candidate.transcript;micLastInterim=candidate.transcript;micLastInterimAt=Date.now();micLastResultAt=Date.now();micRetryCount=0;
    if(lastRenderedInterim!==candidate.transcript){lastRenderedInterim=candidate.transcript;logSpeech('INTERIM: '+JSON.stringify(candidate.transcript))}
    lastInterimAt=Date.now();if(!speechGateEnabled||Date.now()-voiceSeenAt<550)lastInterimVoiceAt=Date.now();
   }
  }
  if(interim)notify('micstatus','Eshitilmoqda: '+interim.slice(0,160));
  else notify('micstatus','🎙 Mikrofon faol');
 };
 recognition.onerror=e=>{
  logSpeech('ERROR: '+e.error);micLastError=e.error;micLastEvent='error:'+e.error;
  if(e.error==='aborted'&&(!listening||speechPlayback))return;
  if(e.error==='no-speech'){notify('micstatus','Nutq eshitilmadi; qayta tinglashga urinilmoqda.');return}
  notify('micstatus',microphoneErrorMessage(e.error));
  if(['not-allowed','service-not-allowed','audio-capture','language-not-supported','network'].includes(e.error)){
   stopMicSession(microphoneErrorMessage(e.error));
  }
 };
 recognition.onend=()=>{
  logSpeech('END; listening='+listening+' error='+micLastError);recognitionRunning=false;micLastEndAt=Date.now();micLastEvent='ended';
  if(!listening||speechPlayback)return;
  // Chrome sometimes ends a session after a short phrase without emitting a final result.
  // Preserve a recently heard interim transcript instead of silently discarding it.
  if(micLastInterim&&Date.now()-micLastInterimAt<6000){
   const interimText=micLastInterim;micLastInterim='';
   acceptRecognizedSpeech({transcript:interimText,confidence:0});
  }
  if(micLastError&&micLastError!=='no-speech'&&micLastError!=='aborted'){
   stopMicSession(microphoneErrorMessage(micLastError));return;
  }
  // Short recognition sessions ending normally are expected, not repeated failures.
  // Restart while the teacher wants to listen, without a fixed 8-attempt cutoff.
  notify('micstatus','🎙 Tinglash davom etmoqda — yangi nutq kutilmoqda...');restartRecognition();
 };
 try{
  recognition.start();
  notify('micstatus','Mikrofon ruxsat berilgan. Nutqni tanish xizmati ishga tushmoqda...');
  micStartupTimer=setTimeout(()=>{
   if(listening&&!recognitionRunning){
    stopMicSession('Nutqni tanish xizmati javob bermadi (12 soniya). Chrome/Edge brauzerini va internetni tekshiring.');
   }
  },12000);
 }catch(e){stopMicSession('Mikrofonni boshlash xatosi: '+e.message)}
};
$('stop').onclick=()=>stopMicSession('Nutqni aniqlash to‘xtatildi');
$('create').onclick=async()=>{try{const r=await fetch('/api/create',{method:'POST'});if(!r.ok)throw Error('Server javob bermadi: '+r.status);session=await r.json();if(activeMode==='professional'){const mr=await fetch('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:session.id,key:session.key,mode:activeMode})});if(!mr.ok){activeMode='free';$('translationMode').value='free';notify('modeStatus','Professional AI rejimini yoqib bo‘lmadi; bepul rejimga qaytildi')}}const url=new URL(location.href);url.searchParams.set('room',session.id);$('session').textContent='Kod: '+session.id+' | '+url.toString();$('copy').disabled=false;clearInterval(statsTimer);statsTimer=setInterval(updateStats,2500);updateStats()}catch(e){$('session').textContent=e.message}};$('copy').onclick=async()=>{if(!session)return;const url=new URL(location.href);url.searchParams.set('room',session.id);try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(url.toString());else{const t=document.createElement('textarea');t.value=url.toString();document.body.append(t);t.select();if(!document.execCommand('copy'))throw Error('copy');t.remove()}notify('micstatus','Dars havolasi nusxalandi')}catch{prompt('Havolani nusxalang:',url.toString())}};
async function fetchEvents(){if(!joined)return;try{const r=await fetch('/api/events?id='+encodeURIComponent(joined)+'&since='+seq+'&participant='+encodeURIComponent(participantId)+'&token='+encodeURIComponent(studentToken||''));const d=await r.json();if(!r.ok)throw Error(d.error);for(const e of d.events){seq=Math.max(seq,e.seq);if(e.type==='end')continue;const box=$('studentText');if(box.querySelector('.placeholder'))box.innerHTML='';const p=document.createElement('p');p.textContent='Tarjima qilinmoqda...';box.append(p);try{const out=await translate(e.text,e.lang,$('studentLang').value,e.mode||'free');p.textContent=out;say(out,$('studentLang').value)}catch(err){p.textContent='[Asl matn] '+e.text;notify('joinStatus','Tarjima xizmati mavjud emas: '+err.message)}box.scrollTop=box.scrollHeight}notify('joinStatus','Sessiyaga ulangan · kod '+joined)}catch(e){notify('joinStatus','Ulanish muammosi: '+e.message)}}
$('join').onclick=async()=>{const id=$('joinCode').value.trim();if(!/^\d{6}$/.test(id)){notify('joinStatus','6 xonali kod kiriting');return}try{const r=await fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,participant:participantId,lang:$('studentLang').value,audio:$('speak').checked,action:'join'})});if(!r.ok)throw Error('Sessiya topilmadi yoki server ishlamayapti');studentToken=(await r.json()).token}catch(e){notify('joinStatus',e.message);return}joined=id;seq=0;await presence('join');clearInterval(presenceTimer);presenceTimer=setInterval(()=>presence('heartbeat'),7000);$('studentText').innerHTML='';clearInterval(poll);poll=setInterval(fetchEvents,1800);fetchEvents();$('join').disabled=true;$('leave').disabled=false};$('leave').onclick=()=>{presence('leave');joined=null;studentToken=null;clearInterval(presenceTimer);clearInterval(poll);$('join').disabled=false;$('leave').disabled=true;notify('joinStatus','Sessiyadan chiqildi')};
function tab(t){$('teacher').hidden=t!=='teacher';$('student').hidden=t!=='student';$('teacherTab').classList.toggle('active',t==='teacher');$('studentTab').classList.toggle('active',t==='student')} $('teacherTab').onclick=()=>tab('teacher');$('studentTab').onclick=()=>tab('student');const room=new URL(location.href).searchParams.get('room');if(room){$('joinCode').value=room;tab('student')}
$('boardTranslate').onclick=async()=>{const text=$('board').value.trim();if(!text)return;try{const out=await translate(text,$('source').value,$('target').value);$('board').value=out;notify('translateStatus','Doska/slayd matni tarjima qilindi')}catch(e){notify('translateStatus',e.message)}};$('boardAdd').onclick=()=>addText($('board').value);
$('txt').onclick=()=>{const content=entries.map((e,i)=>`${i+1}. ${e.text}\n${translations[i]||''}`).join('\n\n');const blob=new Blob([$('topic').value+'\n\n'+content],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='LECTOR_KUCHKAROV_mar uza.txt'.replace('mar uza','maruza');a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
$('pdf').onclick=()=>{const bilingual=$('bilingual').checked;const rows=entries.map((e,i)=>`<section><p>${escapeHTML(e.text)}</p>${bilingual&&translations[i]?`<p class="tr">${escapeHTML(translations[i])}</p>`:''}</section>`).join('');const w=window.open('','_blank');if(!w){alert('PDF oynasi bloklangan. Pop-upga ruxsat bering.');return}w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHTML($('topic').value)}</title><style>body{font-family:Arial,'Noto Sans',sans-serif;max-width:800px;margin:35px auto;line-height:1.7;color:#14273d}h1{font-size:23px}small{color:#678}section{border-bottom:1px solid #ddd;padding:9px 0;break-inside:avoid}.tr{color:#2863a0}button{padding:12px;margin-bottom:20px}@media print{button{display:none}body{margin:0}}</style></head><body><button onclick="print()">PDF sifatida saqlash / Print</button><h1>${escapeHTML($('topic').value)}</h1><small>LECTOR TRANSLATE KUCHKAROV · Kuchkarov M.A. · ${new Date().toLocaleDateString()}</small>${rows||'<p>Matn mavjud emas.</p>'}</body></html>`);w.document.close()};
$('source').addEventListener('change',()=>{if(listening){$('stop').click();notify('micstatus','Ma’ruza tili o‘zgardi. Mikrofonni qayta boshlang.')}});$('target').addEventListener('change',()=>{translations=[];render();notify('translateStatus','Tarjima tili o‘zgardi. “Matnni tarjima qilish” tugmasini bosing.')});window.addEventListener('online',()=>notify('net','● Onlayn'));window.addEventListener('offline',()=>notify('net','● Internet yo‘q'));render();

(async()=>{if(location.protocol==='file:'){notify('net','● Fayl rejimi');notify('micstatus','Fayl bevosita ochilgan. Sessiya va tarjima uchun serverni npm start bilan ishga tushiring.');return}try{const r=await fetch('/api/health');if(!r.ok)throw Error();const d=await r.json();notify('net','● Server ulangan');professionalAvailable=!!d.professionalAvailable;notify('translateStatus','Bepul tarjima: '+d.freeProvider+'. Internet va xizmat limitlariga bog‘liq.');notify('modeStatus',professionalAvailable?'Bepul rejim faol. Professional AI ham sozlangan.':'Bepul rejim faol. Professional AI uchun serverda OPENAI_API_KEY talab qilinadi.')}catch{notify('net','● Server ulanmagan');notify('micstatus','Server topilmadi. Dastur papkasida npm start ni ishga tushiring.')}})();


// Interface localization: changes labels only, never speech/translation selections.
const uiTranslations={".hero h1": "Your lecture — in every student’s language.", ".hero p": "Live captions, speech playback, 10 languages, student sessions and PDF lecture notes.", "#teacherTab": "🎙 Teacher", "#studentTab": "🎧 Student", "#teacher h2": "Manage live lesson", "#student h2": "Join a lesson", "#start": "🎙 Start speech", "#stop": "■ Stop", "#teacher h3": "Share with students", "#create": "＋ Create session", "#copy": "🔗 Copy link", "#teacher .panel:nth-child(2) h2": "Lecture transcript", "#add": "＋ Add text", "#clear": "Clear transcript", "#clearBoth":"Clear both", "#clearTranslation":"Clear translation", "#join": "Join lesson", "#leave": "Leave", ".lower .panel:first-child h2": "🌍 Translation panel", "#translateAll": "Translate text", ".lower .panel:last-child h2": "📄 PDF and materials", "#pdf": "⬇ Create PDF", "#txt": "⬇ Download TXT", "#boardTranslate": "Translate", "#boardAdd": "Add to lecture"};
const uiLabelTranslations={"#teacher label:has(#topic)": "Lesson topic", "#teacher label:has(#source)": "Speech language", "#teacher label:has(#target)": "Display / PDF language", "#teacher label:has(#manual)": "Add or edit text manually", "#student label:has(#joinCode)": "6-digit lesson code", "#student label:has(#studentLang)": "Translation language"};
const uiPlaceholders={topic:'Lesson topic',manual:'Type lecture text...',joinCode:'123456',board:'Paste text from the board or slides...'};
const uiStatic=new Map();
function setInterfaceLanguage(language){
 const english=language==='en';document.documentElement.lang=language;
 for(const [selector,englishText] of Object.entries(uiTranslations)){
   const el=document.querySelector(selector);if(!el)continue;
   if(!uiStatic.has(el))uiStatic.set(el,el.textContent);
   el.textContent=english?englishText:uiStatic.get(el);
 }
 for(const [selector,englishText] of Object.entries(uiLabelTranslations)){
   const el=document.querySelector(selector);if(!el)continue;
   const node=Array.from(el.childNodes).find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());
   if(!node)continue;if(!uiStatic.has(node))uiStatic.set(node,node.textContent);
   node.textContent=english?englishText:uiStatic.get(node);
 }
 document.querySelectorAll('[data-i18n="uiLabel"]').forEach(el=>el.textContent=english?'Interface':'Interfeys tili');
 for(const [id,englishText] of Object.entries(uiPlaceholders)){const el=$(id);if(!el)continue;const key='placeholder_'+id;if(!uiStatic.has(key))uiStatic.set(key,el.placeholder);el.placeholder=english?englishText:uiStatic.get(key)}
 const pairs=[['autoTranslate','Automatic translation'],['speak','🔊 Read aloud'],['bilingual','Include original and translated text in PDF']];
 for(const [id,value] of pairs){const input=$(id);const label=input?.closest('label');if(!label)continue;const node=Array.from(label.childNodes).find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());if(!node)continue;if(!uiStatic.has(node))uiStatic.set(node,node.textContent);node.textContent=english?' '+value:uiStatic.get(node)}
 try{localStorage.setItem('lector_ui_language',language)}catch{}
}
$('uiLang').addEventListener('change',e=>setInterfaceLanguage(e.target.value));
try{$('uiLang').value=localStorage.getItem('lector_ui_language')==='en'?'en':'uz'}catch{$('uiLang').value='uz'}
setInterfaceLanguage($('uiLang').value);

$('studentLang').addEventListener('change',()=>presence('heartbeat'));$('speak').addEventListener('change',()=>presence('heartbeat'));window.addEventListener('pagehide',()=>{if(joined)navigator.sendBeacon?.('/api/presence',new Blob([JSON.stringify({id:joined,participant:participantId,token:studentToken,action:'leave'})],{type:'application/json'}))});

const diagnostics=document.getElementById('diagnostics');if(diagnostics){const ids=['teacherTab','studentTab','uiLang','source','target','studentLang','start','stop','create','copy','join','leave','add','clear','translateAll','boardTranslate','boardAdd','pdf','txt'];const missing=ids.filter(id=>!document.getElementById(id));diagnostics.textContent=missing.length?'Missing controls: '+missing.join(', '):'19 ta boshqaruv elementi yuklandi. Server va tarjima xizmati alohida tekshiriladi.';}

$('translationMode').addEventListener('change',async()=>{const next=$('translationMode').value;if(next==='professional'&&!professionalAvailable){$('translationMode').value=activeMode;notify('modeStatus','Professional AI ulanmagan. Serverda OPENAI_API_KEY sozlash kerak.');return}if(next==='professional'&&!session){$('translationMode').value=activeMode;notify('modeStatus','Professional AI uchun avval sessiya yarating.');return}if(session){try{const r=await fetch('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:session.id,key:session.key,mode:next})});const j=await r.json();if(!r.ok)throw Error(j.error||'Rejim almashtirilmadi')}catch(e){$('translationMode').value=activeMode;notify('modeStatus',e.message);return}}activeMode=next;notify('modeStatus',next==='free'?'Bepul rejim faol':'Professional AI faol: API xarajati yuzaga kelishi mumkin.');});

// V18: boshqaruv ishlashini brauzerda tekshirish uchun ochiq diagnostika.
window.lectorDiagnostics=()=>({version:'22',startBound:typeof $('start').onclick==='function',addBound:typeof $('add').onclick==='function',recognitionSupported:!!(window.SpeechRecognition||window.webkitSpeechRecognition),secureContext:window.isSecureContext,entries:entries.length,recognitionRunning,listening,micLastError,micLastEvent,micLastResultAt,micLastStartAt,micLastEndAt,micRetryCount});
