/* ═══════════════════════════════════════════════════════════════════════════
   In.Plan · ClickHouse-коннектор, реестр таблиц, версии планов
   Зависимости из index.html: $, $$, esc, sany, nf, num, pnum, S, uq, grp,
   dtable, chBars, chH, chHeat, bn, mln, pc, build, render, go, plural,
   normalizePeriodKey, CH (палитра графиков), PAL, H, cv, TBL
   ВНИМАНИЕ: namespace CHX — не путать с CH (цвета графиков).
   ═════════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

const LS_PROFILES = 'inplan_ch_profiles_v1';
const LS_SCENARIO = 'inplan_ch_scenario_v1';
const LS_SESSION = 'inplan_ch_session_v1';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа с последней активности

/* ─────────────── 1. КОНФИГУРАЦИЯ ─────────────── */
const CHX = window.CHX = {
  cfg:{
    host:'clickhouse.k8s.b1gahmn2gdjf3lsm4jeh.in-plan.ru',
    port:443, proto:'https', user:'readonly', pass:'',
    useProxy:false, proxyUrl:'/api/ch',
    schemas:[], base:'', gran:4,
    detailOrders:2000            // сколько заказов тянуть детально в основную схему
  },
  state:{
    connected:false, dbs:[], granOptions:[], scenario:new Map(),
    lastError:null, busy:false
  },
  versions:[]                    // [{id,label,src,isBase,agg,dims}]
};

/* ─────────────── 1.1. АВТОСЕССИЯ НА 4 ЧАСА ───────────────
   Вариант 2: для автоматического переподключения после закрытия браузера
   сохраняем также пароль. Это осознанный компромисс удобства и безопасности:
   значение находится в localStorage и доступно JavaScript этого origin.
   Сессия удаляется автоматически после 4 часов бездействия. */
CHX.session = {
  disabled:false,
  read(){
    try{
      const raw = localStorage.getItem(LS_SESSION);
      if(!raw) return null;
      const rec = JSON.parse(raw);
      if(!rec || rec.v !== 1 || !rec.cfg || !rec.expiresAt || rec.expiresAt <= Date.now()){
        localStorage.removeItem(LS_SESSION);
        return null;
      }
      return rec;
    }catch(e){ return null }
  },
  save(){
    if(this.disabled) return false;
    const c = CHX.cfg, now = Date.now();
    const rec = {
      v:1,
      savedAt:now,
      expiresAt:now + SESSION_TTL_MS,
      cfg:{
        host:c.host, port:c.port, proto:c.proto, user:c.user, pass:c.pass,
        useProxy:!!c.useProxy, proxyUrl:c.proxyUrl,
        schemas:Array.isArray(c.schemas)?c.schemas.slice():[],
        base:c.base, gran:c.gran, detailOrders:c.detailOrders
      }
    };
    try{ localStorage.setItem(LS_SESSION, JSON.stringify(rec)); return true }
    catch(e){ console.warn('Автосессия не сохранена:',e); return false }
  },
  touch(){
    const ok=this.save();
    if(ok && typeof window.onCHSessionTouched==='function') window.onCHSessionTouched(this.read()?.expiresAt);
    return ok;
  },
  enable(){ this.disabled=false },
  clear(){ this.disabled=true; try{ localStorage.removeItem(LS_SESSION) }catch(e){} },
  exists(){ return !!this.read() },
  ttl(){
    const rec=this.read();
    return rec ? Math.max(0,rec.expiresAt-Date.now()) : 0;
  }
};
CHX.forgetSession = ()=>CHX.session.clear();

/* ─────────────── 2. РЕЕСТР ТАБЛИЦ ───────────────
   Добавление новой таблицы из ClickHouse = добавление одного объекта.
   role      — что таблица даёт дашборду (проверяется вкладками)
   mode      — 'agg' (только агрегаты) | 'detail' (построчно, с лимитом)
   dedupBy   — ключ идентичности строки для LIMIT 1 BY
   periodCol — колонка даты для гранулярности ('' = нет, период по номеру)
   ptypeCol  — колонка periodtype ('' = фильтр по гранулярности не применяется)
*/
const TABLES = CHX.TABLES = {
  marking_demand:{
    role:'core', required:true, mode:'detail',
    dedupBy:['order_id','order_operation_id','resource'],
    periodCol:'', ptypeCol:'', periodNumCol:'demand_period',
    label:'Ограниченный спрос и разузлование'
  },
  demand_coverage:{
    role:'demand', mode:'agg',
    dedupBy:['sys_id'], periodCol:'date', ptypeCol:'periodtype',
    label:'Входной спрос и покрытие'
  },
  capacity_view_sp:{
    role:'capacity_fact', mode:'agg',
    dedupBy:['sys_id'], periodCol:'date', ptypeCol:'periodtype',
    label:'Загрузка мощностей (факт прогона)'
  },
  rescapacity:{
    role:'capacity_plan', mode:'agg',
    dedupBy:['sys_id'], periodCol:'datefr', ptypeCol:'periodtype',
    label:'Плановые мощности ресурсов'
  },
  demand_cost:{
    role:'penalty_period', mode:'agg',
    dedupBy:['sys_id'], periodCol:'datefr', ptypeCol:'periodtype',
    label:'Стоимость спроса по периодам'
  },
  demand_cost_ti:{
    role:'penalty_flat', mode:'agg',
    dedupBy:['sys_id'], periodCol:'', ptypeCol:'',
    label:'Стоимость спроса без периодов'
  },
  /* Источники вне ClickHouse — грузятся из Excel, объявлены здесь же,
     чтобы вкладки проверяли наличие роли единообразно. */
  res_loc_loc:{ role:'route_limit', source:'excel', label:'Лимиты направлений' },
  scenario:{    role:'scenario',    source:'excel', label:'Названия версий' }
};

/* какие роли нужны вкладкам — для честного сообщения «источник отсутствует» */
CHX.TAB_NEEDS = {
  ov:['core'], dm:['core'], cov:['demand'], tree:['core'],
  lg:['core'], pd:['core','capacity_fact'], pc:['core'], st:['core'],
  cost:['penalty_period','penalty_flat'], caps:['capacity_fact','capacity_plan'],
  vs:[], raw:['core'], dq:[]
};
CHX.hasRole = role => Object.keys(TABLES).some(t =>
  TABLES[t].role === role && (CHX.loaded && CHX.loaded[t]));
CHX.loaded = {};

