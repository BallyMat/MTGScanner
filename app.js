const ids=['cameraInput','preview','ocrStatus','cardNameInput','searchButton','suggestions','resultsCard','resultsTitle','results','finishFilter','collectionList','collectionSearch','exportButton','totalCards','uniqueCards','totalValue','addDialog','dialogImage','dialogName','dialogSet','dialogFinish','dialogCondition','dialogQuantity','dialogLocation','dialogPrice','confirmAdd','soundToggle','resultTemplate','cameraVideo','captureCanvas','startScanner','stopScanner','scannerBadge','scanFlash','cameraPlaceholder','lastDetection'];
const els=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));

let currentPrintings=[];
let selectedPrinting=null;
let stream=null;
let scanTimer=null;
let scanning=false;
let processing=false;
let resumeAfterDialog=false;
let lastDetected='';
let lastDetectedAt=0;
let soundEnabled=JSON.parse(localStorage.getItem('mtg-sound-enabled')??'true');
let inventory=JSON.parse(localStorage.getItem('mtg-inventory')??'[]');

const fmtEUR=value=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(Number(value||0));
const safeText=v=>(v??'').toString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function setScannerState(state,text){
  els.scannerBadge.className=`scanner-badge ${state}`;
  els.scannerBadge.textContent=text;
}

function saveInventory(){
  localStorage.setItem('mtg-inventory',JSON.stringify(inventory));
  renderCollection();
  renderStats();
}

function getImage(card){
  return card.image_uris?.normal||card.card_faces?.[0]?.image_uris?.normal||'';
}

function availableFinishes(card){
  const finishes=[];
  if(card.nonfoil) finishes.push({key:'nonfoil',label:'Normale',price:Number(card.prices?.eur||card.prices?.usd||0)});
  if(card.foil) finishes.push({key:'foil',label:'Foil',price:Number(card.prices?.eur_foil||card.prices?.usd_foil||0)});
  if(card.finishes?.includes('etched')) finishes.push({key:'etched',label:'Etched',price:Number(card.prices?.eur_etched||card.prices?.usd_etched||0)});
  return finishes.length?finishes:[{key:'nonfoil',label:'Normale',price:Number(card.prices?.eur||card.prices?.usd||0)}];
}

async function startCamera(){
  if(stream) return;
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false
    });
    els.cameraVideo.srcObject=stream;
    await els.cameraVideo.play();
    els.cameraPlaceholder.classList.add('hidden');
    els.startScanner.classList.add('hidden');
    els.stopScanner.classList.remove('hidden');
    scanning=true;
    setScannerState('active','En attente');
    els.ocrStatus.textContent='Présente une carte entière, bien droite et sans reflet.';
    scheduleNextScan(700);
  }catch(err){
    console.error(err);
    setScannerState('error','Caméra refusée');
    els.ocrStatus.textContent='Impossible d’ouvrir la caméra. Vérifie l’autorisation caméra dans Safari.';
  }
}

function stopCamera(){
  scanning=false;
  processing=false;
  clearTimeout(scanTimer);
  scanTimer=null;
  stream?.getTracks().forEach(track=>track.stop());
  stream=null;
  els.cameraVideo.srcObject=null;
  els.cameraPlaceholder.classList.remove('hidden');
  els.startScanner.classList.remove('hidden');
  els.stopScanner.classList.add('hidden');
  setScannerState('idle','Arrêté');
  els.ocrStatus.textContent='Caméra arrêtée.';
}

function scheduleNextScan(delay=1100){
  clearTimeout(scanTimer);
  if(scanning&&!processing) scanTimer=setTimeout(scanCurrentFrame,delay);
}

function captureFullCard(){
  const video=els.cameraVideo;
  if(!video.videoWidth||!video.videoHeight) return null;
  const canvas=els.captureCanvas;
  const maxWidth=900;
  const scale=Math.min(1,maxWidth/video.videoWidth);
  canvas.width=Math.round(video.videoWidth*scale);
  canvas.height=Math.round(video.videoHeight*scale);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  return canvas;
}

