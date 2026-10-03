import { COLORS, PALETTE, nodeColor, lowContrast, nodeOrder, linkText, unknown, finite, fixed, compact, duration, tokenRate, memory, memoryUnit, temperature, temperatureUnit, escapeHtml as esc, clockTime, eventTime, localDay, monthLabel, monthName, dayLabel, monthOptions, systemStateText, roleName, chartPath, validateMonth, fabricLayout, labelWidth, nextTheme, topologyKey, staleAfterMs, livePoint, mergeLivePoint, timeoutSignal, onMediaChange, readingValue, modelServers, severalServers, serverName, serverOfNode, serverColorIndex, pickedServer, viewInference } from './view-data.js';
import { READING_IDS, rackQuery, parseSettings, loadSettings, saveSettings, loadTheme, saveTheme, settingsQuery, settingsFromQuery, withoutSettingsQuery } from './settings.js';
import { t, setLanguage, translatePage, serverText, LANGUAGE_NAMES } from './i18n.js';
import { hide as hideHelp } from './help.js';
import { kpiHtml, statementHtml, calendarHtml, chartsHtml, modelTableHtml, ledgerCsv, previousMonth } from './ledger.js';
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
let latest = null, shown = null, metas = [], servers = [], lastTopology = null, range = settings.range, collecting = false, monthSequence = 0, monthLoadedAt = 0, monthController = null;
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
  const index=Math.max(0,metas.findIndex(item=>item.id===meta.id));
  return `<article class="node" data-node-id="${esc(meta.id)}" style="--node:${nodeColor(settings.colors,index)}"><header><h2 data-node="title">${esc(meta.name)}</h2><span class="badge" data-node="state">${t('node.badge.checking')}</span></header><div class="role"><span class="server-tag" data-server-tag hidden></span><span data-node="role"></span><span data-node="connection"></span></div><div class="instrument"><div class="gauge"><svg viewBox="0 0 114 72" aria-hidden="true"><path class="track" d="M10 62 A47 47 0 0 1 104 62"/><path class="needle" pathLength="100" stroke-dasharray="0 100" d="M10 62 A47 47 0 0 1 104 62"/></svg><strong data-node="gpu">${u}</strong><span>${t('node.gpuLoad')}</span></div><div class="readings">${settings.readings.map((id,slot)=>`<div class="reading" data-slot="${slot}"><small><span class="full">${t(`node.reading.${id}`)}</span><span class="short">${t(`node.readingShort.${id}`)}</span></small><b data-reading="${slot}"><span>${u}</span><em></em></b></div>`).join('')}</div></div>${settings.bars.includes('unified')?`<div class="mem" data-bar="unified"><div class="memline"><span>${t('node.unifiedMemoryUsage')}</span><span data-node="memory-used">${u}</span></div><div class="meter"><i style="width:0"></i></div></div>`:''}${settings.bars.includes('disk')?`<div class="mem" data-bar="disk"><div class="memline"><span>${t('node.rootFilesystem')}</span><span data-node="disk-used">${u}</span></div><div class="meter"><i style="width:0"></i></div></div>`:''}<details><summary data-node="kernel-summary">${t('node.kernelChecking')}</summary><div class="extra">${extraFields().map(([label,field,optional])=>`<span${optional?' data-optional hidden':''}>${label} <b data-node="${field}">${u}</b></span>`).join('')}<span class="wide" data-optional hidden>ACPI <b data-node="zones">${u}</b></span><span class="wide" data-optional hidden>${t('node.container')} <b data-node="container">${u}</b></span><span class="wide" data-node="kernel-last"></span><span class="wide" data-node="last-update"></span></div></details></article>`;
}
function buildNodes() { $('#nodes').innerHTML=metas.map(cardHtml).join(''); }
function renderNode(meta,node,root=$('#nodes')) {
  const el=root.querySelector(`[data-node-id="${CSS.escape(meta.id)}"]`);if(!el)return;
  const u=unknown(),set=(name,value)=>{const field=el.querySelector(`[data-node="${name}"]`);field.textContent=value;field.classList.toggle('unknown-value',value===u);if(field.parentElement.hasAttribute('data-optional'))field.parentElement.hidden=value===u};
  const pending=meta.collect===false||node?.collected===false,ok=Boolean(node?.ok);el.classList.toggle('is-unknown',!ok);
  const target=meta.local?t('node.target.local'):meta.host??t('node.target.noHost');
  set('title',meta.name);set('role',[roleName(meta.role),meta.hardware].filter(Boolean).join(' | '));
  // With several model servers, the server this node serves in, in that server's colour.
  const tag=el.querySelector('[data-server-tag]'),server=servers.length>1?serverOfNode(servers,meta.id):null;tag.hidden=!server;if(server){tag.textContent=serverName(server);tag.style.setProperty('--server',serverColor(server))}
  const state=pending?'notCollected':!ok?'noResponse':node.gpu?.available===false?'noGpuData':node.inferenceProcessReady?'serving':'idle';
  set('state',t(`node.badge.${state}`));el.querySelector('.badge').dataset.level=BADGE_LEVELS[state]??'idle';
  set('connection',pending?t('node.connection.notCollected',{target}):ok?`${target} | ${fixed(node.latencyMs,0)} ms`:t('node.connection.statusUnknown',{target}));
  // GPU load: the figure with a small "%", and --load for the designs that draw it as a ring or a bar.
  const gpu=ok?node.gpu:{},load=finite(gpu?.utilization)?Math.max(0,Math.min(100,gpu.utilization)):null,gauge=el.querySelector('[data-node="gpu"]');
  const gaugeHtml=load===null?esc(u):`${fixed(gpu.utilization,0)}<small>%</small>`;if(gauge.innerHTML!==gaugeHtml)gauge.innerHTML=gaugeHtml;
  gauge.classList.toggle('unknown-value',load===null);gauge.classList.toggle('full',load!==null&&gpu.utilization>=99.5);el.style.setProperty('--load',String(load??0));
  const mem=settings.mem,memUnit=memoryUnit(mem),tempUnit=temperatureUnit(settings.temp);
  // The four readings chosen in the settings, orange past their warning level.
  settings.readings.forEach((id,slot)=>{const field=el.querySelector(`[data-reading="${slot}"]`);if(!field)return;const r=readingValue(id,node,settings);field.firstElementChild.textContent=r.text;field.lastElementChild.textContent=r.unit;field.classList.toggle('unknown-value',r.text===u);field.classList.toggle('warn',r.warn)});
  el.querySelector('.needle').setAttribute('stroke-dasharray',`${finite(gpu?.utilization)?Math.max(0,Math.min(100,gpu.utilization)):0} 100`);
  const total=ok?node.memory?.totalBytes:null,used=ok?node.memory?.usedBytes:null,free=ok?node.memory?.availableBytes:null,unified=el.querySelector('[data-bar="unified"]');
  if(unified){set('memory-used',finite(total)&&finite(used)?`${memory(used,mem)} / ${memory(total,mem,0)} ${memUnit}`:u);const bar=unified.querySelector('.meter i');bar.style.width=finite(total)&&total>0&&finite(used)?`${Math.min(100,used/total*100)}%`:'0%';bar.classList.toggle('warn',finite(free)&&free<settings.memWarn*2**30)}
  const disk=ok?node.disk:null,rootfs=el.querySelector('[data-bar="disk"]');
  if(rootfs){const pct=finite(disk?.usedPercent)?disk.usedPercent:null;set('disk-used',pct!==null&&finite(disk?.totalBytes)?t('node.diskOf',{percent:fixed(pct,0),total:memory(disk.totalBytes,mem,0),unit:memUnit}):u);const bar=rootfs.querySelector('.meter i');bar.style.width=pct!==null?`${Math.min(100,pct)}%`:'0%';bar.classList.toggle('warn',pct!==null&&pct>=settings.diskWarn)}
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
  const visible=Boolean(layout)&&!settings.hide.includes('interconnect');$('#fabric-panel').hidden=!visible;$('#body-grid').classList.toggle('no-fabric',!visible);
  if(!layout)return;
  $('#link-rows').innerHTML=links.map(link=>{const live=state?.ringLinks?.[link.id],st=live?.state??'unknown',planes=link.planes??['a','b'],color=st==='up'&&!live.slow?'green':st==='down'?'red':st==='unknown'?'muted':'orange';const rate=plane=>planes.includes(plane)?fixed(live?.[plane]?.rateGbps,2):'—';return `<tr><td>${esc(link.label.replace('–',' ↔ '))}</td><td>${rate('a')}</td><td>${rate('b')}</td><td style="color:var(--${color})">${esc(linkText(live))}</td></tr>`}).join('');
  $('#fabric-links').innerHTML=layout.links.map(line=>{const live=state?.ringLinks?.[line.id],[stroke,dash]=LINK_STROKE[live?.state==='up'&&live.slow?'slow':live?.state??'unknown']??LINK_STROKE.unknown;return `<line x1="${line.x1.toFixed(1)}" y1="${line.y1.toFixed(1)}" x2="${line.x2.toFixed(1)}" y2="${line.y2.toFixed(1)}" style="stroke:${stroke}${dash?`;stroke-dasharray:${dash}`:''}"><title>${esc(links.find(link=>link.id===line.id)?.label??line.id)}: ${esc(linkText(live))}</title></line>`}).join('');
  // Short ids sit in a circle; longer ones in a pill sized to the label, with the full id and name on hover.
  $('#fabric-nodes').innerHTML=layout.nodes.map(node=>{const width=labelWidth(node.label),meta=topology.nodes.find(item=>item.id===node.id),x=node.x.toFixed(1),y=node.y.toFixed(1),color=nodeColor(settings.colors,topology.nodes.findIndex(item=>item.id===node.id));const shape=width===38?`<circle cx="${x}" cy="${y}" r="19" style="stroke:${color}"/>`:`<rect x="${(node.x-width/2).toFixed(1)}" y="${(node.y-16).toFixed(1)}" width="${width}" height="32" rx="16" style="stroke:${color}"/>`;return `<g><title>${esc(node.id)}${meta?.name&&meta.name!==node.id?` | ${esc(meta.name)}`:''}</title>${shape}<text class="label" x="${x}" y="${(node.y+4).toFixed(1)}" text-anchor="middle">${esc(node.label)}</text></g>`}).join('');
  const paths=links.reduce((sum,link)=>sum+(link.planes??['a','b']).length,0),count=$('#fabric-count');
  count.setAttribute('x',layout.caption.x);count.setAttribute('y',layout.caption.y);count.textContent=`${t('fabric.cables',{count:links.length})} | ${t('fabric.paths',{count:paths})}`;
}
// The output chart's points: the totals over the servers, or the picked server's own in "one at a time".
function chartSeries(state) {
  const history=state.history||[];if(!severalServers(state)||settings.servers!=='one')return history;
  const id=pickedServer(modelServers(state),settings.server).id;
  return history.map(point=>({at:point.at,outputTokensPerSecond:null,runningRequests:null,queue:null,...point.servers?.[id]}));
}
// The mean output over the samples with requests running, as the server computes it for the totals.
function activeAverage(points){const rates=points.filter(point=>point.runningRequests>0&&finite(point.outputTokensPerSecond)).map(point=>point.outputTokensPerSecond);return rates.length?rates.reduce((sum,rate)=>sum+rate,0)/rates.length:null}
function renderCharts(state) {
  const all=state.history||[],history=chartSeries(state),end=Date.now(),start=end-range*60_000;
  const several=severalServers(state),each=several&&settings.servers!=='one';
  const avg=several&&!each?activeAverage(history.filter(point=>point.at>=start)):state.historyStats?.activeOutputTokensPerSecond;text('#avg',fixed(avg));
  const rates=history.map(p=>p.outputTokensPerSecond).filter(finite);
  const max=Math.max(1,...rates,finite(avg)?avg:0)*1.15;
  // "All at once": a line per server in its colour, with the total drawn neutral on top.
  $('#server-lines').innerHTML=each?modelServers(state).map(server=>`<path d="${chartPath(all.map(point=>({at:point.at,value:point.servers?.[server.id]?.outputTokensPerSecond??null})),'value',{start,end,min:0,max,top:4,bottom:22})}" fill="none" stroke="${serverColor(server)}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`).join(''):'';
  $('#output-line').setAttribute('stroke',each?'var(--ink)':'var(--blue)');$('.legend div:first-child i').style.background=each?'var(--ink)':'';
  text('#legend-output',t(each?'chart.legend.total':'chart.legend.output'));
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
    const values=all.flatMap(point=>ids.map(id=>pick(id)(point))).filter(finite),low=kind==='temp'&&values.length?Math.min(...values)-2:0,high=values.length?Math.max(...values)+(kind==='temp'?2:5):1;
    $('#'+kind+'-chart').innerHTML=ids.map((id,index)=>`<path d="${chartPath(all,pick(id),{start,end,width:320,height:80,min:low,max:high})}" fill="none" stroke="${nodeColor(settings.colors,index)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('');
    renderLegend(kind,state.nodes);
  }
}
// The current value per node under a trend chart; unknown for a node that did not answer (or with no state at all).
function renderLegend(kind,nodes) {
  $('#'+kind+'-legend').innerHTML=metas.map((meta,index)=>{const node=nodes?.[meta.id];const value=!node?.ok?unknown():kind==='temp'?temperature(node.gpu?.temperature,settings.temp):memory(node.memory?.availableBytes,settings.mem);return `<span style="color:${nodeColor(settings.colors,index)}">${esc(meta.name)} <b class="num">${value}</b></span>`}).join('');
}
function renderToday(usage) {
  document.querySelectorAll('[data-usage]').forEach(el=>{const key=el.dataset.usage;const value=usage?.error||usage?.reported?.[key]===false?null:usage?.today?.[key];el.textContent=key==='requests'?fixed(value,0):compact(value);el.title=finite(value)?value.toLocaleString('en-US'):''});
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
  servers=modelServers(state);syncNodes(nodeOrder(state));$('#shell').classList.remove('stale');
  const v=state.inference,stopped=state.inferenceState==='stopped',nodes=state.nodes||{},several=servers.length>1,focus=viewInference(state,settings);
  const online=metas.filter(m=>nodes[m.id]?.ok).length,serving=metas.filter(m=>nodes[m.id]?.ok&&nodes[m.id]?.inferenceProcessReady).length,count=metas.length;
  $('.status').className='status '+(state.status==='healthy'?'':stopped?'stopped':'error');text('#status-title',serverText(state.messageKey,state.messageParams,state.message)||t('statusbar.checkingStatus'));
  const watts=metas.map(m=>nodes[m.id]).filter(n=>n?.ok&&finite(n.gpu?.powerWatts)).map(n=>n.gpu.powerWatts);
  $('#status-desc').innerHTML=`<span>${t('statusbar.nodes',{online,count})}</span><span>${t('statusbar.processes',{serving,count})}</span><span>${several?t('statusbar.apis',{answering:servers.filter(server=>server.inference?.ok).length,count:servers.length}):t(v?.ok?'statusbar.apiUp':'statusbar.apiNoResponse')}</span>${watts.length?`<span>${t('statusbar.gpuPower',{watts:fixed(watts.reduce((sum,w)=>sum+w,0),1)})}${watts.length<count?` ${t('statusbar.gpuPowerPartial',{reporting:watts.length,count})}`:''}</span>`:''}`;
  text('#updated-at',clock(state.updatedAt));
  if(several){const names=servers.map(serverName).join(' | ');text('#model-title',names);text('#model-meta',t('header.servers',{count:servers.length,nodes:count}));document.title=`${names} | Spark Scope`}
  else{text('#model-title',v?.modelName||t(stopped?'header.inferenceStopped':'header.modelUnknown'));text('#model-meta',serving?t('header.engineRunning',{engine:state.serving?.engine??t('header.engineFallback'),count:serving}):t('header.liveMonitor',{count}));document.title=v?.modelName?`${v.modelName} | Spark Scope`:'Spark Scope'}
  // The big figure and the legend follow the total over the servers, or the picked one in "one at a time".
  const focusStopped=several&&settings.servers==='one'?pickedServer(servers,settings.server).inferenceState==='stopped':stopped;
  const empty=focusStopped?t('common.stopped'):unknown(),value=(number,formatter=fixed)=>focus?.ok?formatter(number):empty;
  text('#speed',value(focus?.outputTokensPerSecond));text('#legend-speed',value(focus?.outputTokensPerSecond));text('#queue',value(focus?.waitingRequests,n=>fixed(n,0)));
  renderServers(state);renderEngines(state);$('#servers-choice').hidden=!several;
  metas.forEach(meta=>renderNode(meta,nodes[meta.id]));renderLinks(state);renderCharts(state);renderToday(state.usage);
  if(dialog.open)renderPreview();
}
// p95 over the requests that finished in the last 5 minutes; with none it says so instead of a value. The value
// since the engine started is added to the explanation behind the row's "?" button.
function recentLatency(el,v,key) {
  const overall=v[key.replace('Recent','')];
  const help=el.previousElementSibling?.querySelector('.help');if(help)help.dataset.helpNote=finite(overall)?t('engine.sinceStart',{value:duration(overall)}):'';
  return finite(v[key])?duration(v[key]):v.latencyWindowSeconds>0?t('engine.noRequests'):unknown();
}
// ---- model servers ----
const serverColor=server=>nodeColor(settings.colors,serverColorIndex(server,metas));
// The servers whose engine panel shows: every one in "all at once", the picked one in "one at a time".
const shownServers=state=>{const list=modelServers(state);return list.length>1&&settings.servers==='one'?[pickedServer(list,settings.server)]:list};
// One engine panel per shown server (copies of the first), each named after its server when there are several.
function renderEngines(state) {
  const list=shownServers(state),box=$('#engines'),template=box.firstElementChild;
  while(box.children.length<list.length)box.append(template.cloneNode(true));
  while(box.children.length>list.length)box.lastElementChild.remove();
  [...box.children].forEach((block,index)=>{
    const server=list[index],caption=block.querySelector('.engine-for');block.dataset.server=server.id;caption.hidden=!severalServers(state);
    if(!caption.hidden){caption.querySelector('i').style.background=serverColor(server);caption.querySelector('span').textContent=[serverName(server),server.serving?.engine].filter(Boolean).join(' | ')}
    fillEngine(block,server.inference,server.inferenceState==='stopped');
  });
}
function fillEngine(block,v,stopped) {
  const empty=stopped?t('common.stopped'):unknown();
  block.querySelectorAll('[data-field]').forEach(el=>{const key=el.dataset.field;let result=empty;if(v?.ok){if(key==='requests')result=`${fixed(v.runningRequests,0)} / ${fixed(v.waitingRequests,0)}`;else if(key.endsWith('RecentSeconds'))result=recentLatency(el,v,key);else if(key.endsWith('Seconds'))result=duration(v[key]);else if(key.endsWith('Percent'))result=fixed(v[key],1,'%');else result=tokenRate(v[key])}el.textContent=result});
}
// One row per model server: its model, nodes, state, output and queue. In "one at a time" a row picks the server
// that the chart and the engine panel follow.
function renderServers(state) {
  const box=$('#servers'),list=modelServers(state);box.hidden=list.length<2;if(list.length<2)return;
  const pick=settings.servers==='one'?pickedServer(list,settings.server).id:null;
  setHtml('#servers',list.map(server=>{
    const v=server.inference,key=!v?'checking':v.ok?'serving':server.inferenceState==='stopped'?'idle':'down';
    const cells=`<i style="background:${serverColor(server)}"></i><b>${esc(serverName(server))}</b><span>${t('servers.nodes',{count:server.nodes.length})}</span><span class="server-state" data-state="${key}">${t(`servers.state.${key}`)}</span><span class="num" data-value>${v?.ok?`${fixed(v.outputTokensPerSecond)} tok/s`:unknown()}</span><span class="num" data-value>${t('servers.queue',{queue:v?.ok?fixed(v.waitingRequests,0):unknown()})}</span>`;
    return pick?`<button type="button" class="server-row" data-server="${esc(server.id)}" aria-pressed="${server.id===pick}">${cells}</button>`:`<div class="server-row">${cells}</div>`;
  }).join(''));
}
$('#servers').addEventListener('click',event=>{const row=event.target.closest('button[data-server]');if(!row||row.dataset.server===settings.server)return;const before=settings;settings=parseSettings({...settings,server:row.dataset.server});applySettings(changes(before))});
function failedState() {
  latest=null;
  $('#shell').classList.add('stale');$('.status').className='status error';text('#status-title',t('statusbar.serverDown'));text('#status-desc',t('statusbar.serverDownDetail'));
  metas.forEach(meta=>renderNode(meta,null));renderLinks(null);renderToday(null);renderLegend('temp',null);renderLegend('mem',null);for(const id of ['speed','legend-speed','avg','queue'])text('#'+id,unknown());document.querySelectorAll('[data-field],#servers [data-value]').forEach(el=>el.textContent=unknown());$('#plot-note').hidden=false;$('#plot-note').textContent=t('chart.note.reconnecting');
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

// Month buttons for the six latest months (oldest on the left); older months are in a list before them. A phone
// gets the list alone, with every month.
const narrowQuery=matchMedia('(max-width: 760px)');
function rebuildMonths() {
  const current=ledgerToday().slice(0,7),choices=monthOptions(earliestMonth,current),count=narrowQuery.matches?0:6;
  if(!choices.includes(selectedMonth))choices.push(selectedMonth);
  choices.sort().reverse();
  const recent=choices.slice(0,count).reverse(),older=choices.slice(count),name=month=>month.slice(0,4)===current.slice(0,4)?monthName(month):monthLabel(month);
  const placeholder=older.includes(selectedMonth)?'':`<option value="" selected disabled>${t('ledger.earlier')}</option>`;
  const list=older.length?`<select class="month-older" aria-label="${t(count?'ledger.earlierLabel':'ledger.monthSelectLabel')}">${placeholder}${older.map(month=>`<option value="${month}"${month===selectedMonth?' selected':''}>${monthLabel(month)}</option>`).join('')}</select>`:'';
  setHtml('#token-months',list+recent.map(month=>`<button type="button" data-month="${month}" aria-pressed="${month===selectedMonth}">${name(month)}</button>`).join(''));
}
// Markup is replaced only when it changed, so a poll does not move the focus or restart a hover.
function setHtml(selector,html){const el=$(selector);if(el.innerHTML!==html)el.innerHTML=html}
// A counter the engine does not export (usage.reported[key] === false) reads as unknown, not as 0.
let unreported={};
// The ledger view (statement, calendar or charts), the day picked in the calendar, and the month as last drawn.
let ledgerView='statement',pickedDay=null,shownMonth=null;
// Past months change rarely; the month before the selected one (for the comparison) is fetched again after 5 minutes.
const pastMonths=new Map();
let redrawMonth=()=>{};
function renderMonth(usage,previous) {
  if(usage.timeZone)ledgerTimeZone=usage.timeZone;
  // Unless a month was picked by hand, the ledger shows the server's current month: its time zone may put today in
  // another month than the viewer's, and the month changes at midnight on its last day.
  if(!monthPicked&&usage.day.slice(0,7)!==selectedMonth){selectedMonth=usage.day.slice(0,7);pickedDay=null;monthLoadedAt=0;rebuildMonths();void refreshMonth(true);return}
  redrawMonth=()=>renderMonth(usage,previous);shownMonth=usage;
  unreported=Object.fromEntries(Object.entries(usage.reported??{}).filter(([,seen])=>seen===false).map(([key])=>[key,true]));
  earliestMonth=usage.firstMonth;rebuildMonths();const current=selectedMonth===usage.day.slice(0,7);
  text('#month-period',[monthLabel(selectedMonth),current?t('ledger.through',{day:dayLabel(usage.day)}):null,usage.timeZone?t('ledger.zone',{timeZone:usage.timeZone}):null].filter(Boolean).join(' | '));
  $('#month-period').classList.remove('month-load-error');
  setHtml('#month-metrics',kpiHtml(usage,previous,unreported));
  // The calendar opens on today in the current month, otherwise on the month's last day with records.
  if(!pickedDay?.startsWith(selectedMonth))pickedDay=current?usage.day:usage.days.at(-1)?.day??`${selectedMonth}-01`;
  const focused=document.activeElement?.closest?.('#ledger-panel [data-day]')?.dataset.day;
  $('#ledger-panel').dataset.month=usage.month;
  setHtml('#ledger-panel',ledgerView==='calendar'?calendarHtml(usage,previous,pickedDay,unreported):ledgerView==='charts'?chartsHtml(usage,previous,unreported):statementHtml(usage,unreported));
  if(focused)$(`#ledger-panel [data-day="${focused}"]`)?.focus();
  setHtml('#model-table',modelTableHtml(usage,unreported));
  const csv=$('#token-csv'),label=t('ledger.csvLabel',{month:monthLabel(selectedMonth)});csv.disabled=false;csv.title=label;csv.setAttribute('aria-label',label);
  renderToday(latest?.usage);
}
// key names the message shown in place of the month (loading, or an error).
function clearMonth(key,isError=false) {
  redrawMonth=()=>clearMonth(key,isError);shownMonth=null;delete $('#ledger-panel').dataset.month;const message=t(key);
  text('#month-period',message);$('#month-period').classList.toggle('month-load-error',isError);
  $('#month-metrics').innerHTML='';$('#ledger-panel').innerHTML=`<p class="ledger-note">${esc(message)}</p>`;$('#model-table').innerHTML='';$('#token-csv').disabled=true;
}
async function fetchMonth(month,signal){const res=await fetch(`/api/usage?month=${encodeURIComponent(month)}`,{cache:'no-store',signal});if(!res.ok)throw new Error('HTTP '+res.status);return validateMonth(await res.json(),month)}
// The month before, for the comparison and the running total; without it the month is still drawn.
async function previousData(month,signal){
  const prev=previousMonth(month),kept=pastMonths.get(prev);
  if(earliestMonth&&prev<earliestMonth)return null;
  if(kept&&Date.now()-kept.at<300_000)return kept.data;
  try{const data=await fetchMonth(prev,signal);pastMonths.set(prev,{data,at:Date.now()});return data}catch{return kept?.data??null}
}
async function refreshMonth(force=false) {
  if(!force&&(monthController||Date.now()-monthLoadedAt<10000))return;
  const sequence=++monthSequence,month=selectedMonth;monthController?.abort();const controller=new AbortController();monthController=controller;const timer=setTimeout(()=>controller.abort(),8000);
  try{const [payload,previous]=await Promise.all([fetchMonth(month,controller.signal),previousData(month,controller.signal)]);if(sequence===monthSequence){renderMonth(payload,previous);monthLoadedAt=Date.now()}}catch{if(sequence===monthSequence)clearMonth('ledger.loadError',true)}finally{clearTimeout(timer);if(sequence===monthSequence)monthController=null}
}
function pickMonth(month){if(!/^\d{4}-\d{2}$/.test(month))return;monthPicked=true;selectedMonth=month;pickedDay=null;monthLoadedAt=0;rebuildMonths();clearMonth('ledger.loading');void refreshMonth(true)}
$('#token-months').addEventListener('click',event=>{const button=event.target.closest('button[data-month]');if(button)pickMonth(button.dataset.month)});
$('#token-months').addEventListener('change',event=>{if(event.target.matches('select'))pickMonth(event.target.value)});
onMediaChange(narrowQuery,rebuildMonths);
function showLedgerView(view,focus=false){
  ledgerView=view;
  document.querySelectorAll('[data-ledger-tab]').forEach(tab=>{const on=tab.dataset.ledgerTab===view;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;if(on){$('#ledger-panel').setAttribute('aria-labelledby',tab.id);if(focus)tab.focus()}});
  redrawMonth();
}
document.querySelectorAll('[data-ledger-tab]').forEach(tab=>{tab.addEventListener('click',()=>showLedgerView(tab.dataset.ledgerTab));tab.addEventListener('keydown',event=>{const tabs=[...document.querySelectorAll('[data-ledger-tab]')],index=tabs.indexOf(tab);const next={ArrowRight:index+1,ArrowLeft:index-1,Home:0,End:tabs.length-1}[event.key];if(next===undefined)return;event.preventDefault();showLedgerView(tabs[(next+tabs.length)%tabs.length].dataset.ledgerTab,true)})});
$('#ledger-panel').addEventListener('click',event=>{const day=event.target.closest('[data-day]');if(day&&!day.disabled){pickedDay=day.dataset.day;redrawMonth()}});
// The CSV is built here from the month on screen and saved through a temporary Blob URL.
$('#token-csv').addEventListener('click',()=>{
  if(!shownMonth)return;
  const url=URL.createObjectURL(new Blob([ledgerCsv(shownMonth,unreported)],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');
  link.href=url;link.download=`spark-scope-tokens-${shownMonth.month}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function selectTab(btn,updateHash=true) {
  document.querySelectorAll('.top [role=tab]').forEach(b=>{b.setAttribute('aria-selected',String(b===btn));b.tabIndex=b===btn?0:-1;$('#'+b.getAttribute('aria-controls')).hidden=b!==btn});
  const tokens=btn.id==='tab-tokens';if(updateHash)location.hash=tokens?'tokens':'scope';if(tokens)void refreshMonth();
}
document.querySelectorAll('.top [role=tab]').forEach(btn=>{btn.addEventListener('click',()=>selectTab(btn));btn.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?$('#tab-scope'):e.key==='End'?$('#tab-tokens'):btn.id==='tab-scope'?$('#tab-tokens'):$('#tab-scope');selectTab(next);next.focus()}})});
window.addEventListener('hashchange',()=>selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false));
function showRange(){document.querySelectorAll('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.range)===range)))}
document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{range=Number(btn.dataset.range);showRange();void refresh()}));
// ---- settings dialog ----
const dialog=$('#settings'),form=dialog.querySelector('form'),opener=$('#settings-open');
let previewId=null;
function showUnits(){text('#temp-range',t('trends.selectedRange',{unit:temperatureUnit(settings.temp)}));text('#mem-range',t('trends.selectedRange',{unit:memoryUnit(settings.mem)}))}
// Puts the current settings into the form controls.
function syncForm(){
  for(const [name,value] of Object.entries({...settings,theme:themeChoice??'system'}))for(const input of form.querySelectorAll(`input[name="${name}"]:not([type=number])`))input.type==='checkbox'?input.checked=Boolean(value):input.checked=input.value===String(value);
  form.querySelectorAll('select[name="reading"]').forEach(select=>{const slot=Number(select.dataset.slot);const options=READING_IDS.map(id=>`<option value="${id}">${esc(t(`node.reading.${id}`))}</option>`).join('');if(select.innerHTML!==options)select.innerHTML=options;select.value=settings.readings[slot]});
  form.querySelectorAll('[data-slot-label]').forEach(el=>{el.textContent=t('settings.card.slot',{n:Number(el.dataset.slotLabel)+1})});
  form.querySelectorAll('input[name="bar"]').forEach(input=>{input.checked=settings.bars.includes(input.value)});
  form.querySelectorAll('input[name="panel"]').forEach(input=>{input.checked=!settings.hide.includes(input.value)});
  // The temperature level is kept in °C and shown in the chosen unit.
  const f=settings.temp==='f',warnTemp=form.querySelector('input[name="tempWarn"]');warnTemp.min=f?104:40;warnTemp.max=f?230:110;warnTemp.value=f?Math.round(settings.tempWarn*9/5+32):settings.tempWarn;$('#warn-temp-unit').textContent=t('settings.card.warnTempUnit',{unit:temperatureUnit(settings.temp)});
  form.querySelector('input[name="diskWarn"]').value=settings.diskWarn;form.querySelector('input[name="memWarn"]').value=settings.memWarn;
}
// Labels and panels follow the settings on the page itself.
function showLayout(){
  document.documentElement.dataset.labels=settings.labels;
  if(settings.design==='default')delete document.documentElement.dataset.design;else document.documentElement.dataset.design=settings.design;
  $('#engines').hidden=settings.hide.includes('engine');
  const trends=settings.hide.includes('trends'),ledger=settings.hide.includes('ledger');$('.trends').hidden=trends;$('#today-ledger').hidden=ledger;$('.lower').hidden=trends&&ledger;$('.lower').classList.toggle('single',trends!==ledger);
}
// One node's card drawn with the current settings and live data, the update time on the chosen clock, and About.
function renderPreview({rows=true}={}){
  const select=$('#preview-node'),options=metas.map(meta=>`<option value="${esc(meta.id)}">${esc(meta.name)}</option>`).join('');
  if(select.innerHTML!==options)select.innerHTML=options;select.hidden=metas.length<2;
  if(!metas.some(meta=>meta.id===previewId))previewId=metas[0]?.id??null;select.value=previewId??'';
  const meta=metas.find(item=>item.id===previewId),box=$('#preview-nodes');
  box.innerHTML=meta?cardHtml(meta):'';if(meta)renderNode(meta,latest?.nodes?.[meta.id],box);if(rows)renderColorRows();
  $('#preview-clock').textContent=clock(latest?.updatedAt??Date.now());
  const intervals=latest?.pollIntervals,every=ms=>finite(ms)?` | ${t('settings.about.every',{seconds:fixed(ms/1000,ms%1000?1:0)})}`:'';
  $('#about-version').textContent=latest?.version??unknown();
  $('#about-engine').textContent=(latest?.serving?.engine??unknown())+every(intervals?.apiMs);
  $('#about-nodes').textContent=metas.length?t('settings.about.nodeCount',{count:metas.length})+every(intervals?.nodeMs):unknown();
  renderRack();
}
// Every change applies at once: saved, drawn on the page behind the dialog and in the preview. While the server is
// not answering, the last data is drawn again under the "not responding" state, so its text follows a new language too.
function applySettings({rangeChanged=false,refreshChanged=false,langChanged=false}={}){
  saveSettings(store,settings);
  if(langChanged){setLanguage(settings.lang);translatePage();applyTheme();rebuildMonths();redrawMonth();showMini()}
  showUnits();showLayout();
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
  const before=settings;let next;
  // Picking a reading another slot already shows swaps the two.
  if(input.name==='reading'){const slot=Number(input.dataset.slot),readings=[...settings.readings],other=readings.indexOf(input.value);if(other>=0)readings[other]=readings[slot];readings[slot]=input.value;next={readings};input.closest('label').classList.remove('flash')}
  else if(input.name==='bar')next={bars:[...form.querySelectorAll('input[name="bar"]:checked')].map(box=>box.value)};
  else if(input.name==='panel')next={hide:[...form.querySelectorAll('input[name="panel"]:not(:checked)')].map(box=>box.value)};
  else if(input.name==='tempWarn'){const value=Number(input.value);next={tempWarn:Math.round(settings.temp==='f'?(value-32)*5/9:value)}}
  else if(input.name==='diskWarn'||input.name==='memWarn')next={[input.name]:Math.round(Number(input.value))};
  else next={[input.name]:input.type==='checkbox'?input.checked:['range','refresh'].includes(input.name)?Number(input.value):input.value};
  // An out-of-range level falls back to the default; the form then shows what applies.
  settings=parseSettings({...settings,...next});
  applySettings(changes(before));
});
// ---- node colours ----
// A node's colour as picked, or its default: the palette in order without red, which is never a default.
const colorOf=index=>settings.colors[index]??PALETTE[index%(PALETTE.length-1)];
function renderColorRows(force=false){
  const rows=metas.map((meta,index)=>{const current=colorOf(index),custom=current.startsWith('#'),low=custom?lowContrast(current):null;
    return `<div class="crow" data-node-row="${index}" aria-current="${meta.id===previewId}"><div class="cname"><i style="background:${nodeColor(settings.colors,index)}"></i><span>${esc(meta.name)}<small>${t('settings.colors.node',{n:index+1})}</small></span></div><div><div class="swatches">${PALETTE.map(name=>`<button type="button" class="sw" data-color="${index}" data-value="${name}" aria-pressed="${current===name}" aria-label="${t(`settings.color.${name}`)}" title="${t(`settings.color.${name}`)}" style="background:var(--${name})"></button>`).join('')}<label class="custom"><span>${t('settings.colors.custom')}</span><input type="color" data-custom="${index}" value="${custom?current:'#7cbbeb'}" class="${custom?'picked':''}" aria-label="${t('settings.colors.customFor',{node:meta.name})}"></label></div>${low?`<p class="contrast">${t(`settings.colors.low.${low}`)}</p>`:''}</div></div>`}).join('');
  // Left alone while a colour picker in it is open, so the next poll does not close it.
  const box=$('#color-rows');if(box.innerHTML!==rows&&(force||!box.contains(document.activeElement?.closest('[data-custom]'))))box.innerHTML=rows;
}
// A colour for one node: the list is filled up to that node with the current colours, and a list equal to the
// defaults is stored as no choice at all.
function setColor(index,value){
  const list=metas.map((_,k)=>colorOf(k));list[index]=value;
  const before=settings;settings=parseSettings({...settings,colors:list.every((color,k)=>color===PALETTE[k%(PALETTE.length-1)])?[]:list});
  previewId=metas[index]?.id??previewId;applySettings(changes(before));
}
$('#color-rows').addEventListener('click',event=>{
  const swatch=event.target.closest('.sw');if(swatch){setColor(Number(swatch.dataset.color),swatch.dataset.value);return}
  const row=event.target.closest('.crow');if(row&&!event.target.closest('.custom')){previewId=metas[Number(row.dataset.nodeRow)]?.id??previewId;renderPreview()}
});
// The colour picker reports while it is dragged; the page follows at once, the row is redrawn when the picker closes.
$('#color-rows').addEventListener('input',event=>{const input=event.target.closest('[data-custom]');if(!input)return;const index=Number(input.dataset.custom);settings=parseSettings({...settings,colors:metas.map((_,k)=>k===index?input.value:colorOf(k))});saveSettings(store,settings);previewId=metas[index]?.id??previewId;buildNodes();if(latest){try{drawState(latest)}catch{}}renderPreview({rows:false})});
// The picker has closed but its input keeps the focus: redraw the row anyway (selected swatch, contrast warning).
$('#color-rows').addEventListener('change',event=>{const input=event.target.closest('[data-custom]');if(!input)return;const index=input.dataset.custom;setColor(Number(index),input.value);renderColorRows(true);$('#color-rows').querySelector(`[data-custom="${index}"]`)?.focus()});
$('#colors-reset').addEventListener('click',()=>{const before=settings;settings=parseSettings({...settings,colors:[]});applySettings(changes(before))});

// Selecting a reading on the preview card opens its slot in Node card.
$('#preview-nodes').addEventListener('click',event=>{const reading=event.target.closest('.reading');if(!reading)return;showSection('card');const label=form.querySelector(`select[data-slot="${reading.dataset.slot}"]`)?.closest('label');if(label){form.querySelectorAll('.slots label').forEach(other=>other.classList.toggle('flash',other===label));label.querySelector('select').focus()}});
function showSection(name){
  dialog.querySelectorAll('[data-section]').forEach(button=>button.setAttribute('aria-current',String(button.dataset.section===name)));
  dialog.querySelectorAll('[data-panel]').forEach(panel=>{panel.hidden=panel.dataset.panel!==name});
}
dialog.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>showSection(button.dataset.section)));
opener.addEventListener('click',()=>{syncForm();renderPreview();$('#settings-link').hidden=true;dialog.showModal();opener.setAttribute('aria-expanded','true')});
dialog.addEventListener('close',()=>{hideHelp();opener.setAttribute('aria-expanded','false');opener.focus()});
// Clicking the dimmed page outside the dialog closes it; a text selection dragged out of a field does not.
let pressedOutside=false;
dialog.addEventListener('pointerdown',event=>{pressedOutside=event.target===dialog});
dialog.addEventListener('click',event=>{if(event.target===dialog&&pressedOutside)dialog.close()});
$('#settings-reset').addEventListener('click',()=>{const before=settings;settings=parseSettings(null);themeChoice=null;saveTheme(store,null);applyTheme();applySettings(changes(before))});
// The clipboard needs HTTPS or localhost; on plain HTTP the link is shown selected, ready to copy by hand.
// ---- mini window ----
// Chrome and Edge keep it on top of other windows with document picture-in-picture; other browsers get a small window
// at /mini/. The button (or M) opens it and closes it again.
const miniButton=$('#mini-open'),MINI_SIZE={width:340,height:560};let mini=null;
function showMini(){miniButton.setAttribute('aria-pressed',String(Boolean(mini)));miniButton.title=t(mini?'mini.closeTitle':'mini.openTitle');miniButton.setAttribute('aria-label',miniButton.title)}
async function toggleMini(){
  if(mini){mini.close();return}
  if(window.documentPictureInPicture){
    try{
      const pip=await window.documentPictureInPicture.requestWindow(MINI_SIZE);
      for(const href of ['/styles.css','/designs.css','/mini/mini.css']){const link=pip.document.createElement('link');link.rel='stylesheet';link.href=location.origin+href;pip.document.head.append(link)}
      pip.document.body.className='m-pip';
      const {mountMini}=await import('./mini/mini-view.js');
      const view=mountMini(pip.document,pip,{onOpenDashboard:()=>window.focus()});
      mini={close:()=>pip.close()};
      pip.addEventListener('pagehide',()=>{view.close();mini=null;showMini()});
      showMini();return;
    }catch(error){console.warn('Spark Scope could not open a picture-in-picture window, opening a small window instead:',error)}
  }
  const win=window.open('/mini/','spark-scope-mini',`popup,width=${MINI_SIZE.width},height=${MINI_SIZE.height}`);if(!win)return;
  mini={close:()=>win.close()};showMini();
  const watch=setInterval(()=>{if(win.closed){clearInterval(watch);mini=null;showMini()}},1000);
}
miniButton.addEventListener('click',()=>void toggleMini());
document.addEventListener('keydown',event=>{
  if(event.key!=='m'&&event.key!=='M')return;if(event.metaKey||event.ctrlKey||event.altKey||dialog.open||event.target.closest?.('input,select,textarea,[contenteditable]'))return;
  if(getComputedStyle(miniButton).display!=='none')void toggleMini();
});

// ---- rack panel settings ----
// Shown only where a rack panel is in use: one has polled this server within 7 days (rackSeenAt), or on request.
const RACK_SEEN_MS=7*24*3600_000;let rackForced=false;
const rackSeen=()=>{const at=Date.parse(latest?.rackSeenAt??'');return Number.isFinite(at)&&Date.now()-at<RACK_SEEN_MS?at:null};
function renderRack(){
  const seen=rackSeen(),visible=rackForced||seen!==null;
  dialog.querySelector('[data-section="rack"]').hidden=!visible;$('#rack-hint').hidden=visible;
  if(!visible&&dialog.querySelector('[data-section="rack"]').getAttribute('aria-current')==='true')showSection('dashboard');
  text('#rack-seen',seen!==null?t('settings.rack.seen',{time:eventTime(seen,Date.now(),{hour12:hour12()})}):t('settings.rack.notSeen'));
  const query=rackQuery(settings),url=`${location.origin}/rack/${query?`?${query}`:''}`,field=$('#kiosk-url');if(field.value!==url)field.value=url;
}
$('#rack-show').addEventListener('click',()=>{rackForced=true;renderRack();showSection('rack')});
// The same clipboard rule as the settings link: on plain HTTP the URL is left selected for copying by hand.
$('#kiosk-copy').addEventListener('click',async()=>{
  const field=$('#kiosk-url'),button=$('#kiosk-copy');let copied=false;
  try{await navigator.clipboard.writeText(field.value);copied=true}catch{}
  field.focus();field.select();button.textContent=t(copied?'settings.rack.copied':'settings.rack.copyManually');
  setTimeout(()=>{button.textContent=t('settings.rack.copy')},2500);
});

$('#settings-copy').addEventListener('click',async()=>{
  const query=settingsQuery(settings,themeChoice),url=location.origin+location.pathname+(query?`?${query}`:''),field=$('#settings-link'),button=$('#settings-copy');
  field.value=url;field.hidden=false;let copied=false;
  try{await navigator.clipboard.writeText(url);copied=true}catch{}
  field.focus();field.select();button.textContent=t(copied?'settings.linkCopied':'settings.copyManually');
  setTimeout(()=>{button.textContent=t('settings.copyLink')},2500);
});

showUnits();showLayout();showRange();syncForm();
buildNodes();rebuildMonths();clearMonth('ledger.loading');selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false);void refresh();
// With "pause while hidden" on (the default) a hidden tab sends no requests; when it is shown again it reloads the
// chart history at once, so the gap fills in.
function poll(){if(settings.pause&&document.hidden)return;void refresh();if(!$('#tokens').hidden)void refreshMonth()}
let pollTimer=null;
function schedulePolls(){clearInterval(pollTimer);pollTimer=setInterval(poll,settings.refresh*1000)}
schedulePolls();
document.addEventListener('visibilitychange',()=>{if(!document.hidden){historyAt=0;poll()}});
