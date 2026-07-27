const els = Object.fromEntries([
  'cameraInput','preview','ocrStatus','cardNameInput','searchButton','suggestions','resultsCard','resultsTitle','results','finishFilter','collectionList','collectionSearch','exportButton','totalCards','uniqueCards','totalValue','addDialog','dialogImage','dialogName','dialogSet','dialogFinish','dialogCondition','dialogQuantity','dialogLocation','dialogPrice','confirmAdd','soundToggle','resultTemplate'
].map(id=>[id,document.getElementById(id)]));

let currentPrintings = [];
let selectedPrinting = null;
let soundEnabled = JSON.parse(localStorage.getItem('mtg-sound-enabled') ?? 'true');
let inventory = JSON.parse(localStorage.getItem('mtg-inventory') ?? '[]');

const fmtEUR = value => new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(Number(value||0));
const safeText = v => (v ?? '').toString();

function saveInventory(){
  localStorage.setItem('mtg-inventory', JSON.stringify(inventory));
  renderCollection();
  renderStats();
}

function getImage(card){
  return card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || '';
}

function availableFinishes(card){
  const finishes=[];
  if(card.nonfoil) finishes.push({key:'nonfoil',label:'Normale',price:Number(card.prices?.eur||card.prices?.usd||0)});
  if(card.foil) finishes.push({key:'foil',label:'Foil',price:Number(card.prices?.eur_foil||card.prices?.usd_foil||0)});
  if(card.finishes?.includes('etched')) finishes.push({key:'etched',label:'Etched',price:Number(card.prices?.eur_etched||card.prices?.usd_etched||0)});
  return finishes.length ? finishes : [{key:'nonfoil',label:'Normale',price:Number(card.prices?.eur||card.prices?.usd||0)}];
}

