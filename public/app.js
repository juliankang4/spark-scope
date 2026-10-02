import { COLORS, nodeOrder, linkText, unknown, finite, fixed, compact, duration, tokenRate, memory, memoryUnit, temperature, temperatureUnit, escapeHtml as esc, clockTime, eventTime, localDay, monthLabel, monthName, dayLabel, monthOptions, systemStateText, roleName, chartPath, validateMonth, fabricLayout, labelWidth, nextTheme, topologyKey, staleAfterMs, livePoint, mergeLivePoint, timeoutSignal, onMediaChange } from './view-data.js';
import { parseSettings, loadSettings, saveSettings, loadTheme, saveTheme, settingsQuery, settingsFromQuery, withoutSettingsQuery } from './settings.js';
import { t, setLanguage, translatePage, serverText, LANGUAGE_NAMES } from './i18n.js';
const $ = selector => document.querySelector(selector);
// Display settings (units, clock, chart range, refresh, language) from this browser; a settings link replaces them
// and is then taken out of the address, so a reload does not apply it again.
const store=(()=>{try{return window.localStorage}catch{return null}})();
let settings=loadSettings(store),themeChoice=loadTheme(store);
const linked=settingsFromQuery(location.search);
if(linked){settings=linked.settings;themeChoice=linked.theme;saveSettings(store,settings);saveTheme(store,themeChoice);window.history.replaceState(null,'',location.pathname+withoutSettingsQuery(location.search)+location.hash)}
// The page's fixed text in the chosen language; each language's name in the settings is written in that language.
setLanguage(settings.lang);translatePage();document.querySelectorAll('[data-language-name]').forEach(el=>{el.textContent=LANGUAGE_NAMES[el.dataset.languageName]});
const hour12=()=>settings.clock==='12';
const clock=(value,options={})=>clockTime(value,{...options,hour12:hour12()});
let latest = null, shown = null, metas = [], lastTopology = null, range = settings.range, collecting = false, monthSequence = 0, monthLoadedAt = 0, monthController = null;
// The full history is fetched every 30 s and when the range changes; polls in between add their own sample to it.
const HISTORY_REFRESH_MS = 30_000;
let history = [], historyAt = 0, historyRange = null;
// The token ledger counts days in the server's time zone (usage.timeZone); until the first response, the viewer's own.
let ledgerTimeZone = null;
const ledgerToday = () => localDay(Date.now(), ledgerTimeZone);
// Until the server names its ledger time zone, the month is a guess; it follows the server's month unless picked by hand.
let selectedMonth = ledgerToday().slice(0,7), earliestMonth = null, monthPicked = false;
// Unchanged text is left alone, so live regions only speak when something actually changes.
function text(selector, value) { const el = $(selector); if (el.textContent !== value) el.textContent = value; el.classList.toggle('unknown-value', value === unknown() || value === t('common.stopped')); }
// Theme: follows the system until picked; the button cycles through the other look, the system's look and back to system.
const themeToggle=$('#theme-toggle'),darkQuery=matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const system=darkQuery.matches?'dark':'light',next=nextTheme(themeChoice,system);
  document.documentElement.dataset.theme=themeChoice??system;themeToggle.dataset.choice=themeChoice??'system';
  themeToggle.title=t('theme.title',{theme:themeChoice?t(`theme.current.${themeChoice}`):t('theme.current.system',{system:t(`theme.current.${system}`)}),next:t(`theme.next.${next??'system'}`)});themeToggle.setAttribute('aria-label',themeToggle.title);
}
themeToggle.addEventListener('click',()=>{themeChoice=nextTheme(themeChoice,darkQuery.matches?'dark':'light');saveTheme(store,themeChoice);applyTheme();syncForm()});
onMediaChange(darkQuery,applyTheme);applyTheme();