/* ─────────────── 3. ТРАНСПОРТ ─────────────── */
function endpoint(){
  const c = CHX.cfg;
  if(c.useProxy) return c.proxyUrl.replace(/\/+$/,'');
  return `${c.proto}://${c.host}:${c.port}`;
}
async function chQuery(sql, fmt){
  fmt = fmt || 'JSONEachRow';
  const c = CHX.cfg;
  const url = endpoint() + '/?' + new URLSearchParams({
    default_format: fmt,
    add_http_cors_header:'1',
    max_execution_time:'120',
    readonly:'1'
  });
  const headers = {'Content-Type':'text/plain; charset=utf-8'};
  if(!c.useProxy){
    if(c.user) headers['X-ClickHouse-User'] = c.user;
    if(c.pass) headers['X-ClickHouse-Key']  = c.pass;
  }
  let res;
  try{
    res = await fetch(url, {method:'POST', headers, body:sql, mode:'cors', credentials:'omit'});
  }catch(e){
    throw new Error('Сеть/CORS: браузер не смог обратиться к '+endpoint()+
      '. Проверьте CORS на стороне ClickHouse, валидность TLS-сертификата и доступность хоста. ('+e.message+')');
  }
  const text = await res.text();
  if(!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0,600)}`);
  if(fmt !== 'JSONEachRow') return text;
  return text.split('\n').filter(Boolean).map(l=>{
    try{ return JSON.parse(l) }catch(e){ return null }
  }).filter(Boolean);
}
CHX.query = chQuery;

/* ─────────────── 4. SQL-ХЕЛПЕРЫ ─────────────── */
const q = s => '`' + String(s).replace(/`/g,'') + '`';
const qs = s => "'" + String(s).replace(/'/g,"\\'") + "'";

/* Источник с дедупликацией: is_deleted=0 + последняя версия строки.
   ReplacingMergeTree без FINAL может отдать дубли, поэтому LIMIT 1 BY. */
function src(db, tbl, extraWhere){
  const t = TABLES[tbl] || {};
  const w = ['is_deleted = 0'];
  if(extraWhere) w.push('('+extraWhere+')');
  let s = `SELECT * FROM ${q(db)}.${q(tbl)} WHERE ${w.join(' AND ')}`;
  if(t.dedupBy && t.dedupBy.length)
    s += ` ORDER BY update_date_time DESC LIMIT 1 BY ${t.dedupBy.map(q).join(', ')}`;
  return '('+s+')';
}

/* Гранулярность: усечение даты под тип периода.
   3 — неделя, 4 — месяц (подтверждено), 5 — квартал, 6 — год, прочее — день. */
function bucketExpr(col, gran){
  const g = Number(gran);
  if(g === 3) return `toMonday(toDate(${q(col)}))`;
  if(g === 4) return `toStartOfMonth(toDate(${q(col)}))`;
  if(g === 5) return `toStartOfQuarter(toDate(${q(col)}))`;
  if(g === 6) return `toStartOfYear(toDate(${q(col)}))`;
  return `toDate(${q(col)})`;
}
function periodKeyExpr(tbl, gran){
  const t = TABLES[tbl];
  if(!t.periodCol) return t.periodNumCol ? `toString(${q(t.periodNumCol)})` : `''`;
  const g = Number(gran);
  const b = bucketExpr(t.periodCol, gran);
  if(g === 4 || g === 5 || g === 6) return `formatDateTime(${b}, '%Y-%m')`;
  return `formatDateTime(${b}, '%Y-%m-%d')`;
}
function granWhere(tbl, gran){
  const t = TABLES[tbl];
  return t.ptypeCol ? `${q(t.ptypeCol)} = ${Number(gran)}` : '';
}
CHX.sql = {src, periodKeyExpr, granWhere, q, qs};

/* ─────────────── 5. ОБНАРУЖЕНИЕ СХЕМ И ГРАНУЛЯРНОСТЕЙ ─────────────── */
CHX.connect = async function(){
  CHX.state.busy = true; CHX.state.lastError = null;
  try{
    /* Полный список баз; фильтр data_public* — без учёта регистра,
       т.к. в кластере базы называются «Data_public_N» с заглавной буквы */
    const all = await chQuery(`SELECT name FROM system.databases ORDER BY name`);
    const names = all.map(r=>String(r.name));
    const sysDb = new Set(['system','information_schema','INFORMATION_SCHEMA','default']);
    CHX.state.allDbs = names;
    let hit = names.filter(n=>n.toLowerCase().startsWith('data_public'));
    CHX.state.dbs = hit.length ? hit : names.filter(n=>!sysDb.has(n));
    CHX.state.fallbackAll = !hit.length;
    if(!CHX.state.dbs.length)
      throw new Error("Подключение прошло, но список баз пуст. Проверьте права пользователя на system.databases.");
    /* мета по каждой схеме: свежесть и объём */
    const metas = await Promise.allSettled(CHX.state.dbs.map(async db=>{
      const r = await chQuery(
        `SELECT count() AS n, max(update_date_time) AS ts
         FROM ${q(db)}.${q('marking_demand')} WHERE is_deleted = 0`);
      return {db, n:num(r[0]&&r[0].n), ts:(r[0]&&r[0].ts)||''};
    }));
    CHX.state.meta = {};
    metas.forEach(m=>{ if(m.status==='fulfilled') CHX.state.meta[m.value.db]=m.value; });
    /* гранулярности — динамически из данных основной/первой схемы */
    const probe = CHX.cfg.base || CHX.state.dbs[0];
    try{
      const g = await chQuery(
        `SELECT periodtype AS t, count() AS n FROM ${q(probe)}.${q('demand_coverage')}
         WHERE is_deleted = 0 GROUP BY t ORDER BY n DESC`);
      CHX.state.granOptions = g.map(r=>({t:num(r.t), n:num(r.n)})).filter(x=>x.t);
    }catch(e){ CHX.state.granOptions = [{t:4,n:0}]; }
    if(!CHX.state.granOptions.length) CHX.state.granOptions = [{t:4,n:0}];
    if(!CHX.state.granOptions.some(o=>o.t===CHX.cfg.gran))
      CHX.cfg.gran = CHX.state.granOptions[0].t;
    CHX.state.connected = true;
    CHX.session.enable();
    // Успешное подключение продлевает автосессию ещё на 4 часа.
    CHX.session.touch();
    return CHX.state.dbs;
  }catch(e){
    CHX.state.connected = false; CHX.state.lastError = e.message; throw e;
  }finally{ CHX.state.busy = false; }
};

/* ─────────────── 5.1. ВОССТАНОВЛЕНИЕ АВТОСЕССИИ ─────────────── */
let sessionRestoreBusy = false;
let lastSessionCheck = 0;
function emitSessionStatus(type, extra){
  if(typeof window.onCHSessionStatus === 'function')
    window.onCHSessionStatus(Object.assign({type}, extra||{}));
}
CHX.restoreSession = async function(){
  if(sessionRestoreBusy || CHX.state.busy) return false;
  const rec = CHX.session.read();
  if(!rec) return false;
  /* Excel is the last active source: an old CH session must not overwrite it. */
  if(typeof window.getActiveDatasetSource==='function' &&
     window.getActiveDatasetSource()==='excel') return false;
  sessionRestoreBusy = true;
  lastSessionCheck = Date.now();
  Object.assign(CHX.cfg, rec.cfg, {
    schemas:Array.isArray(rec.cfg.schemas)?rec.cfg.schemas.slice():[],
    pass:String(rec.cfg.pass||'')
  });
  emitSessionStatus('restoring', {expiresAt:rec.expiresAt});
  try{
    await CHX.connect();
    /* Loading the dataset is part of session restoration; connection alone
       must not leave the dashboard on demo data. */
    if(CHX.cfg.schemas.length) await CHX.loadAll();
    emitSessionStatus('restored', {expiresAt:CHX.session.read()?.expiresAt||Date.now()+SESSION_TTL_MS});
    return true;
  }catch(e){
    CHX.state.connected = false;
    CHX.state.lastError = e.message;
    emitSessionStatus('error', {error:e.message, expiresAt:rec.expiresAt});
    return false;
  }finally{ sessionRestoreBusy = false }
};

CHX.checkSession = async function(force){
  const rec = CHX.session.read();
  if(!rec) return false;
  const now = Date.now();
  if(!force && now-lastSessionCheck < 30000) return CHX.state.connected;
  lastSessionCheck = now;
  if(sessionRestoreBusy || CHX.state.busy) return CHX.state.connected;
  if(CHX.state.connected){
    try{
      await chQuery('SELECT 1 AS ok');
      CHX.session.touch();
      emitSessionStatus('active', {expiresAt:CHX.session.read()?.expiresAt||Date.now()+SESSION_TTL_MS});
      return true;
    }catch(e){
      CHX.state.connected = false;
      CHX.state.lastError = e.message;
    }
  }
  return CHX.restoreSession();
};
/* Пересчёт доступных гранулярностей по выбранной основной схеме:
   у разных версий планов набор periodtype может отличаться */
CHX.refreshGran = async function(db){
  db = db || CHX.cfg.base;
  if(!db) return;
  try{
    const g = await chQuery(
      `SELECT periodtype AS t, count() AS n FROM ${q(db)}.${q('demand_coverage')}
       WHERE is_deleted = 0 GROUP BY t ORDER BY n DESC`);
    CHX.state.granOptions = g.map(r=>({t:num(r.t), n:num(r.n)})).filter(x=>x.t);
  }catch(e){
    /* у схемы нет demand_coverage — показываем месяцы как безопасный дефолт */
    CHX.state.granOptions = [{t:4,n:0}];
  }
  if(!CHX.state.granOptions.length) CHX.state.granOptions = [{t:4,n:0}];
  /* если текущая гранулярность в новой схеме отсутствует — берём самую массовую */
  if(!CHX.state.granOptions.some(o=>o.t===CHX.cfg.gran))
    CHX.cfg.gran = CHX.state.granOptions[0].t;
};
const GRAN_LABEL = {1:'День',2:'Тип 2',3:'Неделя',4:'Месяц',5:'Квартал',6:'Год'};
CHX.granLabel = t => GRAN_LABEL[t] || ('Тип '+t);

/* ─────────────── 6. ПРОФИЛИ ПОДКЛЮЧЕНИЯ (без пароля) ─────────────── */
CHX.profiles = {
  all(){ try{ return JSON.parse(localStorage.getItem(LS_PROFILES)||'[]') }catch(e){ return [] } },
  save(name){
    const c = CHX.cfg, list = CHX.profiles.all().filter(p=>p.name!==name);
    list.unshift({name, host:c.host, port:c.port, proto:c.proto, user:c.user,
      useProxy:c.useProxy, proxyUrl:c.proxyUrl, schemas:c.schemas.slice(),
      base:c.base, gran:c.gran});
    localStorage.setItem(LS_PROFILES, JSON.stringify(list.slice(0,10)));
  },
  apply(name){
    const p = CHX.profiles.all().find(x=>x.name===name);
    if(!p) return false;
    Object.assign(CHX.cfg, p, {pass:''});  // пароль намеренно не восстанавливаем
    return true;
  },
  drop(name){
    localStorage.setItem(LS_PROFILES,
      JSON.stringify(CHX.profiles.all().filter(p=>p.name!==name)));
  }
};

/* ─────────────── 7. НАЗВАНИЯ ВЕРСИЙ (scenario.xlsx) ─────────────── */
CHX.loadScenarioFile = function(file){
  return new Promise((resolve,reject)=>{
    if(typeof XLSX === 'undefined') return reject(new Error('SheetJS недоступен'));
    const fr = new FileReader();
    fr.onload = e=>{
      try{
        const wb = XLSX.read(e.target.result,{type:'array',cellDates:true});
        const sh = wb.SheetNames.find(n=>/scenario/i.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sh],{defval:''});
        const map = new Map();
        rows.forEach(r=>{
          const pick = keys=>{
            for(const k of Object.keys(r)){
              const kk = k.toLowerCase().replace(/[\s_\-]/g,'');
              if(keys.includes(kk) && r[k]!=='') return r[k];
            }
            return '';
          };
          const sysId  = String(pick(['sysid','id'])||'').trim();
          const schema = String(pick(['database','schema','db'])||'').trim();
          const name   = String(pick(['name','название'])||'').trim();
          if(!name) return;
          const rec = {name,
            comment:String(pick(['comment','описание'])||''),
            author:String(pick(['author','автор'])||''),
            created:String(pick(['createdatetime','createdate'])||''),
            type:String(pick(['type'])||''), tag:String(pick(['tag'])||''),
            sysId, schema};
          if(schema) map.set('db:'+schema.toLowerCase(), rec);
          if(sysId)  map.set('id:'+sysId, rec);
        });
        CHX.state.scenario = map;
        try{ localStorage.setItem(LS_SCENARIO, JSON.stringify([...map])) }catch(e){}
        CHX.relabelVersions();
        resolve(map.size);
      }catch(err){ reject(err) }
    };
    fr.onerror = ()=>reject(new Error('Не удалось прочитать файл'));
    fr.readAsArrayBuffer(file);
  });
};
(function restoreScenario(){
  try{
    const raw = localStorage.getItem(LS_SCENARIO);
    if(raw) CHX.state.scenario = new Map(JSON.parse(raw));
  }catch(e){}
})();

/* Сопоставление схемы с записью scenario:
   1) прямая колонка database/schema; 2) числовой суффикс схемы == sys_id;
   3) техническое имя схемы. */
CHX.labelFor = function(db){
  const m = CHX.state.scenario;
  if(!m || !m.size) return db;
  const direct = m.get('db:'+String(db).toLowerCase());
  if(direct) return direct.name;
  const suf = String(db).match(/(\d+)$/);
  if(suf){
    const byId = m.get('id:'+suf[1]);
    if(byId) return byId.name;
  }
  return db;
};
CHX.relabelVersions = function(){
  CHX.versions.forEach(v=>{ if(v.src==='ch') v.label = CHX.labelFor(v.id) });
  if(typeof render === 'function' && window.DS) render();
};
CHX.unmatchedSchemas = () =>
  (CHX.cfg.schemas||[]).filter(db => CHX.labelFor(db) === db);

/* ─────────────── 8. АГРЕГАТЫ ВЕРСИИ (считает ClickHouse) ─────────────── */
async function loadVersionAgg(db, gran){
  const out = {db, gran, totals:{}, dims:{}, notes:[]};
  const S_MD = src(db,'marking_demand');

   /* 8.1 финансы и объёмы: дедуп до уровня заказа, потом агрегация.
     ВАЖНО: колонки подзапроса названы с префиксом o_ — ClickHouse подставляет
     алиасы глобально по запросу, и если подзапрос даёт колонку «unm», а внешняя
     выборка объявляет sum(unm) AS unm, то внутри sum(unm*mpt) «unm» разворачивается
     в sum(unm) → ILLEGAL_AGGREGATION (ошибка 184). Префикс разрывает конфликт. */
  const ordSub = `(SELECT order_id,
      any(${q('demand_period')})   AS o_p,
      any(${q('demand_product')})  AS o_prod,
      any(${q('demand_client')})   AS o_cl,
      any(${q('demand_location')}) AS o_loc,
      any(${q('demand_volume')})   AS o_dem,
      any(${q('results_sale')})    AS o_sal,
      any(${q('unsatisfied_demand')}) AS o_unm,
      any(${q('revenue')})         AS o_rev,
      any(abs(${q('cost_of_demand')})) AS o_cost,
      any(${q('total_margin')})    AS o_mar,
      any(${q('margin_per_unit')}) AS o_mpt
    FROM ${S_MD} GROUP BY order_id)`;

  /* toFloat64: unsatisfied_demand и margin_per_unit — Decimal(18,12),
     их произведение переполняет десятичный разряд (ошибка 407) */
  const tot = await chQuery(`SELECT count() AS orders,
      sum(toFloat64(o_rev)) AS rev, sum(toFloat64(o_cost)) AS cost, sum(toFloat64(o_mar)) AS mar,
      sum(toFloat64(o_dem)) AS dem, sum(toFloat64(o_sal)) AS sal, sum(toFloat64(o_unm)) AS unm,
      sum(toFloat64(o_unm)*toFloat64(o_mpt)) AS lm,
      avg(toFloat64(o_mpt)) AS avgMpt,
      countIf(toFloat64(o_unm) <= 0.000000001) AS full
    FROM ${ordSub}`);
  Object.assign(out.totals, tot[0]||{});

  /* 8.2 затраты по блокам операций.
     toFloat64: cost_rate_of_operation и order_operation_volume — Decimal(18,12),
     их произведение переполняет разряд (ошибка 407) */
  const ops = await chQuery(`SELECT ${q('operation_type')} AS t,
      sum(toFloat64(abs(${q('cost_rate_of_operation')})) * toFloat64(${q('order_operation_volume')})) AS c,
      sum(toFloat64(${q('order_operation_volume')})) AS v, count() AS n
    FROM ${S_MD} GROUP BY t`);
  out.totals.byOp = {};
  ops.forEach(r=>{ out.totals.byOp[r.t] = {c:num(r.c), v:num(r.v), n:num(r.n)} });

  /* 8.3 разрезы для тепловой карты сравнения.
     Внешний SELECT ссылается только на колонки подзапроса o_*: подзапрос
     отдаёт o_p / o_prod / o_cl (префикс против глобальной подстановки алиасов,
     ошибка 184), поэтому имена без префикса ClickHouse не находит —
     «Unknown expression identifier 'p'» (ошибка 47). */
  const dimQ = alias => chQuery(
    `SELECT ${q('o_'+alias)} AS k, sum(o_mar) AS mar, sum(o_sal) AS sal, sum(o_unm) AS unm, sum(o_rev) AS rev
     FROM ${ordSub} GROUP BY k ORDER BY mar DESC LIMIT 60`);
  const [dP,dPr,dCl] = await Promise.all([dimQ('p'), dimQ('prod'), dimQ('cl')]);
  out.dims.period  = dP.map(r=>({k:String(r.k), mar:num(r.mar), sal:num(r.sal), unm:num(r.unm)}));
  out.dims.product = dPr.map(r=>({k:String(r.k), mar:num(r.mar), sal:num(r.sal), unm:num(r.unm)}));
  out.dims.client  = dCl.map(r=>({k:String(r.k), mar:num(r.mar), sal:num(r.sal), unm:num(r.unm)}));

  /* 8.4 покрытие спроса: неограниченный = выполнено + не выполнено */
  try{
    const gw = granWhere('demand_coverage', gran);
    const pk = periodKeyExpr('demand_coverage', gran);
    const S_DC = src(db,'demand_coverage', gw);
    const cov = await chQuery(`SELECT
        sum(${q('fullfilleddemandqty')} + ${q('unfullfilleddemandqty')}) AS demUnc,
        sum(${q('fullfilleddemandqty')})    AS ff,
        sum(${q('unfullfilleddemandqty')})  AS uf,
        sum(${q('demandfullfilledintimeqty')}) AS inTime,
        sum(${q('demandfullfilledlateqty')})   AS late,
        sum(${q('lostrevenue')})   AS lostRev,
        sum(${q('plannedrevenue')}) AS planRev,
        sum(${q('propagated_demand')}) AS prop
      FROM ${S_DC}`);
    out.totals.cov = cov[0] || {};
    const covP = await chQuery(`SELECT ${pk} AS k,
        sum(${q('fullfilleddemandqty')} + ${q('unfullfilleddemandqty')}) AS demUnc,
        sum(${q('fullfilleddemandqty')}) AS ff,
        sum(${q('unfullfilleddemandqty')}) AS uf,
        sum(${q('demandfullfilledlateqty')}) AS late
      FROM ${S_DC} GROUP BY k ORDER BY k`);
    out.dims.coverage = covP.map(r=>({k:r.k, demUnc:num(r.demUnc), ff:num(r.ff),
      uf:num(r.uf), late:num(r.late)}));
    CHX.loaded.demand_coverage = true;
  }catch(e){ out.notes.push('demand_coverage: '+e.message) }

  /* 8.5 мощности: единицы — ЧАСЫ (calendarcapacity/OEE), не тонны.
     Свободно берём расчётом avail − load: поле freecapacity в примере
     расходится (411 против 423) и не согласуется с составляющими. */
  try{
    const gw = granWhere('capacity_view_sp', gran);
    const pk = periodKeyExpr('capacity_view_sp', gran);
    const S_CV = src(db,'capacity_view_sp', gw);
    const availExpr = `if(${q('calcavailablebucketcapacity')} > 0,
        ${q('calcavailablebucketcapacity')}, ${q('netavailablecapacity')})`;
    const cap = await chQuery(`SELECT
        ${q('res')} AS rs, any(${q('loc')}) AS pl,
        any(${q('restypedescr')}) AS resTypeDescr, any(${q('restype')}) AS resType,
        any(${q('resgroup')}) AS grp, ${pk} AS periodKey,
        sum(${q('calendarcapacity')}) AS norm,
        sum(${availExpr})             AS avail,
        sum(${q('totalcapausage')})   AS load,
        sum(${q('inipcapaplannedusage')})   AS useIp,
        sum(${q('pcapaplannedusage')})      AS useP,
        sum(${q('scapaplannedusage')})      AS useS,
        sum(${q('transcapaplannedusage')})  AS useT,
        sum(${q('maintenance')} + ${q('plannedmaintenance')} +
            ${q('capitalmaintenance')} + ${q('externalmaintenance')}) AS maint,
        avg(${q('oee')}) AS oee
      FROM ${S_CV} GROUP BY rs, periodKey`);
    out.capacity = cap.map(r=>{
      const avail = num(r.avail), load = num(r.load);
      const free = Math.max(0, avail - load);
      const util = avail > 0 ? Math.min(1, load/avail) : (load > 0 ? 1 : 0);
      return {rs:sany(r.rs), pl:sany(r.pl), rsName:sany(r.rs),
        resType:sany(r.resTypeDescr) || ('Тип '+r.resType), resTypeCode:num(r.resType),
        grp:sany(r.grp), periodKey:String(r.periodKey||''), cat:'production', unit:'h',
        norm:num(r.norm), avail, load, free, util,
        use:{ip:num(r.useIp), p:num(r.useP), s:num(r.useS), t:num(r.useT)},
        maint:num(r.maint), oee:num(r.oee),
        isBottleneck: util >= 0.90, isCrit: util >= 0.999};
    });
    out.totals.capAvail = S(out.capacity,c=>c.avail);
    out.totals.capLoad  = S(out.capacity,c=>c.load);
    out.totals.capUtil  = out.totals.capAvail>0 ? out.totals.capLoad/out.totals.capAvail : 0;
    out.totals.bnCount  = out.capacity.filter(c=>c.isBottleneck).length;
    out.resTypes        = uq(out.capacity, c=>c.resType);   // справочник строим из данных
    CHX.loaded.capacity_view_sp = true;
  }catch(e){ out.notes.push('capacity_view_sp: '+e.message) }

  /* 8.6 плановые мощности (rescapacity) — вход прогона, для «план vs факт» */
  try{
    const gw = granWhere('rescapacity', gran);
    const pk = periodKeyExpr('rescapacity', gran);
    const S_RC = src(db,'rescapacity', gw);
    const rc = await chQuery(`SELECT ${q('res')} AS rs, any(${q('loc')}) AS pl,
        ${pk} AS periodKey,
        sum(${q('calendarcapacity')})     AS norm,
        sum(${q('netavailbucketcapacity')}) AS availNet,
        sum(${q('availbucketcapacity')})  AS avail,
        sum(${q('capaexpansion')})        AS expansion,
        sum(${q('maintenance')} + ${q('plannedmaintenance')}) AS maint
      FROM ${S_RC} GROUP BY rs, periodKey`);
    out.capacityPlan = rc.map(r=>({rs:sany(r.rs), pl:sany(r.pl),
      periodKey:String(r.periodKey||''), unit:'h',
      norm:num(r.norm), avail:num(r.avail)||num(r.availNet),
      expansion:num(r.expansion), maint:num(r.maint)}));
    out.totals.planAvail = S(out.capacityPlan,c=>c.avail);
    out.totals.expansion = S(out.capacityPlan,c=>c.expansion);
    CHX.loaded.rescapacity = true;
  }catch(e){ out.notes.push('rescapacity: '+e.message) }

  /* 8.7 экономика отказов: периодные ставки перекрывают безпериодные */
  try{
    const gw = granWhere('demand_cost', gran);
    const S_DCst = src(db,'demand_cost', gw);
    const dc = await chQuery(`SELECT
        ${q('item')} AS item, ${q('loc')} AS loc,
        ${q('demandtype')} AS dt, ${q('dmdstream')} AS stream,
        avg(${q('nondelcostrate')})   AS nonDel,
        avg(${q('latedelivcostrate')}) AS lateRate,
        avg(${q('latedelivperiods')})  AS latePeriods
      FROM ${S_DCst} GROUP BY item, loc, dt, stream LIMIT 20000`);
    out.penalty = dc.map(r=>({item:sany(r.item), loc:sany(r.loc), dt:num(r.dt),
      stream:sany(r.stream), nonDel:num(r.nonDel), lateRate:num(r.lateRate),
      latePeriods:num(r.latePeriods), grain:'period'}));
    CHX.loaded.demand_cost = true;
  }catch(e){ out.notes.push('demand_cost: '+e.message) }
  try{
    const S_TI = src(db,'demand_cost_ti');
    const ti = await chQuery(`SELECT ${q('item')} AS item, ${q('loc')} AS loc,
        ${q('demandtype')} AS dt, ${q('dmdstream')} AS stream,
        avg(${q('nondelcostrate')}) AS nonDel, avg(${q('latedelivcostrate')}) AS lateRate,
        avg(${q('latedelivperiods')}) AS latePeriods,
        avg(${q('priority')}) AS priority, avg(${q('quota')}) AS quota
      FROM ${S_TI} GROUP BY item, loc, dt, stream LIMIT 20000`);
    out.penaltyFlat = ti.map(r=>({item:sany(r.item), loc:sany(r.loc), dt:num(r.dt),
      stream:sany(r.stream), nonDel:num(r.nonDel), lateRate:num(r.lateRate),
      latePeriods:num(r.latePeriods), priority:num(r.priority), quota:num(r.quota),
      grain:'flat'}));
    CHX.loaded.demand_cost_ti = true;
  }catch(e){ out.notes.push('demand_cost_ti: '+e.message) }

  /* 8.8 оценка штрафов: ставка × неудовлетворённый объём */
  out.totals.penaltyNonDel = 0;
  if(out.penalty || out.penaltyFlat){
    const key = r => [r.item,r.loc,r.dt,r.stream].join('|');
    const rate = new Map();
    (out.penaltyFlat||[]).forEach(r=>rate.set(key(r), r));   // fallback
    (out.penalty||[]).forEach(r=>rate.set(key(r), r));       // период перекрывает
    try{
      const gw = granWhere('demand_coverage', gran);
      const S_DC = src(db,'demand_coverage', gw);
      const uf = await chQuery(`SELECT ${q('item')} AS item, ${q('loc')} AS loc,
          ${q('demandtype')} AS dt, ${q('dmdstream')} AS stream,
          sum(${q('unfullfilleddemandqty')}) AS uf,
          sum(${q('demandfullfilledlateqty')}) AS late
        FROM ${S_DC} GROUP BY item, loc, dt, stream`);
      let pen = 0, penLate = 0;
      uf.forEach(r=>{
        const k = [sany(r.item),sany(r.loc),num(r.dt),sany(r.stream)].join('|');
        const rr = rate.get(k);
        if(rr){
          pen     += num(r.uf)   * (rr.nonDel||0);
          penLate += num(r.late) * (rr.lateRate||0) * (rr.latePeriods||1);
        }
      });
      out.totals.penaltyNonDel = pen;
      out.totals.penaltyLate   = penLate;
    }catch(e){ out.notes.push('penalty calc: '+e.message) }
  }
  return out;
}
CHX.loadVersionAgg = loadVersionAgg;

/* ─────────────── 9. ОСНОВНАЯ СХЕМА: ДЕТАЛИ ─────────────── */
const T2 = {movement:'mv', production:'pd', procurement:'pc', stock:'st'};

async function loadMainDetail(db, gran, limitOrders){
    /* заказы: дедуп до order_id, отсечение по марже — детали нужны для топа */
  const S_MD = src(db,'marking_demand');

  /* Набор колонок marking_demand различается между схемами/версиями:
     в части схем нет dmdstream, demand_demandtype, margin_per_hour и т.п.
     Без проверки запрос падает с ошибкой 47 «Unknown expression identifier».
     Читаем фактический список колонок и включаем только существующие. */
  let mdCols = new Set();
  try{
    const cl = await chQuery(`SELECT name FROM system.columns
      WHERE database = ${qs(db)} AND table = 'marking_demand'`);
    mdCols = new Set(cl.map(r=>String(r.name).toLowerCase()));
  }catch(e){ /* нет прав на system.columns — работаем полным набором, как раньше */ }
  const has = c => !mdCols.size || mdCols.has(String(c).toLowerCase());
  const orNot = (col, fallback) => has(col) ? `any(${q(col)})` : fallback;
  const colOr = (col, fallback) => has(col) ? q(col) : fallback;

  const ords = await chQuery(`SELECT order_id AS id,
      ${orNot('demand_period','0')}      AS p,
      ${orNot('demand_location',"''")}   AS loc,
      ${orNot('demand_product',"''")}    AS prod,
      ${orNot('demand_client',"''")}     AS cl,
      ${orNot('demand_demandtype','0')}  AS dtype,
      ${orNot('dmdstream',"''")}         AS stream,
      ${orNot('demand_volume','0')}      AS dem,
      ${orNot('results_sale','0')}       AS sal,
      ${orNot('unsatisfied_demand','0')} AS unm,
      ${orNot('price','0')}              AS price,
      ${orNot('cost_per_unit_order','0')} AS cpt,
      ${orNot('margin_per_unit','0')}    AS mpt,
      ${orNot('revenue','0')}            AS rev,
      ${orNot('cost_of_demand','0')}     AS cost,
      ${orNot('total_margin','0')}       AS mar,
      ${orNot('demand_demandtypepriority','2')} AS prio,
      ${orNot('margin_per_hour','0')}    AS mph
    FROM ${S_MD} GROUP BY order_id
    ORDER BY abs(mar) DESC
    LIMIT ${Number(limitOrders)||2000}`);

  const orders = ords.map(r=>({
    id:num(r.id), p:pnum(r.p), d:'', loc:sany(r.loc), prod:sany(r.prod),
    cl:sany(r.cl)||'—', stream:sany(r.stream),
    dtype:num(r.dtype), dem:num(r.dem), sal:num(r.sal), unm:num(r.unm),
    price:num(r.price), cpt:Math.abs(num(r.cpt)), mpt:num(r.mpt),
    rev:num(r.rev), cost:Math.abs(num(r.cost)), mar:num(r.mar),
    pr:num(r.prio)||2, mph:num(r.mph)
  }));
  if(!orders.length) throw new Error('В схеме '+db+' не найдено заказов в marking_demand');

  /* операции: только для загруженных заказов, чанками по IN */
  const ids = orders.map(o=>o.id);
  const ops = [];
  for(let i=0;i<ids.length;i+=500){
    const chunk = ids.slice(i,i+500);
    const rows = await chQuery(`SELECT
        ${colOr('order_id','0')} AS o, ${colOr('demand_period','0')} AS p,
        ${colOr('operation_type',"''")} AS type, ${colOr('location',"''")} AS pl,
        ${colOr('product',"''")} AS pr, ${colOr('resource',"''")} AS rs,
        ${colOr('loc_from',"''")} AS fr, ${colOr('loc_to',"''")} AS to,
        ${colOr('transport_type',"''")} AS tm, ${colOr('order_operation_volume','0')} AS v,
        abs(${colOr('cost_rate_of_operation','0')}) AS r, ${colOr('supplier',"''")} AS vd,
        ${colOr('bom_num',"''")} AS rt, ${colOr('order_operation_id',"''")} AS oid,
        ${colOr('resource_consumption_operation','0')} AS rc
      FROM ${src(db,'marking_demand', `${q('order_id')} IN (${chunk.join(',')})`)}`);
    rows.forEach(r=>{
      const t = T2[String(r.type||'').toLowerCase()];
      if(!t) return;
      const oid = sany(r.oid);
      ops.push({o:num(r.o), p:pnum(r.p), d:'', t,
        pl:sany(r.pl), pr:sany(r.pr), rs:(t==='mv'?'':sany(r.rs)),
        fr:sany(r.fr), to:sany(r.to), tm:sany(r.tm),
        v:num(r.v), r:Math.abs(num(r.r)), vd:sany(r.vd), rt:sany(r.rt),
        oid, dp:oid?oid.split('.').length:1,
        rc:num(r.rc)||undefined});
    });
  }
  return {orders, ops};
}
CHX.loadMainDetail = loadMainDetail;

/* точечный drill-down: операции конкретного заказа (для «Цепочки заказа») */
CHX.loadOpsForOrder = async function(orderId){
  const db = CHX.cfg.base; if(!db) return [];
  const rows = await chQuery(`SELECT ${q('order_id')} AS o, ${q('demand_period')} AS p,
      ${q('operation_type')} AS type, ${q('location')} AS pl, ${q('product')} AS pr,
      ${q('resource')} AS rs, ${q('loc_from')} AS fr, ${q('loc_to')} AS to,
      ${q('transport_type')} AS tm, ${q('order_operation_volume')} AS v,
      abs(${q('cost_rate_of_operation')}) AS r, ${q('supplier')} AS vd,
      ${q('bom_num')} AS rt, ${q('order_operation_id')} AS oid,
      ${q('resource_consumption_operation')} AS rc
    FROM ${src(db,'marking_demand', `${q('order_id')} = ${Number(orderId)}`)}`);
  const out = [];
  rows.forEach(r=>{
    const t = T2[String(r.type||'').toLowerCase()]; if(!t) return;
    const oid = sany(r.oid);
    out.push({o:num(r.o), p:pnum(r.p), d:'', t, pl:sany(r.pl), pr:sany(r.pr),
      rs:(t==='mv'?'':sany(r.rs)), fr:sany(r.fr), to:sany(r.to), tm:sany(r.tm),
      v:num(r.v), r:Math.abs(num(r.r)), vd:sany(r.vd), rt:sany(r.rt),
      oid, dp:oid?oid.split('.').length:1, rc:num(r.rc)||undefined});
  });
  return out;
};

/* ─────────────── 10. ГЛАВНАЯ ТОЧКА ВХОДА ─────────────── */
CHX.loadAll = async function(onProgress){
  const c = CHX.cfg;
  if(!c.schemas.length) throw new Error('Не выбрано ни одной схемы');
  if(!c.base) c.base = c.schemas[0];
  const step = m => { if(onProgress) onProgress(m) };

  step('Загрузка агрегатов версий…');
  const aggs = [];
  for(const db of c.schemas){
    step(`Агрегаты: ${CHX.labelFor(db)}…`);
    aggs.push(await loadVersionAgg(db, c.gran));
  }

  step('Детализация основной схемы…');
  const detail = await loadMainDetail(c.base, c.gran, c.detailOrders);
  const baseAgg = aggs.find(a=>a.db===c.base) || aggs[0];

  /* сборка DS через существующий build() — вкладки продолжают работать */
  const ds = build({
    name: CHX.labelFor(c.base) + ' · ' + CHX.granLabel(c.gran),
    orders: detail.orders,
    ops: detail.ops,
    capacity: baseAgg.capacity || []
  });
  ds.src = 'clickhouse';
  ds.schema = c.base;
  ds.gran = c.gran;
  ds.agg = baseAgg;                    // агрегаты для вкладок без деталей
  ds.capacityPlan = baseAgg.capacityPlan || [];
  ds.penalty = baseAgg.penalty || [];
  ds.penaltyFlat = baseAgg.penaltyFlat || [];
  ds.resTypes = baseAgg.resTypes || [];
  ds.detailLimited = detail.orders.length >= (c.detailOrders||2000);
  ds._demo = false;

  CHX.versions = c.schemas.map(db=>({
    id:db, label:CHX.labelFor(db), src:'ch', isBase:(db===c.base),
    agg:aggs.find(a=>a.db===db), gran:c.gran, ts:(CHX.state.meta&&CHX.state.meta[db]||{}).ts||''
  }));
  CHX.loaded.marking_demand = true;

  window.DS = ds;
  if(typeof window.onCHDataset === 'function') window.onCHDataset(ds, CHX.versions);
  // Сохраняем уже выбранные схемы и основную схему вместе с данными.
  CHX.session.touch();
  const notes = aggs.flatMap(a=>a.notes.map(n=>a.db+' → '+n));
  return {ds, versions:CHX.versions, notes};
};

/* ─────────────── 11. МОДАЛКА ПОДКЛЮЧЕНИЯ ─────────────── */
function modalEl(){
  let m = document.getElementById('chModal');
  if(m) return m;
  m = document.createElement('div');
  m.id = 'chModal';
  m.innerHTML = `<div class="chm-back"></div><div class="chm-win"></div>`;
  document.body.appendChild(m);
  m.querySelector('.chm-back').onclick = ()=>CHX.closeModal();
  return m;
}
CHX.closeModal = ()=>{ const m=document.getElementById('chModal'); if(m) m.style.display='none' };

CHX.openModal = function(){
  const m = modalEl(); m.style.display='block';
  drawModal();
};

function drawModal(){
  const m = modalEl(), w = m.querySelector('.chm-win'), c = CHX.cfg, st = CHX.state;
  const profs = CHX.profiles.all();
  /* Позиция прокрутки списка схем и фокус: drawModal вызывается после каждого
     клика по чекбоксу — без этого список «уезжает» в начало */
  const prevScroll=(document.getElementById('chmDbList')||{}).scrollTop||0;
  const prevFocusId=(document.activeElement&&document.activeElement.id)||'';
  w.innerHTML = `
  <div class="chm-h"><span>⚡ Прямое подключение к ClickHouse</span>
    <span class="chm-x" id="chmX">✕</span></div>
  <div class="chm-note">Версия данных — это проект (база вида <code>data_public*</code>).
    После подключения выберите схемы: одна основная (полная детализация) и до нескольких для сравнения.
    <b>Автосессия на 4 часа включена:</b> параметры и пароль сохраняются в браузере для автоматического
    восстановления после закрытия браузера. Кнопка «Забыть автосессию» удаляет сохранённые данные.</div>

  ${profs.length?`<div class="chm-row"><label>Профиль</label>
    <select id="chmProf"><option value="">— не выбран —</option>
      ${profs.map(p=>`<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.host)}</option>`).join('')}
    </select><button class="btn" id="chmProfApply">Применить</button>
    <button class="btn d" id="chmProfDrop">Удалить</button></div>`:''}

  <div class="chm-row"><label>Режим</label>
    <select id="chmMode">
      <option value="direct" ${!c.useProxy?'selected':''}>Напрямую в ClickHouse</option>
      <option value="proxy"  ${c.useProxy?'selected':''}>Через прокси (CORS решён на сервере)</option>
    </select></div>
  ${c.useProxy?`
  <div class="chm-row"><label>URL прокси</label>
    <input id="chmProxy" type="text" value="${esc(c.proxyUrl)}" placeholder="/api/ch"></div>`:`
  <div class="chm-row"><label>Хост</label>
    <input id="chmHost" type="text" value="${esc(c.host)}" placeholder="ch.company.ru"></div>
  <div class="chm-row"><label>Порт</label>
    <input id="chmPort" type="number" value="${c.port}"></div>
  <div class="chm-row"><label>Протокол</label>
    <select id="chmProto">
      <option value="https" ${c.proto==='https'?'selected':''}>HTTPS · 443</option>
      <option value="http"  ${c.proto==='http'?'selected':''}>HTTP · 8123</option>
    </select></div>
  <div class="chm-row"><label>Логин</label>
    <input id="chmUser" type="text" value="${esc(c.user)}" placeholder="readonly"></div>
  <div class="chm-row"><label>Пароль</label>
    <input id="chmPass" type="password" value="${esc(c.pass)}" placeholder="пусто — если не задан"></div>`}

  <div class="chm-act">
    <button class="btn p" id="chmConn">${st.connected?'Обновить список схем':'Подключиться'}</button>
    <button class="btn" id="chmSaveProf">Сохранить профиль</button>
    ${CHX.session.exists()?`<button class="btn d" id="chmForgetSession">Забыть автосессию</button>`:''}
    <button class="btn" id="chmClose">Закрыть</button>
    <span id="chmStat" class="chm-stat">${st.lastError
      ?`<span class="neg">${esc(st.lastError)}</span>`
      :(st.connected?`<span class="pos">Подключено · схем: ${st.dbs.length}</span>`:'')}</span>
  </div>

  ${st.connected?`
  <div class="chm-sec">Схемы (версии планов)</div>
  ${st.fallbackAll?`<div class="chm-note" style="color:var(--scp-warn)">Схем вида data_public* не найдено —
    показаны все доступные базы. Отметьте нужные вручную; если нужных нет в списке,
    пользователю не выданы права на них в ClickHouse.</div>`:''}
  ${c.schemas.length?`
  <div class="chm-sel">
    <span class="chm-hint" style="max-width:none">Выбрано: <b>${c.schemas.length}</b> · основная:
      <b>${esc(CHX.labelFor(c.base))}</b></span>
    ${c.schemas.map(db=>`<span class="dt-chip" data-rmdb="${esc(db)}"
      title="Клик: убрать из выбора">${esc(CHX.labelFor(db))} ✕</span>`).join('')}
  </div>`:''}
  <input class="pop-q" id="chmDbQ" type="text" placeholder="Поиск схемы — введите номер или имя…"
    value="${esc(st.dbq||'')}" style="margin-bottom:6px;width:100%">
  <div class="chm-list" id="chmDbList">
    ${st.dbs.slice()
      .sort((a,b)=>(Number(c.schemas.includes(b))-Number(c.schemas.includes(a))) || a.localeCompare(b))
      .map(db=>{
      const on = c.schemas.includes(db), isBase = (c.base===db);
      const meta = (st.meta&&st.meta[db])||{};
      const lbl = CHX.labelFor(db);
            return `<div class="chm-item ${on?'on':''}" data-dbrow="${esc(db)}">
        <input type="radio" name="chmBase" ${isBase?'checked':''} data-base="${esc(db)}"
               title="Основная схема (полная детализация)">
        <input type="checkbox" ${on?'checked':''} data-db="${esc(db)}">
        <span class="chm-nm">${esc(lbl)}${lbl!==db?` <code>${esc(db)}</code>`:''}</span>
        <span class="chm-meta">${meta.n?nf(meta.n)+' строк':'—'}${meta.ts?' · '+esc(String(meta.ts).slice(0,16)):''}</span>
      </div>`}).join('')}
  </div>

  <div class="chm-row"><label>Гранулярность</label>
    <select id="chmGran">${st.granOptions.map(o=>
      `<option value="${o.t}" ${c.gran===o.t?'selected':''}>${esc(CHX.granLabel(o.t))} (periodtype ${o.t}${o.n?', '+nf(o.n)+' строк':''})</option>`).join('')}
    </select></div>
  <div class="chm-row"><label>Детализация</label>
    <input id="chmDet" type="number" min="100" step="100" value="${c.detailOrders}">
    <span class="chm-hint">заказов основной схемы грузим построчно; остальное — агрегатами, детали по клику</span></div>

  <div class="chm-sec">Названия версий</div>
  <div class="chm-row"><label>scenario.xlsx</label>
    <input type="file" id="chmScen" accept=".xlsx,.xls">
    <span class="chm-hint">${CHX.state.scenario.size
      ?`загружено ${CHX.state.scenario.size} записей`
      :'без файла останутся технические имена схем'}</span></div>

  <div class="chm-act">
    <button class="btn p" id="chmLoad" ${c.schemas.length?'':'disabled'}>
      Загрузить данные (${c.schemas.length} ${plural(c.schemas.length,['схема','схемы','схем'])})</button>
    <span id="chmProg" class="chm-stat"></span>
  </div>`:''}

  <div class="chm-foot">Браузер подключается к серверу напрямую, поэтому на стороне ClickHouse
    должен быть разрешён CORS для чужих источников. Если страница открыта по HTTPS, хост ClickHouse
    тоже должен отвечать по HTTPS с действующим сертификатом. Используйте аккаунт только с правами чтения.</div>`;

  const g = id => document.getElementById(id);
  const sync = ()=>{
    if(c.useProxy){ c.proxyUrl = (g('chmProxy')||{}).value || c.proxyUrl }
    else{
      c.host = (g('chmHost')||{}).value || c.host;
      c.port = num((g('chmPort')||{}).value) || c.port;
      c.proto = (g('chmProto')||{}).value || c.proto;
      c.user = (g('chmUser')||{}).value || '';
      c.pass = (g('chmPass')||{}).value || '';
    }
  };
  g('chmX').onclick = g('chmClose').onclick = CHX.closeModal;
  g('chmMode').onchange = e=>{ sync(); c.useProxy = (e.target.value==='proxy'); drawModal() };
  g('chmConn').onclick = async ()=>{
    sync(); g('chmStat').innerHTML = 'Подключение…';
    try{ await CHX.connect(); drawModal() }
    catch(e){ CHX.state.lastError = e.message; drawModal() }
  };
  g('chmSaveProf').onclick = ()=>{
    sync();
    const nm = prompt('Название профиля:', c.host);
    if(nm){ CHX.profiles.save(nm.trim()); drawModal() }
  };
  if(g('chmProfApply')) g('chmProfApply').onclick = ()=>{
    const nm = g('chmProf').value; if(nm && CHX.profiles.apply(nm)) drawModal();
  };
  if(g('chmProfDrop')) g('chmProfDrop').onclick = ()=>{
    const nm = g('chmProf').value; if(nm){ CHX.profiles.drop(nm); drawModal() }
  };
  if(g('chmForgetSession')) g('chmForgetSession').onclick = ()=>{
    CHX.forgetSession();
    drawModal();
  };
  if(g('chmGran')) g('chmGran').onchange = e=>{
    c.gran = num(e.target.value); if(st.connected) CHX.session.touch();
  };
  if(g('chmDet'))  g('chmDet').onchange  = e=>{
    c.detailOrders = Math.max(100,num(e.target.value)); if(st.connected) CHX.session.touch();
  };
  /* Только чекбоксы, не строки: строка-див тоже несла data-db, и всплывшее
     событие change от чекбокса срабатывало на ней вторично — div.checked === undefined,
     и схема сразу же удалялась из выбора. Отсюда «галочки не ставятся». */
  m.querySelectorAll('input[type=checkbox][data-db]').forEach(cb=>cb.onchange = ()=>{
    const db = cb.dataset.db, i = c.schemas.indexOf(db);
    if(cb.checked && i<0) c.schemas.push(db);
    if(!cb.checked && i>=0) c.schemas.splice(i,1);
    if(!c.schemas.includes(c.base)) c.base = c.schemas[0] || '';
    if(st.connected) CHX.session.touch();
    drawModal();
  });
  m.querySelectorAll('[data-base]').forEach(rb=>rb.onchange = async ()=>{
    c.base = rb.dataset.base;
    if(!c.schemas.includes(c.base)) c.schemas.push(c.base);
    const stat = document.getElementById('chmStat');
    if(stat) stat.innerHTML = 'Обновляю гранулярность основной схемы…';
    await CHX.refreshGran(c.base);
    if(st.connected) CHX.session.touch();
    drawModal();
  });
  /* Чип выбранной схемы: клик — убрать из выбора */
  m.querySelectorAll('[data-rmdb]').forEach(ch=>ch.onclick = ()=>{
    const i = c.schemas.indexOf(ch.dataset.rmdb);
    if(i>=0) c.schemas.splice(i,1);
    if(c.base===ch.dataset.rmdb) c.base = c.schemas[0] || '';
    if(st.connected) CHX.session.touch();
    drawModal();
  });
  /* Поиск по схемам: фильтруем строки списка на месте, без перерисовки модалки */
  if(g('chmDbQ')) g('chmDbQ').oninput = ()=>{
    st.dbq = g('chmDbQ').value;
    const s = st.dbq.trim().toLowerCase();
    m.querySelectorAll('#chmDbList .chm-item').forEach(it=>{
      it.style.display = (!s || (it.dataset.dbrow||'').toLowerCase().includes(s)) ? '' : 'none';
    });
  };
  if(g('chmScen')) g('chmScen').onchange = async e=>{
    if(!e.target.files||!e.target.files[0]) return;
    try{ const n = await CHX.loadScenarioFile(e.target.files[0]);
      alert('Загружено записей scenario: '+n); drawModal(); }
    catch(err){ alert('Ошибка чтения scenario: '+err.message) }
  };
  if(g('chmLoad')) g('chmLoad').onclick = async ()=>{
    const prog = g('chmProg');
    g('chmLoad').disabled = true;
    try{
       const res = await CHX.loadAll(msg=>{ if(prog) prog.textContent = msg });
      CHX.closeModal();
      const stat = document.getElementById('stat');
      if(stat) stat.innerHTML =
        `<span class="pos">ClickHouse:</span> ${esc(res.ds.name)}<br>`
        + `${res.ds.orders.length} заказов${res.ds.detailLimited?' (лимит детализации)':''} | `
        + `${res.ds.ops.length} операций | версий: ${res.versions.length}`
        + (res.notes.length?`<br><span class="neg">${esc(res.notes.join(' · '))}</span>`:'');
    }catch(e){
      if(prog) prog.innerHTML = `<span class="neg">${esc(e.message)}</span>`;
      g('chmLoad').disabled = false;
    }
  };
  /* Возвращаем прокрутку списка и фокус туда, где они были до перерисовки */
  const listEl=document.getElementById('chmDbList');
  if(listEl&&prevScroll)listEl.scrollTop=prevScroll;
  if(prevFocusId==='chmDbQ'){const fe=document.getElementById('chmDbQ');if(fe){fe.focus();fe.selectionStart=fe.value.length}}
}

/* ─────────────── 12. СРАВНЕНИЕ N ВЕРСИЙ ─────────────── */
let VS_VIEW = 'matrix';   // matrix | profile | waterfall | heat
let VS_DIM  = 'period';   // period | product | client
let VS_TARGET = null;     // версия для waterfall

/* Метрики версии: [ключ, название, направление (1 лучше больше), формат] */
const VS_METRICS = [
  ['rev','Валовая выручка',1,bn],
  ['cost','Себестоимость',-1,bn],
  ['mar','Валовая маржа',1,bn],
  ['mrg','Маржинальность',1,pc],
  ['mpt','Маржа на тонну',1,v=>nf(v)+' ₽'],
  ['demUnc','Неограниченный спрос, т',0,v=>nf(v)],
  ['demLim','Ограниченный спрос, т',0,v=>nf(v)],
  ['sal','План продаж, т',1,v=>nf(v)],
  ['unm','Неудовлетворённый спрос, т',-1,v=>nf(v)],
  ['sl','Service Level',1,pc],
  ['late','Отгружено с опозданием, т',-1,v=>nf(v)],
  ['lm','Упущенная маржа',-1,bn],
  ['penNonDel','Штраф за непоставку',-1,bn],
  ['penLate','Штраф за опоздание',-1,bn],
  ['pd','Затраты: производство',-1,bn],
  ['mv','Затраты: логистика',-1,bn],
  ['pcst','Затраты: закупки',-1,bn],
  ['st','Затраты: хранение',-1,bn],
  ['capUtil','Средняя загрузка мощностей',0,pc],
  ['bn','Узких мест (≥90%)',-1,v=>nf(v)],
  ['planAvail','Плановый ФРВ, ч',0,v=>nf(v)],
  ['expansion','Расширение мощности, ч',0,v=>nf(v)],
  ['orders','Заказов',0,v=>nf(v)]
];

function vsFlat(v){
  const a = v.agg || {}, t = a.totals || {}, cov = t.cov || {}, op = t.byOp || {};
  const rev = num(t.rev), cost = num(t.cost), mar = num(t.mar), sal = num(t.sal);
  const demUnc = num(cov.demUnc) || (num(cov.ff)+num(cov.uf));
  const avgMptVal = num(t.avgMpt);
  return {
    _v:v, label:v.label, id:v.id, isBase:v.isBase,
    rev, cost, mar, mrg: rev?mar/rev:0, mpt: sal?mar/sal:0,
    demUnc, demLim: num(t.dem), sal, unm: num(t.unm),
    sl: num(t.dem)?sal/num(t.dem):0, late: num(cov.late),
    lm: num(t.lm), avgMpt: avgMptVal > 0 ? avgMptVal : (sal?mar/sal:0),
    penNonDel: num(t.penaltyNonDel), penLate: num(t.penaltyLate),
    pd:(op.production||{}).c||0, mv:(op.movement||{}).c||0,
    pcst:(op.procurement||{}).c||0, st:(op.stock||{}).c||0,
    capUtil: num(t.capUtil), bn: num(t.bnCount),
    planAvail: num(t.planAvail), expansion: num(t.expansion),
    orders: num(t.orders)
  };
}

CHX.tabVS = function(){
  const V = CHX.versions;
  if(!V.length || V.length < 2)
    return `<div class="empty"><h2>Версий для сравнения меньше двух</h2>
      <p>Откройте подключение к ClickHouse и выберите две или более схемы
      <code>data_public*</code>: одну основной, остальные — для сравнения.</p>
      <p style="margin-top:14px"><button class="btn p" onclick="CHX.openModal()">Открыть подключение</button></p></div>`;

  const rows = V.map(vsFlat);
  const base = rows.find(r=>r.isBase) || rows[0];
  if(!VS_TARGET || !rows.some(r=>r.id===VS_TARGET))
    VS_TARGET = (rows.find(r=>!r.isBase)||rows[0]).id;
  const target = rows.find(r=>r.id===VS_TARGET);

  /* лучшая версия по каждой метрике */
  const best = {};
  VS_METRICS.forEach(([k,,dir])=>{
    if(!dir) return;
    let bv = null;
    rows.forEach(r=>{ if(bv===null || r[k]*dir > bv.v*dir) bv = {id:r.id, v:r[k]} });
    best[k] = bv && bv.id;
  });

  const K = [
    ['Версий в сравнении', nf(rows.length), 'база: '+base.label, ''],
    ['Лидер по марже',
      (rows.slice().sort((a,b)=>b.mar-a.mar)[0]||{}).label||'—',
      bn((rows.slice().sort((a,b)=>b.mar-a.mar)[0]||{}).mar||0), 'pos'],
    ['Лидер по Service Level',
      (rows.slice().sort((a,b)=>b.sl-a.sl)[0]||{}).label||'—',
      pc((rows.slice().sort((a,b)=>b.sl-a.sl)[0]||{}).sl||0), 'pos'],
    ['Разброс маржи',
      bn(Math.max(...rows.map(r=>r.mar))-Math.min(...rows.map(r=>r.mar))),
      'между лучшей и худшей версией', 'mid'],
    ['Гранулярность', CHX.granLabel(CHX.cfg.gran), 'periodtype '+CHX.cfg.gran, '']
  ];

  const html = `
  <div class="frow">
    <div class="fg"><label>База сравнения</label>
      <select id="vsBase">${rows.map(r=>
        `<option value="${esc(r.id)}" ${r.isBase?'selected':''}>${esc(r.label)}</option>`).join('')}</select></div>
    <div class="fg"><label>Версия для разложения дельты</label>
      <select id="vsTarget">${rows.filter(r=>!r.isBase).map(r=>
        `<option value="${esc(r.id)}" ${r.id===VS_TARGET?'selected':''}>${esc(r.label)}</option>`).join('')}</select></div>
    <div class="fg"><label>Разрез тепловой карты</label>
      <select id="vsDim">
        <option value="period"  ${VS_DIM==='period'?'selected':''}>Период</option>
        <option value="product" ${VS_DIM==='product'?'selected':''}>Продукт</option>
        <option value="client"  ${VS_DIM==='client'?'selected':''}>Клиент</option>
      </select></div>
    <button class="btn" onclick="CHX.openModal()">Изменить набор версий</button>
  </div>
  <div class="kpis">${K.map(k=>
    `<div class="kpi"><div class="t">${k[0]}</div><div class="v ${k[3]}">${esc(String(k[1]))}</div>
     <div class="s">${esc(String(k[2]))}</div></div>`).join('')}</div>
  <div class="seg" style="margin:0 0 12px">
    <button class="btn ${VS_VIEW==='matrix'?'p':''}"    id="vsVMat">Матрица KPI</button>
    <button class="btn ${VS_VIEW==='profile'?'p':''}"   id="vsVPro">Профиль версий</button>
    <button class="btn ${VS_VIEW==='waterfall'?'p':''}" id="vsVWf">Разложение дельты</button>
    <button class="btn ${VS_VIEW==='heat'?'p':''}"      id="vsVHeat">Дельта по разрезу</button>
  </div>
  <div class="grid">
    ${VS_VIEW==='matrix'?`
    <div class="card w"><h3>Матрица показателей: все версии</h3>
      <div class="sub">Дельта считается к базе «${esc(base.label)}». Зелёный — улучшение с точки зрения бизнеса,
        ★ — лучшая версия по строке</div><div id="vsMat"></div></div>`:''}
    ${VS_VIEW==='profile'?`
    <div class="card w"><h3>Профиль версий</h3>
      <div class="sub">Значения нормированы к лучшей версии по каждой метрике (100% = лучшая)</div>
      <canvas id="vsPro"></canvas></div>`:''}
    ${VS_VIEW==='waterfall'?`
    <div class="card w"><h3>Разложение дельты маржи: ${esc(base.label)} → ${esc(target.label)}</h3>
      <div class="sub">Из чего сложилось изменение валовой маржи между версиями</div>
      <canvas id="vsWf"></canvas></div>`:''}
    ${VS_VIEW==='heat'?`
    <div class="card w"><h3>Отклонение маржи от базы по разрезу «${
      VS_DIM==='period'?'Период':VS_DIM==='product'?'Продукт':'Клиент'}»</h3>
      <div class="sub">Где именно версии расходятся, млн ₽ относительно базы</div>
      <canvas id="vsHeat"></canvas></div>`:''}
  </div>`;

  setTimeout(()=>{
    const g = id=>document.getElementById(id);
    g('vsBase').onchange = e=>{
      CHX.versions.forEach(v=>v.isBase = (v.id===e.target.value));
      CHX.cfg.base = e.target.value; render();
    };
    if(g('vsTarget')) g('vsTarget').onchange = e=>{ VS_TARGET = e.target.value; render() };
    g('vsDim').onchange = e=>{ VS_DIM = e.target.value; render() };
    g('vsVMat').onclick  = ()=>{ VS_VIEW='matrix';    render() };
    g('vsVPro').onclick  = ()=>{ VS_VIEW='profile';   render() };
    g('vsVWf').onclick   = ()=>{ VS_VIEW='waterfall'; render() };
    g('vsVHeat').onclick = ()=>{ VS_VIEW='heat';      render() };

    /* ── Матрица: динамические колонки по числу версий ── */
    if(VS_VIEW==='matrix'){
      const data = VS_METRICS.map(([k,name,dir,fmt])=>{
        const rec = {n:name, _k:k, _dir:dir, _fmt:fmt, base:base[k]};
        rows.forEach(r=>{
          rec['v_'+r.id] = r[k];
          rec['d_'+r.id] = r[k] - base[k];
        });
        const vals = rows.map(r=>r[k]);
        rec.spread = Math.max(...vals) - Math.min(...vals);
        return rec;
      });
      const cols = [
        {k:'n', t:'Показатель', left:1, flt:1},
        {k:'base', t:base.label+' (база)', num:1, f:(v,r)=>r._fmt(v)}
      ];
      rows.filter(r=>!r.isBase).forEach(r=>{
        cols.push({k:'v_'+r.id, t:r.label, num:1,
          f:(v,row)=>{
            const d = row['d_'+r.id], dir = row._dir;
            const star = (best[row._k]===r.id && dir) ? ' ★' : '';
            const cls = !dir ? '' : (d*dir>0 ? 'pos' : d*dir<0 ? 'neg' : '');
            const dd = d===0 ? '' :
              ` <span class="${cls}">(${d>0?'+':''}${row._fmt(d)})</span>`;
            return `${row._fmt(v)}${dd}${star}`;
          }});
      });
      cols.push({k:'spread', t:'Разброс', num:1, f:(v,r)=>r._fmt(v)});
      dtable('#vsMat', cols, data,
        {key:'vs_matrix', sort:'n', dir:'asc', h:520, csv:1, name:'versions_matrix'});
    }

    /* ── Профиль: нормировка к лучшей версии ── */
    if(VS_VIEW==='profile'){
      const keys = ['mar','sl','mpt','capUtil'];
      const names = ['Маржа','Service Level','Маржа/т','Загрузка мощностей'];
      const inv = ['unm','penNonDel','mv'];
      const invNames = ['Дефицит (инв.)','Штрафы (инв.)','Логистика (инв.)'];
      const allK = keys.concat(inv), allN = names.concat(invNames);
      const norm = allK.map(k=>{
        const vals = rows.map(r=>Math.abs(r[k])||0);
        const mx = Math.max(...vals,1e-9), mn = Math.min(...vals);
        return rows.map(r=>{
          const v = Math.abs(r[k])||0;
          return inv.includes(k) ? (mx? (1-(v-mn)/(mx-mn||1))*100 : 0) : (v/mx)*100;
        });
      });
      chBars('#vsPro', H('#vsPro',320,0.42), allN,
        rows.map((r,i)=>({c:PAL[i%PAL.length], v:norm.map(arr=>arr[i])})),
        v=>nf(v,0)+'%',
        i=>`<b>${esc(allN[i])}</b><br>`+rows.map((r,j)=>
          `${esc(r.label)}: ${nf(norm[i][j],0)}%`).join('<br>'),
        null, 1);
        const host = document.getElementById('vsPro');
      if(host && host.parentElement){
        const wrap=document.createElement('div');
        wrap.innerHTML=lg('#vsPro',rows.map((r,i)=>[PAL[i%PAL.length],r.label]));
        host.parentElement.insertBefore(wrap.firstChild, host);
      }   
    }

    /* ── Waterfall: раскладка дельты маржи ── */
    if(VS_VIEW==='waterfall'){
      const steps = [
        ['Маржа базы', base.mar, 'base'],
        ['Δ Выручка', target.rev - base.rev, ''],
        ['Δ Закупки', -(target.pcst - base.pcst), ''],
        ['Δ Производство', -(target.pd - base.pd), ''],
        ['Δ Логистика', -(target.mv - base.mv), ''],
        ['Δ Хранение', -(target.st - base.st), ''],
        ['Маржа версии', target.mar, 'total']
      ];
      const resid = target.mar - (base.mar +
        (target.rev-base.rev) - (target.pcst-base.pcst) - (target.pd-base.pd)
        - (target.mv-base.mv) - (target.st-base.st));
      if(Math.abs(resid) > Math.abs(target.mar)*1e-6)
        steps.splice(6,0,['Прочее / нераспределённое', resid, '']);
      const labs = steps.map(s=>s[0]);
      const vals = steps.map(s=>s[1]);
      chBars('#vsWf', H('#vsWf',300,0.4), labs,
        [{c:CH.d1, v:vals.map(v=>Math.abs(v))}],
        v=>nf(v/1e9,2)+' млрд',
        i=>`<b>${esc(labs[i])}</b><br>${vals[i]>=0?'+':''}${bn(vals[i])}`,
        null, 1, 1);
    }

    /* ── Heatmap: отклонение от базы по разрезу ── */
    if(VS_VIEW==='heat'){
      const dimOf = v => ((v._v.agg||{}).dims||{})[VS_DIM] || [];
      const keysAll = uq(rows.flatMap(r=>dimOf(r).map(d=>d.k)), k=>k).slice(0,24);
      const baseMap = new Map(dimOf(base).map(d=>[d.k,d.mar]));
      const others = rows.filter(r=>!r.isBase);
      const mat = keysAll.map(k=> others.map(r=>{
        const m = new Map(dimOf(r).map(d=>[d.k,d.mar]));
        return (m.get(k)||0) - (baseMap.get(k)||0);
      }));
      if(keysAll.length && others.length)
        chHeat('#vsHeat', H('#vsHeat',360,0.55), keysAll, others.map(r=>r.label),
          mat.map(row=>row.map(v=>Math.abs(v))),
          v=>mln(v)+' ₽', null);
      else{
        const g2 = cv('#vsHeat',180);
        if(g2){ g2.x.fillStyle=CH.axis; g2.x.textAlign='center'; g2.x.font='13px Open Sans, sans-serif';
          g2.x.fillText('Недостаточно данных по выбранному разрезу', g2.w/2, 90) }
      }
    }
  },0);

  /* ── Вердикт по блокам для N версий ── */
  const blocks = [
    ['Финансы (маржа)','mar',1], ['Спрос (Service Level)','sl',1],
    ['Дефицит','unm',-1], ['Штрафы','penNonDel',-1],
    ['Логистика','mv',-1], ['Производство','pd',-1],
    ['Закупки','pcst',-1], ['Загрузка мощностей','capUtil',1]
  ];
  const winners = blocks.map(([name,k,dir])=>{
    const b = rows.slice().sort((a,z)=>(z[k]-a[k])*dir)[0];
    return {name, who:b.label, val:b[k]};
  });
  const score = {};
  rows.forEach(r=>score[r.label]=0);
  winners.forEach(w=>score[w.who] = (score[w.who]||0)+1);
  const rank = Object.entries(score).sort((a,b)=>b[1]-a[1]);

  return html + summary('Резюме: сравнение версий', [
    {t:'Кто выигрывает по блокам', i: winners.map(w=>
      `<b>${w.name}</b>: <span class="h">${esc(w.who)}</span>`)},
    {t:'Сводный рейтинг', i:[
      rank.map(([nm,n])=>`<b>${esc(nm)}</b> — ${n} ${plural(n,['блок','блока','блоков'])} из ${blocks.length}`).join('; ')+'.',
      rank.length && rank[0][1] > (rank[1]?rank[1][1]:0)
        ? `Версия <span class="h">${esc(rank[0][0])}</span> доминирует. Перед принятием проверьте,
           не достигнут ли результат за счёт роста штрафов или нереалистичной загрузки мощностей.`
        : `Явного лидера нет — версии выигрывают в разных блоках. Решение принимать по приоритетному
           блоку: обычно маржа, затем Service Level.`,
      `Если маржа выросла, а Service Level упал — это перераспределение объёма в пользу дорогих позиций;
       смотрите разрез «Клиент» на тепловой карте.`,
      `Если снизилась логистика, но выросло хранение — затраты переехали между статьями,
       сравнивайте сумму блоков, а не отдельные строки.`
    ]},
    {t:'Гигиена сравнения', i:[
      `Все версии агрегированы с одной гранулярностью (<b>${CHX.granLabel(CHX.cfg.gran)}</b>) —
       смешивания месяцев с неделями не происходит.`,
      `Дедупликация: <code>is_deleted = 0</code> + последняя версия строки по <code>update_date_time</code>.`,
      CHX.unmatchedSchemas().length
        ? `<span class="h">${CHX.unmatchedSchemas().join(', ')}</span> не сопоставлены со scenario.xlsx —
           отображаются техническими именами.`
        : `Все схемы сопоставлены с названиями из scenario.xlsx.`
    ]}
  ]);
};


/* Восстанавливаем подключение после закрытия браузера и контролируем его
   при возвращении на вкладку или после восстановления сети. */
function installSessionLifecycle(){
  CHX.restoreSession();
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') CHX.checkSession(false);
  });
  window.addEventListener('online',()=>CHX.checkSession(true));
  window.addEventListener('pageshow',()=>CHX.checkSession(false));
}
if(document.readyState==='loading')
  document.addEventListener('DOMContentLoaded',installSessionLifecycle,{once:true});
else installSessionLifecycle();
})();