async function runOCR(file){
  els.preview.src = URL.createObjectURL(file);
  els.preview.classList.remove('hidden');
  els.ocrStatus.classList.remove('hidden');
  els.ocrStatus.textContent = 'Lecture du nom de la carte…';
  try{
    const result = await Tesseract.recognize(file,'eng',{logger:m=>{
      if(m.status==='recognizing text') els.ocrStatus.textContent=`Reconnaissance… ${Math.round(m.progress*100)} %`;
    }});
    const lines = result.data.text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const candidates = lines
      .map(s=>s.replace(/[^A-Za-z0-9',.\-: ]/g,'').trim())
      .filter(s=>s.length>=2 && s.length<=45)
      .slice(0,8);
    if(candidates.length){
      els.cardNameInput.value = candidates[0];
      els.suggestions.innerHTML = candidates.map(c=>`<button type="button">${c}</button>`).join('');
      [...els.suggestions.querySelectorAll('button')].forEach(btn=>btn.onclick=()=>{els.cardNameInput.value=btn.textContent;searchCard(btn.textContent)});
      els.ocrStatus.textContent='Nom détecté. Vérifie-le puis lance la recherche.';
      searchCard(candidates[0]);
    }else{
      els.ocrStatus.textContent='Nom non reconnu. Saisis-le manuellement.';
    }
  }catch(err){
    console.error(err);
    els.ocrStatus.textContent='La reconnaissance a échoué. Saisis le nom manuellement.';
  }
}

async function searchCard(name){
  name = (name||els.cardNameInput.value).trim();
  if(!name) return;
  els.searchButton.disabled=true;
  els.searchButton.textContent='Recherche…';
  els.resultsCard.classList.remove('hidden');
  els.results.innerHTML='<p class="muted">Recherche de toutes les impressions…</p>';
  try{
    const exact = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if(!exact.ok) throw new Error('Carte introuvable');
    const base = await exact.json();
    const prints = await fetch(base.prints_search_uri);
    const data = await prints.json();
    currentPrintings = data.data || [];
    els.resultsTitle.textContent = `${base.name} — ${currentPrintings.length} version${currentPrintings.length>1?'s':''}`;
    renderResults();
  }catch(err){
    els.results.innerHTML=`<p class="muted">Carte introuvable. Vérifie l’orthographe ou essaie le nom anglais.</p>`;
  }finally{
    els.searchButton.disabled=false;
    els.searchButton.textContent='Rechercher';
  }
}

function renderResults(){
  const filter=els.finishFilter.value;
  els.results.innerHTML='';
  const cards=currentPrintings.filter(c=>filter==='all'||availableFinishes(c).some(f=>f.key===filter));
  cards.sort((a,b)=>new Date(b.released_at)-new Date(a.released_at));
  for(const card of cards){
    const node=els.resultTemplate.content.cloneNode(true);
    const img=node.querySelector('img');
    img.src=getImage(card); img.alt=`${card.name}, ${card.set_name}`;
    node.querySelector('h3').textContent=card.set_name;
    node.querySelector('.set-line').textContent=`${card.released_at?.slice(0,4)||''} · n° ${card.collector_number}`;
    const finishes=availableFinishes(card);
    node.querySelector('.variant-line').textContent=finishes.map(f=>f.label).join(' · ');
    const prices=finishes.map(f=>f.price).filter(v=>v>0);
    node.querySelector('.price').textContent=prices.length?`Dès ${fmtEUR(Math.min(...prices))}`:'Prix indisponible';
    node.querySelector('button').onclick=()=>openAddDialog(card);
    els.results.appendChild(node);
  }
  if(!cards.length) els.results.innerHTML='<p class="muted">Aucune version correspondant à ce filtre.</p>';
}

function openAddDialog(card){
  selectedPrinting=card;
  els.dialogImage.src=getImage(card);
  els.dialogName.textContent=card.name;
  els.dialogSet.textContent=`${card.set_name} · n° ${card.collector_number}`;
  els.dialogFinish.innerHTML=availableFinishes(card).map(f=>`<option value="${f.key}" data-price="${f.price}">${f.label}</option>`).join('');
  els.dialogQuantity.value=1;
  els.dialogLocation.value='';
  updateDialogPrice();
  els.addDialog.showModal();
}

function updateDialogPrice(){
  const opt=els.dialogFinish.selectedOptions[0];
  const price=Number(opt?.dataset.price||0);
  const qty=Math.max(1,Number(els.dialogQuantity.value||1));
  els.dialogPrice.textContent=price?fmtEUR(price*qty):'Indisponible';
}

function addSelected(){
  const opt=els.dialogFinish.selectedOptions[0];
  const finish=opt.value;
  const unitPrice=Number(opt.dataset.price||0);
  const qty=Math.max(1,Number(els.dialogQuantity.value||1));
  const key=`${selectedPrinting.id}-${finish}-${els.dialogCondition.value}-${els.dialogLocation.value.trim()}`;
  const existing=inventory.find(i=>i.key===key);
  if(existing) existing.quantity+=qty;
  else inventory.push({
    key, scryfallId:selectedPrinting.id, name:selectedPrinting.name, setName:selectedPrinting.set_name,
    setCode:selectedPrinting.set, collectorNumber:selectedPrinting.collector_number, image:getImage(selectedPrinting),
    finish, finishLabel:opt.textContent, condition:els.dialogCondition.value, location:els.dialogLocation.value.trim(),
    quantity:qty, unitPrice, addedAt:new Date().toISOString()
  });
  saveInventory();
  playValueSound(unitPrice);
  els.addDialog.close();
  document.querySelector('[data-target="collectionView"]').click();
}

function renderCollection(){
  const q=els.collectionSearch.value.toLowerCase().trim();
  const items=inventory.filter(i=>`${i.name} ${i.setName} ${i.location}`.toLowerCase().includes(q));
  els.collectionList.innerHTML='';
  if(!items.length){els.collectionList.innerHTML='<p class="muted">Aucune carte enregistrée.</p>';return}
  items.sort((a,b)=>(b.unitPrice*b.quantity)-(a.unitPrice*a.quantity));
  items.forEach(item=>{
    const row=document.createElement('article');row.className='collection-item';
    row.innerHTML=`<img src="${item.image}" alt="${safeText(item.name)}"><div><h3>${safeText(item.name)}</h3><p>${safeText(item.setName)} · n° ${safeText(item.collectorNumber)}</p><p>${safeText(item.finishLabel)} · ${safeText(item.condition)} · quantité ${item.quantity}</p>${item.location?`<p>📍 ${safeText(item.location)}</p>`:''}<button class="delete-btn">Supprimer</button></div><div class="value">${item.unitPrice?fmtEUR(item.unitPrice*item.quantity):'—'}</div>`;
    row.querySelector('.delete-btn').onclick=()=>{if(confirm('Supprimer cette entrée ?')){inventory=inventory.filter(i=>i.key!==item.key);saveInventory()}};
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
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  const now=ctx.currentTime;
  const sequences = value<1 ? [[520,.05,.08]]
    : value<5 ? [[520,0,.10],[660,.14,.12]]
    : value<20 ? [[440,0,.10],[554,.13,.10],[660,.26,.15]]
    : value<100 ? [[440,0,.09],[554,.11,.09],[660,.22,.09],[880,.34,.22]]
    : [[392,0,.10],[523,.12,.10],[659,.24,.10],[784,.36,.10],[1046,.50,.34]];
  sequences.forEach(([freq,offset,dur],idx)=>{
    const osc=ctx.createOscillator(); const gain=ctx.createGain();
    osc.type=value>=20?'triangle':'sine'; osc.frequency.value=freq;
    const volume=Math.min(.32,.08+idx*.035+(value>=100?.08:0));
    gain.gain.setValueAtTime(.0001,now+offset);gain.gain.exponentialRampToValueAtTime(volume,now+offset+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+offset+dur);
    osc.connect(gain);gain.connect(ctx.destination);osc.start(now+offset);osc.stop(now+offset+dur+.02);
  });
}

function exportCSV(){
  const headers=['Nom','Extension','Code','Numéro','Finition','État','Quantité','Emplacement','Prix unitaire EUR','Valeur totale EUR'];
  const rows=inventory.map(i=>[i.name,i.setName,i.setCode,i.collectorNumber,i.finishLabel,i.condition,i.quantity,i.location,i.unitPrice,(i.unitPrice*i.quantity)]);
  const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(';')).join('\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='inventaire-mtg.csv';a.click();URL.revokeObjectURL(a.href);
}

els.cameraInput.onchange=e=>e.target.files[0]&&runOCR(e.target.files[0]);
els.searchButton.onclick=()=>searchCard();
els.cardNameInput.addEventListener('keydown',e=>{if(e.key==='Enter')searchCard()});
els.finishFilter.onchange=renderResults;
els.dialogFinish.onchange=updateDialogPrice;els.dialogQuantity.oninput=updateDialogPrice;
els.confirmAdd.onclick=addSelected;els.collectionSearch.oninput=renderCollection;els.exportButton.onclick=exportCSV;
els.soundToggle.onclick=()=>{soundEnabled=!soundEnabled;localStorage.setItem('mtg-sound-enabled',JSON.stringify(soundEnabled));els.soundToggle.textContent=soundEnabled?'🔊':'🔇'};
els.soundToggle.textContent=soundEnabled?'🔊':'🔇';

document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t===tab));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===tab.dataset.target))});

if('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
renderCollection();renderStats();