function makeRegion(source,x,y,w,h,scale=1.5){
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(w*scale));
  canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.filter='grayscale(1) contrast(1.8)';
  ctx.drawImage(source,x,y,w,h,0,0,canvas.width,canvas.height);
  return canvas;
}

function cleanOCRLines(text){
  return text.split(/\r?\n/)
    .map(s=>s.replace(/[^A-Za-z0-9À-ÿ',.\-: /]/g,' ').replace(/\s+/g,' ').trim())
    .filter(Boolean);
}

function extractSignals(titleText,bottomText){
  const titleLines=cleanOCRLines(titleText).filter(s=>s.length>=2&&s.length<=50);
  const bottomLines=cleanOCRLines(bottomText);
  const collectionMatches=bottomLines.join(' ').match(/(?:^|\s)(\d{1,4}[A-Za-z]?)\s*\/\s*(\d{1,4})/g)||[];
  const collectorNumbers=[...new Set(collectionMatches.map(v=>v.match(/(\d{1,4}[A-Za-z]?)/)?.[1]).filter(Boolean))];
  const languageHints=[];
  const joined=`${titleText} ${bottomText}`;
  if(/[À-ÿ]/.test(joined)) languageHints.push('fr');
  if(/©|Wizards|Illustrated by|Illus\./i.test(joined)) languageHints.push('en');
  return {titleCandidates:titleLines.slice(0,6),collectorNumbers,rawBottom:bottomLines.slice(0,8),languageHints};
}

async function recognizeFrame(canvas){
  const w=canvas.width,h=canvas.height;
  const titleRegion=makeRegion(canvas,w*.12,h*.08,w*.76,h*.16,2);
  const bottomRegion=makeRegion(canvas,w*.08,h*.72,w*.84,h*.23,1.8);
  const [titleResult,bottomResult]=await Promise.all([
    Tesseract.recognize(titleRegion,'eng+fra'),
    Tesseract.recognize(bottomRegion,'eng+fra')
  ]);
  return extractSignals(titleResult.data.text,bottomResult.data.text);
}

async function findCandidates(signals){
  const candidates=[];
  for(const title of signals.titleCandidates.slice(0,3)){
    const response=await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(title)}`);
    if(!response.ok) continue;
    const base=await response.json();
    let next=base.prints_search_uri;
    while(next){
      const page=await fetch(next);
      if(!page.ok) break;
      const data=await page.json();
      candidates.push(...(data.data||[]));
      next=data.has_more?data.next_page:null;
    }
    if(candidates.length) return {base,candidates};
  }
  return null;
}

function scoreCandidate(card,signals){
  let score=0;
  const collector=String(card.collector_number||'').toLowerCase();
  if(signals.collectorNumbers.some(n=>collector===String(n).toLowerCase())) score+=80;
  else if(signals.collectorNumbers.some(n=>collector.startsWith(String(n).toLowerCase()))) score+=35;
  if(signals.languageHints.includes(card.lang)) score+=12;
  if(card.border_color==='borderless') score+=card.full_art?4:0;
  if(card.frame_effects?.length) score+=3;
  if(card.promo) score-=2;
  return score;
}

function rankCandidates(cards,signals){
  return cards.map(card=>({card,score:scoreCandidate(card,signals)}))
    .sort((a,b)=>b.score-a.score||new Date(b.card.released_at)-new Date(a.card.released_at));
}

async function scanCurrentFrame(){
  if(!scanning||processing||els.addDialog.open) return;
  processing=true;
  setScannerState('processing','Analyse');
  els.ocrStatus.textContent='Analyse du nom, du numéro de collection et du bas de la carte…';
  try{
    const frame=captureFullCard();
    if(!frame) throw new Error('Image caméra indisponible');
    const signals=await recognizeFrame(frame);
    if(!signals.titleCandidates.length){
      els.ocrStatus.textContent='Aucun nom lisible. Rapproche la carte et évite les reflets.';
      return;
    }
    const found=await findCandidates(signals);
    if(!found){
      els.ocrStatus.textContent=`Lecture incertaine : ${signals.titleCandidates[0]}. Essaie de stabiliser la carte.`;
      return;
    }
    const now=Date.now();
    if(found.base.name===lastDetected&&now-lastDetectedAt<5000){
      els.ocrStatus.textContent=`${found.base.name} déjà détectée. Présente une autre carte.`;
      return;
    }
    lastDetected=found.base.name;
    lastDetectedAt=now;
    const ranked=rankCandidates(found.candidates,signals);
    currentPrintings=ranked.map(r=>r.card);
    els.cardNameInput.value=found.base.name;
    els.resultsTitle.textContent=`${found.base.name} — ${currentPrintings.length} version${currentPrintings.length>1?'s':''}`;
    els.resultsCard.classList.remove('hidden');
    renderResults(ranked);
    els.scanFlash.classList.add('visible');
    setTimeout(()=>els.scanFlash.classList.remove('visible'),350);
    navigator.vibrate?.(80);
    els.lastDetection.classList.remove('hidden');
    els.lastDetection.innerHTML=`<strong>${safeText(found.base.name)}</strong><span>${signals.collectorNumbers.length?`Numéro lu : ${safeText(signals.collectorNumbers.join(', '))}`:'Numéro non lu'} · ${ranked[0]?.score||0} points de confiance</span>`;
    els.ocrStatus.textContent='Carte reconnue. Vérifie la version proposée puis ajoute-la.';
    resumeAfterDialog=true;
    if(ranked[0]?.score>=80) openAddDialog(ranked[0].card,true);
    else els.resultsCard.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){
    console.error(err);
    els.ocrStatus.textContent='Analyse impossible. Maintiens la carte stable et réessaie.';
  }finally{
    processing=false;
    if(scanning&&!els.addDialog.open){setScannerState('active','En attente');scheduleNextScan(1200);}
  }
}

async function runOCR(file){
  els.preview.src=URL.createObjectURL(file);
  els.preview.classList.remove('hidden');
  els.ocrStatus.textContent='Analyse de la photo complète…';
  const img=new Image();
  img.src=els.preview.src;
  await img.decode();
  const canvas=els.captureCanvas;
  const scale=Math.min(1,1200/img.naturalWidth);
  canvas.width=Math.round(img.naturalWidth*scale);
  canvas.height=Math.round(img.naturalHeight*scale);
  canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
  const signals=await recognizeFrame(canvas);
  const found=await findCandidates(signals);
  if(!found){els.ocrStatus.textContent='Carte non reconnue. Essaie la recherche manuelle.';return;}
  const ranked=rankCandidates(found.candidates,signals);
  currentPrintings=ranked.map(r=>r.card);
  els.cardNameInput.value=found.base.name;
  els.resultsTitle.textContent=`${found.base.name} — ${currentPrintings.length} versions`;
  els.resultsCard.classList.remove('hidden');
  renderResults(ranked);
}

async function searchCard(name){
  name=(name||els.cardNameInput.value).trim();
  if(!name) return;
  els.searchButton.disabled=true;
  els.searchButton.textContent='Recherche…';
  els.resultsCard.classList.remove('hidden');
  els.results.innerHTML='<p class="muted">Recherche de toutes les impressions…</p>';
  try{
    const exact=await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if(!exact.ok) throw new Error('Carte introuvable');
    const base=await exact.json();
    let next=base.prints_search_uri;
    const cards=[];
    while(next){
      const page=await fetch(next);const data=await page.json();cards.push(...(data.data||[]));next=data.has_more?data.next_page:null;
    }
    currentPrintings=cards;
    els.resultsTitle.textContent=`${base.name} — ${cards.length} version${cards.length>1?'s':''}`;
    renderResults();
  }catch(err){
    els.results.innerHTML='<p class="muted">Carte introuvable. Vérifie l’orthographe ou essaie le nom anglais.</p>';
  }finally{
    els.searchButton.disabled=false;els.searchButton.textContent='Rechercher';
  }
}

function renderResults(ranked=null){
  const filter=els.finishFilter.value;
  const scores=new Map((ranked||[]).map(r=>[r.card.id,r.score]));
  const cards=currentPrintings.filter(c=>filter==='all'||availableFinishes(c).some(f=>f.key===filter));
  if(!ranked) cards.sort((a,b)=>new Date(b.released_at)-new Date(a.released_at));
  els.results.innerHTML='';
  for(const card of cards){
    const node=els.resultTemplate.content.cloneNode(true);
    const img=node.querySelector('img');img.src=getImage(card);img.alt=`${card.name}, ${card.set_name}`;
    node.querySelector('h3').textContent=card.set_name;
    const score=scores.get(card.id);
    node.querySelector('.set-line').textContent=`${card.released_at?.slice(0,4)||''} · n° ${card.collector_number}${score!==undefined?` · confiance ${score}`:''}`;
    const finishes=availableFinishes(card);
    node.querySelector('.variant-line').textContent=[...finishes.map(f=>f.label),card.lang?.toUpperCase(),card.frame_effects?.join(', ')].filter(Boolean).join(' · ');
    const prices=finishes.map(f=>f.price).filter(v=>v>0);
    node.querySelector('.price').textContent=prices.length?`Dès ${fmtEUR(Math.min(...prices))}`:'Prix indisponible';
    node.querySelector('button').onclick=()=>openAddDialog(card,false);
    els.results.appendChild(node);
  }
  if(!cards.length) els.results.innerHTML='<p class="muted">Aucune version correspondant à ce filtre.</p>';
}

function openAddDialog(card,automatic=false){
  selectedPrinting=card;
  resumeAfterDialog=scanning;
  clearTimeout(scanTimer);
  els.dialogImage.src=getImage(card);
  els.dialogName.textContent=card.name;
  els.dialogSet.textContent=`${card.set_name} · n° ${card.collector_number}${automatic?' · meilleure correspondance':''}`;
  els.dialogFinish.innerHTML=availableFinishes(card).map(f=>`<option value="${f.key}" data-price="${f.price}">${f.label}</option>`).join('');
  els.dialogQuantity.value=1;els.dialogLocation.value='';updateDialogPrice();els.addDialog.showModal();
}

function updateDialogPrice(){
  const opt=els.dialogFinish.selectedOptions[0];
  const price=Number(opt?.dataset.price||0);const qty=Math.max(1,Number(els.dialogQuantity.value||1));
  els.dialogPrice.textContent=price?fmtEUR(price*qty):'Indisponible';
}

function addSelected(){
  const opt=els.dialogFinish.selectedOptions[0];
  const finish=opt.value;const unitPrice=Number(opt.dataset.price||0);const qty=Math.max(1,Number(els.dialogQuantity.value||1));
  const key=`${selectedPrinting.id}-${finish}-${els.dialogCondition.value}-${els.dialogLocation.value.trim()}`;
  const existing=inventory.find(i=>i.key===key);
  if(existing) existing.quantity+=qty;
  else inventory.push({key,scryfallId:selectedPrinting.id,name:selectedPrinting.name,setName:selectedPrinting.set_name,setCode:selectedPrinting.set,collectorNumber:selectedPrinting.collector_number,image:getImage(selectedPrinting),finish,finishLabel:opt.textContent,condition:els.dialogCondition.value,location:els.dialogLocation.value.trim(),quantity:qty,unitPrice,addedAt:new Date().toISOString()});
  saveInventory();playValueSound(unitPrice);els.addDialog.close();
  els.ocrStatus.textContent=`${selectedPrinting.name} ajoutée. Présente la carte suivante.`;
  if(resumeAfterDialog&&scanning){setScannerState('active','En attente');scheduleNextScan(900);}
}

function renderCollection(){
  const q=els.collectionSearch.value.toLowerCase().trim();
  const items=inventory.filter(i=>`${i.name} ${i.setName} ${i.location}`.toLowerCase().includes(q));
  els.collectionList.innerHTML='';
  if(!items.length){els.collectionList.innerHTML='<p class="muted">Aucune carte enregistrée.</p>';return;}
  items.sort((a,b)=>(b.unitPrice*b.quantity)-(a.unitPrice*a.quantity));
  items.forEach(item=>{
    const row=document.createElement('article');row.className='collection-item';
    row.innerHTML=`<img src="${item.image}" alt="${safeText(item.name)}"><div><h3>${safeText(item.name)}</h3><p>${safeText(item.setName)} · n° ${safeText(item.collectorNumber)}</p><p>${safeText(item.finishLabel)} · ${safeText(item.condition)} · quantité ${item.quantity}</p>${item.location?`<p>📍 ${safeText(item.location)}</p>`:''}<button class="delete-btn">Supprimer</button></div><div class="value">${item.unitPrice?fmtEUR(item.unitPrice*item.quantity):'—'}</div>`;
    row.querySelector('.delete-btn').onclick=()=>{if(confirm('Supprimer cette entrée ?')){inventory=inventory.filter(i=>i.key!==item.key);saveInventory();}};
    els.collectionList.appendChild(row);
  });
}

function renderStats(){
  els.totalCards.textContent=inventory.reduce((s,i)=>s+i.quantity,0);
  els.uniqueCards.textContent=inventory.length;
  els.totalValue.textContent=fmtEUR(inventory.reduce((s,i)=>s+i.unitPrice*i.quantity,0));
}

function playValueSound(value){
  if(!soundEnabled) return;
  const ctx=new (window.AudioContext||window.webkitAudioContext)();const now=ctx.currentTime;
  const seq=value<1?[[520,.05,.08]]:value<5?[[520,0,.10],[660,.14,.12]]:value<20?[[440,0,.10],[554,.13,.10],[660,.26,.15]]:value<100?[[440,0,.09],[554,.11,.09],[660,.22,.09],[880,.34,.22]]:[[392,0,.10],[523,.12,.10],[659,.24,.10],[784,.36,.10],[1046,.50,.34]];
  seq.forEach(([freq,offset,dur],idx)=>{const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type=value>=20?'triangle':'sine';osc.frequency.value=freq;const volume=Math.min(.32,.08+idx*.035+(value>=100?.08:0));gain.gain.setValueAtTime(.0001,now+offset);gain.gain.exponentialRampToValueAtTime(volume,now+offset+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+offset+dur);osc.connect(gain);gain.connect(ctx.destination);osc.start(now+offset);osc.stop(now+offset+dur+.02);});
}

function exportCSV(){
  const headers=['Nom','Extension','Code','Numéro','Finition','État','Quantité','Emplacement','Prix unitaire EUR','Valeur totale EUR'];
  const rows=inventory.map(i=>[i.name,i.setName,i.setCode,i.collectorNumber,i.finishLabel,i.condition,i.quantity,i.location,i.unitPrice,i.unitPrice*i.quantity]);
  const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(';')).join('\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='inventaire-mtg.csv';a.click();URL.revokeObjectURL(a.href);
}

els.startScanner.onclick=startCamera;
els.stopScanner.onclick=stopCamera;
els.cameraInput.onchange=e=>e.target.files[0]&&runOCR(e.target.files[0]);
els.searchButton.onclick=()=>searchCard();
els.cardNameInput.addEventListener('keydown',e=>{if(e.key==='Enter')searchCard();});
els.finishFilter.onchange=()=>renderResults();
els.dialogFinish.onchange=updateDialogPrice;
els.dialogQuantity.oninput=updateDialogPrice;
els.confirmAdd.onclick=addSelected;
els.collectionSearch.oninput=renderCollection;
els.exportButton.onclick=exportCSV;
els.soundToggle.onclick=()=>{soundEnabled=!soundEnabled;localStorage.setItem('mtg-sound-enabled',JSON.stringify(soundEnabled));els.soundToggle.textContent=soundEnabled?'🔊':'🔇';};
els.soundToggle.textContent=soundEnabled?'🔊':'🔇';
els.addDialog.addEventListener('close',()=>{if(resumeAfterDialog&&scanning){setScannerState('active','En attente');scheduleNextScan(900);}});
document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t===tab));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===tab.dataset.target));});
window.addEventListener('pagehide',stopCamera);
if('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
renderCollection();renderStats();