// Badge colours follow the node's state, the same way the rack panel colours its bays.
const BADGE_LEVELS={serving:'good',idle:'idle',noGpuData:'warn',noResponse:'crit',notCollected:'idle'};
// One card per node in topology order; rebuilt when anything in topology.json changes on the server.
let nodesKey=null;
function syncNodes(next) {
  const key=topologyKey(next);if(nodesKey===key)return;
  nodesKey=key;metas=next;$('#nodes').dataset.count=metas.length<=6?String(metas.length):'many';
  $('#brand-count').textContent=metas.length>1?`× ${metas.length}`:'';buildNodes();
}
// Sensors and the TP rank are shown only when a node reports them; ACPI zones keep their firmware names.
const extraFields=()=>[[t('node.freeDisk'),'disk'],[t('node.processMemory'),'process-memory'],[t('node.cpuLoad'),'cpu',true],['NVMe','nvme',true],['NIC','nic',true],[t('node.system'),'system'],['TP rank','rank',true]];
function cardHtml(meta) {
  const u=unknown();
  return `<article class="node" data-node-id="${esc(meta.id)}"><header><h2 data-node="title">${esc(meta.name)}</h2><span class="badge" data-node="state">${t('node.badge.checking')}</span></header><div class="role"><span data-node="role"></span><span data-node="connection"></span></div><div class="instrument"><div class="gauge"><svg viewBox="0 0 114 72" aria-hidden="true"><path class="track" d="M10 62 A47 47 0 0 1 104 62"/><path class="needle" pathLength="100" stroke-dasharray="0 100" d="M10 62 A47 47 0 0 1 104 62"/></svg><strong data-node="gpu">${u}</strong><span>${t('node.gpuLoad')}</span></div><div class="readings">${[[t('node.gpuTemperature'),'temp',temperatureUnit(settings.temp)],[t('node.gpuPower'),'power','W'],[t('node.freeMemory'),'memory',memoryUnit(settings.mem)],[t('node.clock'),'clock','MHz']].map(([label,field,unit])=>`<div class="reading"><small>${label}</small><b><span data-node="${field}">${u}</span><em>${unit}</em></b></div>`).join('')}</div></div><div class="mem"><div class="memline"><span>${t('node.unifiedMemoryUsage')}</span><span data-node="memory-used">${u}</span></div><div class="meter"><i style="width:0"></i></div></div><details><summary data-node="kernel-summary">${t('node.kernelChecking')}</summary><div class="extra">${extraFields().map(([label,field,optional])=>`<span${optional?' data-optional hidden':''}>${label} <b data-node="${field}">${u}</b></span>`).join('')}<span class="wide" data-optional hidden>ACPI <b data-node="zones">${u}</b></span><span class="wide" data-optional hidden>${t('node.container')} <b data-node="container">${u}</b></span><span class="wide" data-node="kernel-last"></span><span class="wide" data-node="last-update"></span></div></details></article>`;
}
function buildNodes() { $('#nodes').innerHTML=metas.map(cardHtml).join(''); }
function renderNode(meta,node,root=$('#nodes')) {
  const el=root.querySelector(`[data-node-id="${CSS.escape(meta.id)}"]`);if(!el)return;
  const u=unknown(),set=(name,value)=>{const field=el.querySelector(`[data-node="${name}"]`);field.textContent=value;field.classList.toggle('unknown-value',value===u);if(field.parentElement.hasAttribute('data-optional'))field.parentElement.hidden=value===u};
  const pending=meta.collect===false||node?.collected===false,ok=Boolean(node?.ok);el.classList.toggle('is-unknown',!ok);
  const target=meta.local?t('node.target.local'):meta.host??t('node.target.noHost');
  set('title',meta.name);set('role',[roleName(meta.role),meta.hardware].filter(Boolean).join(' | '));
  const state=pending?'notCollected':!ok?'noResponse':node.gpu?.available===false?'noGpuData':node.inferenceProcessReady?'serving':'idle';
  set('state',t(`node.badge.${state}`));el.querySelector('.badge').dataset.level=BADGE_LEVELS[state]??'idle';
  set('connection',pending?t('node.connection.notCollected',{target}):ok?`${target} | ${fixed(node.latencyMs,0)} ms`:t('node.connection.statusUnknown',{target}));
  const gpu=ok?node.gpu:{};set('gpu',finite(gpu?.utilization)?fixed(gpu.utilization,0)+'%':u);el.querySelector('[data-node="gpu"]').classList.toggle('full',finite(gpu?.utilization)&&gpu.utilization>=99.5);
  const mem=settings.mem,memUnit=memoryUnit(mem),tempUnit=temperatureUnit(settings.temp);
  set('temp',temperature(gpu?.temperature,settings.temp));set('power',fixed(gpu?.powerWatts));set('memory',memory(ok?node.memory?.availableBytes:null,mem));set('clock',fixed(gpu?.clockMHz,0));
  const total=ok?node.memory?.totalBytes:null,used=ok?node.memory?.usedBytes:null;
  set('memory-used',finite(total)&&finite(used)?`${memory(used,mem)} / ${memory(total,mem,0)} ${memUnit}`:u);
  el.querySelector('.needle').setAttribute('stroke-dasharray',`${finite(gpu?.utilization)?Math.max(0,Math.min(100,gpu.utilization)):0} 100`);
  el.querySelector('.meter i').style.width=finite(total)&&total>0&&finite(used)?`${Math.min(100,used/total*100)}%`:'0%';
  set('disk',ok&&finite(node.disk?.availableBytes)?`${memory(node.disk.availableBytes,mem,0)} ${memUnit}`:u);set('process-memory',ok&&finite(node.processMemoryBytes)?`${memory(node.processMemoryBytes,mem)} ${memUnit}`:u);
  const cpu=ok?node.cpu:null;set('cpu',finite(cpu?.load1)?(finite(cpu.cores)?t('node.cpuCores',{load:fixed(cpu.load1,2),cores:cpu.cores}):fixed(cpu.load1,2)):u);
  const degrees=value=>finite(value)?`${temperature(value,settings.temp,1)} ${tempUnit}`:u;
  set('nvme',ok?degrees(node.nvmeCelsius):u);set('nic',ok?degrees(node.nicCelsius):u);
  const zones=ok?Object.entries(node.thermals?.zones??{}).filter(([,value])=>finite(value)):[];set('zones',zones.length?zones.map(([name,value])=>`${name} ${temperature(value,settings.temp,1)}`).join(' | ')+` ${tempUnit}`:u);
  set('system',ok&&node.systemState?t('node.systemFailed',{state:systemStateText(node.systemState),count:node.failedUnits}):u);set('rank',ok&&finite(node.rank)?String(node.rank):u);
  // The container line appears only when the node can see its inference container (Docker access).
  set('container',ok&&node.container?.detected?t(node.container.running?'node.containerRunning':'node.containerStopped',{name:node.container.name,count:node.container.restarts}):u);
  const kernel=ok?node.kernelEvents:null,atLeast=kernel?.capped?'≥':'';
  set('kernel-summary',kernel?.available?t('node.kernelSummary',{xid:atLeast+kernel.xid,noMemory:atLeast+kernel.noMemory}):t('node.kernelUnavailable'));
  set('kernel-last',kernel?.available?(kernel.total?`${eventTime(kernel.lastAt,Date.now(),{hour12:hour12()})} ${kernel.lastMessage||t('node.kernelErrorFallback')}`:t('node.kernelNone')):t('node.kernelJournalUnavailable'));
  set('last-update',pending?t('node.badge.notCollected'):t('node.lastPoll',{time:clock(node?.updatedAt)}));
}
const LINK_STROKE={up:['var(--link)',''],slow:['var(--orange)',''],partial:['var(--orange)',''],pending:['var(--orange)','6 5'],down:['var(--red)','6 5'],unknown:['var(--line)','3 4']};
// The interconnect: one line per cable. With one node or no links configured the panel is hidden.
function renderLinks(state) {
  const topology=state?.topology??lastTopology,links=topology?.links??[],layout=fabricLayout(topology);
  $('#fabric-panel').hidden=!layout;$('#body-grid').classList.toggle('no-fabric',!layout);
  if(!layout)return;
  $('#link-rows').innerHTML=links.map(link=>{const live=state?.ringLinks?.[link.id],st=live?.state??'unknown',planes=link.planes??['a','b'],color=st==='up'&&!live.slow?'green':st==='down'?'red':st==='unknown'?'muted':'orange';const rate=plane=>planes.includes(plane)?fixed(live?.[plane]?.rateGbps,2):'—';return `<tr><td>${esc(link.label.replace('–',' ↔ '))}</td><td>${rate('a')}</td><td>${rate('b')}</td><td style="color:var(--${color})">${esc(linkText(live))}</td></tr>`}).join('');
  $('#fabric-links').innerHTML=layout.links.map(line=>{const live=state?.ringLinks?.[line.id],[stroke,dash]=LINK_STROKE[live?.state==='up'&&live.slow?'slow':live?.state??'unknown']??LINK_STROKE.unknown;return `<line x1="${line.x1.toFixed(1)}" y1="${line.y1.toFixed(1)}" x2="${line.x2.toFixed(1)}" y2="${line.y2.toFixed(1)}" style="stroke:${stroke}${dash?`;stroke-dasharray:${dash}`:''}"><title>${esc(links.find(link=>link.id===line.id)?.label??line.id)}: ${esc(linkText(live))}</title></line>`}).join('');
  // Short ids sit in a circle; longer ones in a pill sized to the label, with the full id and name on hover.
  $('#fabric-nodes').innerHTML=layout.nodes.map(node=>{const width=labelWidth(node.label),meta=topology.nodes.find(item=>item.id===node.id),x=node.x.toFixed(1),y=node.y.toFixed(1);const shape=width===38?`<circle cx="${x}" cy="${y}" r="19" style="stroke:${node.color}"/>`:`<rect x="${(node.x-width/2).toFixed(1)}" y="${(node.y-16).toFixed(1)}" width="${width}" height="32" rx="16" style="stroke:${node.color}"/>`;return `<g><title>${esc(node.id)}${meta?.name&&meta.name!==node.id?` | ${esc(meta.name)}`:''}</title>${shape}<text class="label" x="${x}" y="${(node.y+4).toFixed(1)}" text-anchor="middle">${esc(node.label)}</text></g>`}).join('');
  const paths=links.reduce((sum,link)=>sum+(link.planes??['a','b']).length,0),count=$('#fabric-count');
  count.setAttribute('x',layout.caption.x);count.setAttribute('y',layout.caption.y);count.textContent=`${t('fabric.cables',{count:links.length})} | ${t('fabric.paths',{count:paths})}`;
}
function renderCharts(state) {
  const history=state.history||[],end=Date.now(),start=end-range*60_000;
  const rates=history.map(p=>p.outputTokensPerSecond).filter(finite),avg=state.historyStats?.activeOutputTokensPerSecond;
  const max=Math.max(1,...rates,finite(avg)?avg:0)*1.15;
  const d=chartPath(history,'outputTokensPerSecond',{start,end,min:0,max,top:4,bottom:22});$('#output-line').setAttribute('d',d);$('#output-fill').setAttribute('d','');
  $('#avg-line').setAttribute('d',finite(avg)?chartPath([{at:start,value:avg},{at:end,value:avg}],'value',{start,end,min:0,max,top:4,bottom:22}):'');
  const queueMax=Math.max(1,...history.map(p=>p.queue).filter(finite));$('#queue-line').setAttribute('d',chartPath(history,'queue',{start,end,min:0,max:queueMax,top:120,bottom:4}));
  const label=value=>clock(value,{seconds:false});
  text('#range-start',label(start));text('#range-mid',label((start+end)/2));text('#range-end',label(end));
  $('#plot-note').hidden=rates.length>0;$('#plot-note').textContent=t(state.inferenceState==='stopped'?'chart.note.stopped':'chart.note.noData');
  for(const kind of ['temp','mem']) {
    // Values are picked per node id from each sample, so an id never collides with the sample's own fields (such as "at").
    const field=kind==='temp'?'temperature':'memoryAvailableBytes',scale=kind==='mem'?2**30:1,ids=metas.map(meta=>meta.id);
    const pick=id=>point=>{const v=point.nodes?.[id]?.[field];return finite(v)?v/scale:null};
    const values=history.flatMap(point=>ids.map(id=>pick(id)(point))).filter(finite),low=kind==='temp'&&values.length?Math.min(...values)-2:0,high=values.length?Math.max(...values)+(kind==='temp'?2:5):1;
    $('#'+kind+'-chart').innerHTML=ids.map((id,index)=>`<path d="${chartPath(history,pick(id),{start,end,width:320,height:80,min:low,max:high})}" fill="none" stroke="${COLORS[index%COLORS.length]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('');
    $('#'+kind+'-legend').innerHTML=metas.map((meta,index)=>{const node=state.nodes?.[meta.id];const value=!node?.ok?unknown():kind==='temp'?temperature(node.gpu?.temperature,settings.temp):memory(node.memory?.availableBytes,settings.mem);return `<span style="color:${COLORS[index%COLORS.length]}">${esc(meta.name)} <b class="num">${value}</b></span>`}).join('');
  }
}
function renderToday(usage) {
  for(const selector of ['[data-usage]','[data-today]'])document.querySelectorAll(selector).forEach(el=>{const key=el.dataset.usage||el.dataset.today;const value=usage?.error||usage?.reported?.[key]===false?null:usage?.today?.[key];el.textContent=key==='requests'?fixed(value,0):compact(value);el.title=finite(value)?value.toLocaleString('en-US'):''});
  document.querySelectorAll('[data-ledger-zone]').forEach(el=>{el.textContent=ledgerTimeZone?t('ledger.zone',{timeZone:ledgerTimeZone}):''});
}
function renderState(state) {
  const age=Date.now()-Date.parse(state.updatedAt);if(!Number.isFinite(age)||age>staleAfterMs(state))throw new Error('stale data');
  drawState(state);
}
// Draws a state that passed the age check; a settings change redraws the last one with the new units.
function drawState(state) {
  latest=state;shown=state;lastTopology=state.topology??lastTopology;
  if(state.usage?.timeZone&&state.usage.timeZone!==ledgerTimeZone){ledgerTimeZone=state.usage.timeZone;if(!monthPicked&&selectedMonth!==ledgerToday().slice(0,7)){selectedMonth=ledgerToday().slice(0,7);monthLoadedAt=0;rebuildMonths();if(!$('#tokens').hidden)void refreshMonth(true)}}
  syncNodes(nodeOrder(state));$('#shell').classList.remove('stale');
  const v=state.inference,stopped=state.inferenceState==='stopped',nodes=state.nodes||{};
  const online=metas.filter(m=>nodes[m.id]?.ok).length,serving=metas.filter(m=>nodes[m.id]?.ok&&nodes[m.id]?.inferenceProcessReady).length,count=metas.length;
  $('.status').className='status '+(state.status==='healthy'?'':stopped?'stopped':'error');text('#status-title',serverText(state.messageKey,state.messageParams,state.message)||t('statusbar.checkingStatus'));
  const watts=metas.map(m=>nodes[m.id]).filter(n=>n?.ok&&finite(n.gpu?.powerWatts)).map(n=>n.gpu.powerWatts);
  $('#status-desc').innerHTML=`<span>${t('statusbar.nodes',{online,count})}</span><span>${t('statusbar.processes',{serving,count})}</span><span>${t(v?.ok?'statusbar.apiUp':'statusbar.apiNoResponse')}</span>${watts.length?`<span>${t('statusbar.gpuPower',{watts:fixed(watts.reduce((sum,w)=>sum+w,0),1)})}${watts.length<count?` ${t('statusbar.gpuPowerPartial',{reporting:watts.length,count})}`:''}</span>`:''}`;
  text('#updated-at',clock(state.updatedAt));text('#model-title',v?.modelName||t(stopped?'header.inferenceStopped':'header.modelUnknown'));text('#model-meta',serving?t('header.engineRunning',{engine:state.serving?.engine??t('header.engineFallback'),count:serving}):t('header.liveMonitor',{count}));
  document.title=v?.modelName?`${v.modelName} | Spark Scope`:'Spark Scope';
  const empty=stopped?t('common.stopped'):unknown(),value=(number,formatter=fixed)=>v?.ok?formatter(number):empty;
  text('#speed',value(v?.outputTokensPerSecond));text('#legend-speed',value(v?.outputTokensPerSecond));text('#avg',fixed(state.historyStats?.activeOutputTokensPerSecond));text('#queue',value(v?.waitingRequests,n=>fixed(n,0)));
  document.querySelectorAll('[data-field]').forEach(el=>{const key=el.dataset.field;let result=empty;if(v?.ok){if(key==='requests')result=`${fixed(v.runningRequests,0)} / ${fixed(v.waitingRequests,0)}`;else if(key.endsWith('RecentSeconds'))result=recentLatency(v,key);else if(key.endsWith('Seconds'))result=duration(v[key]);else if(key.endsWith('Percent'))result=fixed(v[key],1,'%');else result=tokenRate(v[key])}el.textContent=result});
  metas.forEach(meta=>renderNode(meta,nodes[meta.id]));renderLinks(state);renderCharts(state);renderToday(state.usage);
  if(dialog.open)renderPreview();
}
// p95 over the requests that finished in the last 5 minutes; with none it says so instead of a value. The value
// since the engine started is in the tooltip.
function recentLatency(v,key) {
  const el=document.querySelector(`[data-field="${key}"]`),overall=v[key.replace('Recent','')];
  el.title=finite(overall)?t('engine.sinceStart',{value:duration(overall)}):'';
  return finite(v[key])?duration(v[key]):v.latencyWindowSeconds>0?t('engine.noRequests'):unknown();
}
function failedState() {
  latest=null;
  $('#shell').classList.add('stale');$('.status').className='status error';text('#status-title',t('statusbar.serverDown'));text('#status-desc',t('statusbar.serverDownDetail'));
  metas.forEach(meta=>renderNode(meta,null));renderLinks(null);renderToday(null);for(const id of ['speed','legend-speed','avg','queue'])text('#'+id,unknown());document.querySelectorAll('[data-field]').forEach(el=>el.textContent=unknown());$('#plot-note').hidden=false;$('#plot-note').textContent=t('chart.note.reconnecting');
}
async function refresh() {
  if(collecting)return;collecting=true;const requestedRange=range,full=historyRange!==requestedRange||Date.now()-historyAt>=HISTORY_REFRESH_MS;
  let data=null;const timeout=timeoutSignal(8000);
  try{const res=await fetch(`/api/state?minutes=${requestedRange}${full?'':'&history=0'}`,{cache:'no-store',signal:timeout.signal});if(!res.ok)throw new Error('HTTP '+res.status);data=await res.json()}
  catch{if(requestedRange===range)failedState()}
  finally{timeout.done()}
  try{
    if(data&&requestedRange===range){
      if(full){history=data.history??[];historyAt=Date.now();historyRange=requestedRange}else history=mergeLivePoint(history,livePoint(data),requestedRange*60_000);
      renderState({...data,history});
    }
  }catch(error){
    // A drawing problem is not a lost connection: keep the last good view and say what broke.
    if(error?.message==='stale data')failedState();else console.error('Spark Scope could not draw the latest state:',error);
  }finally{collecting=false;if(requestedRange!==range)void refresh()}
}

function rebuildMonths() {
  const current=ledgerToday().slice(0,7),choices=monthOptions(earliestMonth,current);
  if(!choices.includes(selectedMonth))choices.push(selectedMonth);
  $('#token-month').innerHTML=choices.sort().reverse().map(month=>`<option value="${month}"${month===selectedMonth?' selected':''}>${monthLabel(month)}</option>`).join('');
}
// A counter the engine does not export (usage.reported[key] === false) reads as unknown, not as 0.
let unreported={};
function metricCell(key,value,tag='td') { if(unreported[key]&&!value)return `<${tag} data-metric="${key}" class="unknown-value">${unknown()}</${tag}>`; return `<${tag} data-metric="${key}" data-count="${value}" title="${value.toLocaleString('en-US')}">${key==='requests'?fixed(value,0):compact(value)}</${tag}>`; }
// The month view as last drawn, so a language change can draw it again.
let redrawMonth=()=>{};
function renderMonth(usage) {
  redrawMonth=()=>renderMonth(usage);
  if(usage.timeZone)ledgerTimeZone=usage.timeZone;
  unreported=Object.fromEntries(Object.entries(usage.reported??{}).filter(([,seen])=>seen===false).map(([key])=>[key,true]));
  earliestMonth=usage.firstMonth;rebuildMonths();const current=selectedMonth===usage.day.slice(0,7),month=monthName(selectedMonth);
  text('#month-title',t(current?'ledger.monthToDate':'ledger.monthTotal',{month}));text('#month-period',current?`${dayLabel(selectedMonth+'-01')} – ${dayLabel(usage.day)}`:monthLabel(selectedMonth));
  $('#month-period').classList.remove('month-load-error');$('#today-tokens').hidden=!current;
  const metrics=[['ledger.totalTokens','total'],['ledger.cacheRead','cache'],['ledger.newInput','compute'],['ledger.output','output'],['ledger.logicalInput','input'],['ledger.requests','requests']];
  const metricsHtml=metrics.map(([label,key])=>`<div class="${key==='total'?'total-tokens':''}"><small>${t(label)}</small>${metricCell(key,usage.totals[key],'b')}</div>`).join('');
  if($('#month-metrics').innerHTML!==metricsHtml)$('#month-metrics').innerHTML=metricsHtml;
  const days=[...usage.days].sort((a,b)=>b.day.localeCompare(a.day));const fields=['cache','compute','output','input','requests'];
  $('#token-days').innerHTML=days.length?days.map(day=>`<tr><th scope="row">${esc(dayLabel(day.day))}</th>${fields.map(k=>metricCell(k,day[k])).join('')}</tr>`).join(''):`<tr><td colspan="6">${t('ledger.noUsage')}</td></tr>`;
  $('#token-month-total').innerHTML=`<tr><th scope="row">${t('ledger.monthTotalRow')}</th>${fields.map(k=>metricCell(k,usage.totals[k])).join('')}</tr>`;
  const number=Number(selectedMonth.slice(5)),lastDay=current?Number(usage.day.slice(8)):new Date(Date.UTC(Number(selectedMonth.slice(0,4)),number,0)).getUTCDate();const recent=[];for(let d=Math.max(1,lastDay-6);d<=lastDay;d++){const date=selectedMonth+'-'+String(d).padStart(2,'0');recent.push({day:date,value:usage.days.find(row=>row.day===date)?.output??null})}
  const max=Math.max(1,...recent.map(p=>p.value).filter(finite));$('#token-chart').innerHTML=recent.map(row=>`<div class="day-bar" style="--h:${finite(row.value)?row.value/max*85:0}%" title="${finite(row.value)?t('ledger.bar.output',{day:dayLabel(row.day),count:fixed(row.value,0)}):t('ledger.bar.noRecord',{day:dayLabel(row.day)})}"><i></i><span>${dayLabel(row.day)}</span></div>`).join('');
  renderToday(latest?.usage);
}
// key names the message shown in place of the month (loading, or an error).
function clearMonth(key,isError=false) {
  redrawMonth=()=>clearMonth(key,isError);const message=t(key);
  text('#month-title',t('ledger.monthTotal',{month:monthName(selectedMonth)}));text('#month-period',message);$('#month-period').classList.toggle('month-load-error',isError);
  $('#month-metrics').innerHTML='';$('#token-days').innerHTML=`<tr><td colspan="6">${esc(message)}</td></tr>`;$('#token-month-total').innerHTML='';$('#token-chart').innerHTML='';$('#today-tokens').hidden=true;
}
async function refreshMonth(force=false) {
  if(!force&&(monthController||Date.now()-monthLoadedAt<10000))return;
  const sequence=++monthSequence,month=selectedMonth;monthController?.abort();const controller=new AbortController();monthController=controller;const timer=setTimeout(()=>controller.abort(),8000);
  try{const res=await fetch('/api/usage?month='+encodeURIComponent(month),{cache:'no-store',signal:controller.signal});if(!res.ok)throw new Error('HTTP '+res.status);const payload=validateMonth(await res.json(),month);if(sequence===monthSequence){renderMonth(payload);monthLoadedAt=Date.now()}}catch{if(sequence===monthSequence)clearMonth('ledger.loadError',true)}finally{clearTimeout(timer);if(sequence===monthSequence)monthController=null}
}
function selectTab(btn,updateHash=true) {
  document.querySelectorAll('[role=tab]').forEach(b=>{b.setAttribute('aria-selected',String(b===btn));b.tabIndex=b===btn?0:-1;$('#'+b.getAttribute('aria-controls')).hidden=b!==btn});
  const tokens=btn.id==='tab-tokens';if(updateHash)location.hash=tokens?'tokens':'scope';if(tokens)void refreshMonth();
}
document.querySelectorAll('[role=tab]').forEach(btn=>{btn.addEventListener('click',()=>selectTab(btn));btn.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?$('#tab-scope'):e.key==='End'?$('#tab-tokens'):btn.id==='tab-scope'?$('#tab-tokens'):$('#tab-scope');selectTab(next);next.focus()}})});
window.addEventListener('hashchange',()=>selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false));
function showRange(){document.querySelectorAll('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.range)===range)))}
document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{range=Number(btn.dataset.range);showRange();void refresh()}));
$('#token-month').addEventListener('change',()=>{monthPicked=true;selectedMonth=$('#token-month').value;monthLoadedAt=0;clearMonth('ledger.loading');void refreshMonth(true)});
// ---- settings dialog ----
const dialog=$('#settings'),form=dialog.querySelector('form'),opener=$('#settings-open');
let previewId=null;
function showUnits(){text('#temp-range',t('trends.selectedRange',{unit:temperatureUnit(settings.temp)}));text('#mem-range',t('trends.selectedRange',{unit:memoryUnit(settings.mem)}))}
// Puts the current settings into the form controls.
function syncForm(){
  for(const [name,value] of Object.entries({...settings,theme:themeChoice??'system'}))for(const input of form.querySelectorAll(`[name="${name}"]`))input.type==='checkbox'?input.checked=Boolean(value):input.checked=input.value===String(value);
}
// One node's card drawn with the current settings and live data, the update time on the chosen clock, and About.
function renderPreview(){
  const select=$('#preview-node'),options=metas.map(meta=>`<option value="${esc(meta.id)}">${esc(meta.name)}</option>`).join('');
  if(select.innerHTML!==options)select.innerHTML=options;select.hidden=metas.length<2;
  if(!metas.some(meta=>meta.id===previewId))previewId=metas[0]?.id??null;select.value=previewId??'';
  const meta=metas.find(item=>item.id===previewId),box=$('#preview-nodes');
  box.innerHTML=meta?cardHtml(meta):'';if(meta)renderNode(meta,latest?.nodes?.[meta.id],box);
  $('#preview-clock').textContent=clock(latest?.updatedAt??Date.now());
  const intervals=latest?.pollIntervals,every=ms=>finite(ms)?` | ${t('settings.about.every',{seconds:fixed(ms/1000,ms%1000?1:0)})}`:'';
  $('#about-version').textContent=latest?.version??unknown();
  $('#about-engine').textContent=(latest?.serving?.engine??unknown())+every(intervals?.apiMs);
  $('#about-nodes').textContent=metas.length?t('settings.about.nodeCount',{count:metas.length})+every(intervals?.nodeMs):unknown();
}
// Every change applies at once: saved, drawn on the page behind the dialog and in the preview. While the server is
// not answering, the last data is drawn again under the "not responding" state, so its text follows a new language too.
function applySettings({rangeChanged=false,refreshChanged=false,langChanged=false}={}){
  saveSettings(store,settings);
  if(langChanged){setLanguage(settings.lang);translatePage();applyTheme();rebuildMonths();redrawMonth()}
  showUnits();
  if(rangeChanged){range=settings.range;showRange();void refresh()}
  if(refreshChanged)schedulePolls();
  buildNodes();const lost=$('#shell').classList.contains('stale');
  try{if(latest)drawState(latest);else if(lost){if(shown)drawState(shown);failedState()}}catch(error){console.error('Spark Scope could not redraw with the new settings:',error)}
  renderPreview();syncForm();
}
const changes=before=>({rangeChanged:settings.range!==before.range,refreshChanged:settings.refresh!==before.refresh,langChanged:settings.lang!==before.lang});
form.addEventListener('change',event=>{
  const input=event.target;if(input.id==='preview-node'){previewId=input.value;renderPreview();return}
  if(input.name==='theme'){themeChoice=input.value==='system'?null:input.value;saveTheme(store,themeChoice);applyTheme();return}
  const before=settings;
  settings=parseSettings({...settings,[input.name]:input.type==='checkbox'?input.checked:['range','refresh'].includes(input.name)?Number(input.value):input.value});
  applySettings(changes(before));
});
function showSection(name){
  dialog.querySelectorAll('[data-section]').forEach(button=>button.setAttribute('aria-current',String(button.dataset.section===name)));
  dialog.querySelectorAll('[data-panel]').forEach(panel=>{panel.hidden=panel.dataset.panel!==name});
}
dialog.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>showSection(button.dataset.section)));
opener.addEventListener('click',()=>{syncForm();renderPreview();$('#settings-link').hidden=true;dialog.showModal();opener.setAttribute('aria-expanded','true')});
dialog.addEventListener('close',()=>{opener.setAttribute('aria-expanded','false');opener.focus()});
// Clicking the dimmed page outside the dialog closes it.
dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});
$('#settings-reset').addEventListener('click',()=>{const before=settings;settings=parseSettings(null);themeChoice=null;saveTheme(store,null);applyTheme();applySettings(changes(before))});
// The clipboard needs HTTPS or localhost; on plain HTTP the link is shown selected, ready to copy by hand.
$('#settings-copy').addEventListener('click',async()=>{
  const query=settingsQuery(settings,themeChoice),url=location.origin+location.pathname+(query?`?${query}`:''),field=$('#settings-link'),button=$('#settings-copy');
  field.value=url;field.hidden=false;let copied=false;
  try{await navigator.clipboard.writeText(url);copied=true}catch{}
  field.focus();field.select();button.textContent=t(copied?'settings.linkCopied':'settings.copyManually');
  setTimeout(()=>{button.textContent=t('settings.copyLink')},2500);
});

showUnits();showRange();syncForm();
buildNodes();rebuildMonths();clearMonth('ledger.loading');selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false);void refresh();
// With "pause while hidden" on (the default) a hidden tab sends no requests; when it is shown again it reloads the
// chart history at once, so the gap fills in.
function poll(){if(settings.pause&&document.hidden)return;void refresh();if(!$('#tokens').hidden)void refreshMonth()}
let pollTimer=null;
function schedulePolls(){clearInterval(pollTimer);pollTimer=setInterval(poll,settings.refresh*1000)}
schedulePolls();
document.addEventListener('visibilitychange',()=>{if(!document.hidden){historyAt=0;poll()}});
