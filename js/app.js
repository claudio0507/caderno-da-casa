/* Caderno da Casa · app único, sem dependências. Dados em localStorage. */
(function () {
  'use strict';

  /* ═══════════ utilitários ═══════════ */
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const addMonths = (comp, n) => { const [y, m] = comp.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const dim = (y, m) => new Date(y, m, 0).getDate();
  const compOf = s => s.slice(0, 7);
  const monthsBetween = (a, b) => { const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma); };
  const fmtD = s => s.slice(8, 10) + '/' + s.slice(5, 7);
  const fmtDY = s => fmtD(s) + '/' + s.slice(2, 4);
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const MES3 = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const fmtComp = c => { const [y, m] = c.split('-').map(Number); return MES3[m - 1] + '/' + String(y).slice(2); };
  const brl = v => (Math.round(v * 100) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brl0 = v => Math.round(v).toLocaleString('pt-BR');
  const money = v => 'R$ ' + brl0(v);
  const parseMoney = s => { const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return isNaN(n) ? NaN : Math.round(n * 100) / 100; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const HOJE = iso(new Date());
  const COMP_HOJE = compOf(HOJE);

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ═══════════ servidor (opcional) ═══════════ */
  // Sem servidor (file:// ou http.server) o app guarda tudo no localStorage.
  // Com server/server.py o estado vive no servidor: PUT com revisão (409 = outro aparelho salvou antes).
  const NET = { on: false, user: null, users: [], rev: 0, pending: false, sending: false, timer: null };
  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch (e) { /* sem corpo JSON */ }
    return { status: r.status, data };
  }
  async function ping() {
    if (location.protocol === 'file:') return null;
    try { const r = await api('GET', '/api/ping'); return r.status === 200 && r.data && r.data.ok ? r.data : null; } catch (e) { return null; }
  }
  function schedule(ms) { clearTimeout(NET.timer); NET.timer = setTimeout(flush, ms); }
  async function flush(keepalive) {
    if (!NET.on || !NET.pending || NET.sending) return;
    NET.sending = true; NET.pending = false; let retry = 0;
    try {
      const r = await fetch('/api/state', { method: 'PUT', credentials: 'same-origin', keepalive: keepalive === true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rev: NET.rev, state: S }) });
      const d = await r.json().catch(() => null);
      if (r.status === 200) NET.rev = d.rev;
      else if (r.status === 409) { NET.rev = d.rev; if (d.state) S = d.state; render(); toast(`Atualizado por ${d.por || 'outro aparelho'} antes de você. Refaça a última alteração.`); }
      else if (r.status === 401) showLogin();
      else { NET.pending = true; retry = 5000; toast('Não foi possível salvar. Tentando de novo…'); }
    } catch (e) { NET.pending = true; retry = 5000; toast('Sem conexão. Vou tentar salvar de novo.'); }
    NET.sending = false;
    if (NET.pending) schedule(retry || 300);
  }
  async function poll() {
    if (!NET.on || !NET.user || document.hidden || NET.pending || NET.sending) return;
    try {
      const r = await api('GET', '/api/state?rev=' + NET.rev);
      if (r.status === 401) return showLogin();
      if (r.status === 200 && r.data && !r.data.same && r.data.state) { NET.rev = r.data.rev; S = r.data.state; render(); toast(`Atualizado por ${r.data.por || 'outro aparelho'}`); }
    } catch (e) { /* sem rede: tenta no próximo ciclo */ }
  }
  async function loadRemote() {
    const r = await api('GET', '/api/state').catch(() => ({ status: 0 }));
    if (r.status === 401) { showLogin(); return false; }
    if (r.status !== 200) { toast('Servidor indisponível. Tente de novo em instantes.'); return false; }
    NET.rev = r.data.rev; S = r.data.state || blankState();
    return true;
  }
  function blankState() {
    const pessoas = NET.users.map(u => ({ id: u.id, nome: u.nome }));
    if (!pessoas.some(p => p.id === 'j')) pessoas.push({ id: 'j', nome: 'Casa' });
    return { lanc: [], rec: [], cats: defaultCats(), contas: [{ id: 'principal', nome: 'Conta principal', tipo: 'corrente', saldo: 0, reserva: false }], pessoas, cfg: { colchao: 1000, metaSobra: 500, lembreteDias: 7 }, seq: { lanc: 1, rec: 1 }, gerado: [] };
  }
  function showLogin() {
    const box = $('#login'); box.hidden = false;
    $('#login-users').innerHTML = NET.users.map((u, i) => `<button type="button" data-val="${esc(u.id)}" aria-pressed="${i === 0}">${esc(u.nome)}</button>`).join('');
    $('#login-hint').textContent = NET.users.length ? '' : 'Nenhum usuário criado. No servidor: python3 server/server.py adduser c Claudio';
    $('#login-erro').textContent = ''; $('#login-senha').value = '';
    setTimeout(() => $('#login-senha').focus(), 50);
  }
  async function doLogin(e) {
    e.preventDefault();
    const btn = $('#form-login button[type=submit]'); btn.disabled = true;
    try {
      const r = await api('POST', '/api/login', { user: getSeg($('#form-login'), 'user') || '', senha: $('#login-senha').value });
      if (r.status !== 200) { $('#login-erro').textContent = (r.data && r.data.erro) || 'Falha ao entrar'; return; }
      NET.user = r.data.user; $('#login').hidden = true;
      if (await loadRemote()) afterLoad();
    } catch (err) { $('#login-erro').textContent = 'Sem conexão com o servidor'; }
    finally { btn.disabled = false; }
  }
  const fmtStamp = iso => { const d = new Date(iso); return isNaN(d) ? iso : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  async function renderHistory() {
    const box = $('#hist'); if (!box) return;
    const r = await api('GET', '/api/history?limit=30').catch(() => ({ status: 0 }));
    if (r.status !== 200) { box.innerHTML = '<div class="empty">Histórico indisponível.</div>'; return; }
    box.innerHTML = r.data.length ? `<div class="tw"><table><thead><tr><th>Rev.</th><th>Quando</th><th>Quem</th><th>Alterações</th><th></th></tr></thead><tbody>${r.data.map(h => `<tr><td>${h.rev}</td><td>${fmtStamp(h.quando)}</td><td>${esc(h.por || '—')}</td><td class="desc">${esc(h.resumo)}</td><td class="acts"><button class="btn sm ghost" data-action="hist-detail" data-id="${h.rev}">Ver</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhuma alteração registrada.</div>';
  }
  async function showHistoryDetail(rev) {
    const box = $('#hist-detail'); if (!box) return;
    const r = await api('GET', '/api/history/' + rev).catch(() => ({ status: 0 }));
    if (r.status !== 200) { box.innerHTML = '<div class="empty">Detalhe indisponível.</div>'; return; }
    const LAB = { lanc: 'lançamento', rec: 'recorrência', cats: 'categoria', contas: 'conta', pessoas: 'pessoa', cfg: 'parâmetros', gerado: 'meses gerados' };
    const v = x => x === null || x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x);
    const nome = c => c.item ? (c.item.desc || c.item.nome || ('#' + c.id)) : '';
    box.innerHTML = `<div class="sec" style="margin-top:18px"><span class="line"></span><h3>Revisão ${r.data.rev}</h3><span class="ex">${fmtStamp(r.data.quando)} · ${esc(r.data.por || '—')}</span></div>
      <div class="list">${r.data.diff.map(c => `<div class="row"><span class="dt">${LAB[c.col] || c.col}</span><div class="g"><div class="t">${esc(c.op)}${c.item ? ' · ' + esc(nome(c)) : ''}${c.item && c.item.valor != null ? ' · ' + brl(c.item.valor) : ''}</div><div class="m">${c.campos ? Object.keys(c.campos).map(k => `${esc(k)}: ${esc(v(c.campos[k][0]))} → ${esc(v(c.campos[k][1]))}`).join(' · ') : c.op === 'alterado' && c.col === 'cfg' ? esc(v(c.depois)) : ''}</div></div></div>`).join('') || '<div class="empty">Sem detalhes.</div>'}</div>`;
    box.scrollIntoView({ block: 'nearest' });
  }

  /* ═══════════ estado ═══════════ */
  const KEY = 'caderno-da-casa:v1';
  let S;

  function seed() {
    const seq = { lanc: 1, rec: 1 };
    const pessoas = [{ id: 'c', nome: 'Claudio' }, { id: 'e', nome: 'Esposa' }, { id: 'j', nome: 'Casa' }];
    const cats = defaultCats();
    const _catsExemplo = [
      { id: 'moradia', nome: 'Moradia', tipo: 'saida', teto: 3280 },
      { id: 'mercado', nome: 'Mercado e feira', tipo: 'saida', teto: 2100 },
      { id: 'contas', nome: 'Contas da casa', tipo: 'saida', teto: 700 },
      { id: 'transporte', nome: 'Transporte', tipo: 'saida', teto: 1735 },
      { id: 'saude', nome: 'Saúde', tipo: 'saida', teto: 1330 },
      { id: 'reserva', nome: 'Reserva', tipo: 'saida', teto: 2000 },
      { id: 'educacao', nome: 'Educação', tipo: 'saida', teto: 390 },
      { id: 'assinaturas', nome: 'Assinaturas', tipo: 'saida', teto: 110 },
      { id: 'lazer', nome: 'Lazer', tipo: 'saida', teto: 700 },
      { id: 'impostos', nome: 'Impostos', tipo: 'saida', teto: 185 },
      { id: 'pet', nome: 'Pet', tipo: 'saida', teto: 250 },
      { id: 'vestuario', nome: 'Vestuário', tipo: 'saida', teto: 300 },
      { id: 'outros', nome: 'Outros', tipo: 'saida', teto: 0 },
      { id: 'renda', nome: 'Renda', tipo: 'entrada', teto: 0 },
      { id: 'renda-extra', nome: 'Renda extra', tipo: 'entrada', teto: 0 },
    ];
    _catsExemplo.forEach(c => { const k = cats.find(x => x.id === c.id); if (k) k.teto = c.teto; });
    const contas = [
      { id: 'conjunta', nome: 'Conta conjunta', tipo: 'corrente', saldo: 8412, reserva: false },
      { id: 'nub-c', nome: 'Nubank Claudio', tipo: 'corrente', saldo: 6180, reserva: false },
      { id: 'nub-e', nome: 'Nubank Esposa', tipo: 'corrente', saldo: 2780, reserva: false },
      { id: 'cartao', nome: 'Cartão Nubank', tipo: 'cartao', saldo: 0, reserva: false },
      { id: 'dinheiro', nome: 'Dinheiro', tipo: 'carteira', saldo: 140, reserva: false },
      { id: 'cdb', nome: 'CDB Sicredi', tipo: 'reserva', saldo: 38400, reserva: true },
    ];
    const ini = addMonths(COMP_HOJE, -13);
    const R = (o) => Object.assign({ id: seq.rec++, tipo: 'saida', quem: 'j', freq: 'mensal', dia: 10, wd: 1, mes: 1, parcelas: 12, inicio: ini, fim: null, ativo: true, conta: 'conjunta' }, o);
    const rec = [
      R({ desc: 'Salário', tipo: 'entrada', quem: 'e', valor: 6200, dia: 1, cat: 'renda', conta: 'nub-e' }),
      R({ desc: 'Salário', tipo: 'entrada', quem: 'c', valor: 9500, dia: 5, cat: 'renda', conta: 'nub-c' }),
      R({ desc: 'Aluguel', valor: 2800, dia: 10, cat: 'moradia' }),
      R({ desc: 'Condomínio', valor: 480, dia: 10, cat: 'moradia' }),
      R({ desc: 'Plano de saúde', valor: 1150, dia: 5, cat: 'saude' }),
      R({ desc: 'Financiamento do carro', quem: 'c', valor: 890, dia: 15, cat: 'transporte', conta: 'nub-c', freq: 'parcelado', parcelas: 36, inicio: addMonths(COMP_HOJE, -13) }),
      R({ desc: 'Reserva · aporte CDB', valor: 2000, dia: 6, cat: 'reserva' }),
      R({ desc: 'Luz', valor: 340, dia: 12, cat: 'contas' }),
      R({ desc: 'Água', valor: 95, dia: 28, cat: 'contas' }),
      R({ desc: 'Internet', valor: 130, dia: 20, cat: 'contas' }),
      R({ desc: 'Celulares · 2 linhas', valor: 120, dia: 8, cat: 'contas' }),
      R({ desc: 'Curso de inglês', quem: 'e', valor: 390, dia: 2, cat: 'educacao', conta: 'nub-e', fim: addMonths(COMP_HOJE, 3) }),
      R({ desc: 'Netflix', valor: 55.9, dia: 3, cat: 'assinaturas', conta: 'cartao' }),
      R({ desc: 'Spotify · família', quem: 'c', valor: 34.9, dia: 1, cat: 'assinaturas', conta: 'cartao' }),
      R({ desc: 'iCloud', quem: 'e', valor: 14.9, dia: 18, cat: 'assinaturas', conta: 'cartao' }),
      R({ desc: 'IPTU', valor: 185, dia: 10, cat: 'impostos', freq: 'parcelado', parcelas: 10, inicio: addMonths(COMP_HOJE, -5) }),
      R({ desc: 'Seguro do carro', quem: 'c', valor: 245, dia: 30, cat: 'transporte', conta: 'cartao', freq: 'parcelado', parcelas: 12, inicio: addMonths(COMP_HOJE, -2) }),
      R({ desc: 'Feira', quem: 'e', valor: 80, freq: 'semanal', wd: 6, cat: 'mercado', conta: 'dinheiro' }),
      R({ desc: 'IPVA', quem: 'c', valor: 1450, freq: 'anual', mes: 1, dia: 20, cat: 'transporte', conta: 'nub-c' }),
    ];
    S = { lanc: [], rec, cats, contas, pessoas, cfg: { colchao: 6000, metaSobra: 3000, lembreteDias: 7 }, seq, gerado: [] };
    // gera mês anterior, atual e próximo; marca o passado como pago
    [addMonths(COMP_HOJE, -1), COMP_HOJE, addMonths(COMP_HOJE, 1)].forEach(c => gerar(c, true));
    S.lanc.forEach(l => {
      if (l.data < HOJE) { l.pago = true; l.dataPago = l.data; }
    });
    // deixa dois atrasados de exemplo
    const ingles = S.lanc.filter(l => l.desc.startsWith('Curso de inglês') && compOf(l.data) === COMP_HOJE)[0];
    if (ingles) { ingles.pago = false; ingles.dataPago = null; }
    const agua = S.lanc.filter(l => l.desc.startsWith('Água') && compOf(l.data) === addMonths(COMP_HOJE, -1))[0];
    if (agua) { agua.pago = false; agua.dataPago = null; }
    // pontuais
    const P = (o) => S.lanc.push(Object.assign({ id: S.seq.lanc++, tipo: 'saida', quem: 'j', conta: 'cartao', pago: false, dataPago: null, recId: null, obs: '' }, o));
    P({ desc: 'Mercado · compra da semana', valor: 486.3, data: addDays(HOJE, -3), cat: 'mercado', pago: true, dataPago: addDays(HOJE, -3) });
    P({ desc: 'Farmácia', quem: 'e', valor: 92.4, data: addDays(HOJE, -2), cat: 'saude', pago: true, dataPago: addDays(HOJE, -2) });
    P({ desc: 'Combustível', quem: 'c', valor: 210, data: addDays(HOJE, -1), cat: 'transporte', conta: 'nub-c', pago: true, dataPago: addDays(HOJE, -1) });
    P({ desc: 'PIX · sem descrição', quem: 'c', valor: 150, data: addDays(HOJE, -1), cat: 'outros', conta: 'nub-c', pago: true, dataPago: addDays(HOJE, -1) });
    P({ desc: 'Mercado', valor: 520, data: addDays(HOJE, 4), cat: 'mercado' });
    P({ desc: 'Mercado', valor: 480, data: addDays(HOJE, 11), cat: 'mercado' });
    P({ desc: 'Mercado', valor: 430, data: addDays(HOJE, 18), cat: 'mercado' });
    P({ desc: 'Freelance · projeto site', tipo: 'entrada', quem: 'c', valor: 1500, data: addDays(HOJE, 13), cat: 'renda-extra', conta: 'nub-c' });
    P({ desc: 'Aniversário · jantar', valor: 700, data: addDays(HOJE, 20), cat: 'lazer' });
    P({ desc: 'Ração', valor: 250, data: addDays(HOJE, 20), cat: 'pet' });
    P({ desc: 'Celular', valor: 120, data: HOJE, cat: 'contas', conta: 'conjunta' });
    save();
  }

  function defaultCats() {
    return [
      { id: 'moradia', nome: 'Moradia', tipo: 'saida', teto: 0 },
      { id: 'mercado', nome: 'Mercado e feira', tipo: 'saida', teto: 0 },
      { id: 'contas', nome: 'Contas da casa', tipo: 'saida', teto: 0 },
      { id: 'transporte', nome: 'Transporte', tipo: 'saida', teto: 0 },
      { id: 'saude', nome: 'Saúde', tipo: 'saida', teto: 0 },
      { id: 'reserva', nome: 'Reserva', tipo: 'saida', teto: 0 },
      { id: 'educacao', nome: 'Educação', tipo: 'saida', teto: 0 },
      { id: 'assinaturas', nome: 'Assinaturas', tipo: 'saida', teto: 0 },
      { id: 'lazer', nome: 'Lazer', tipo: 'saida', teto: 0 },
      { id: 'impostos', nome: 'Impostos', tipo: 'saida', teto: 0 },
      { id: 'pet', nome: 'Pet', tipo: 'saida', teto: 0 },
      { id: 'vestuario', nome: 'Vestuário', tipo: 'saida', teto: 0 },
      { id: 'outros', nome: 'Outros', tipo: 'saida', teto: 0 },
      { id: 'renda', nome: 'Renda', tipo: 'entrada', teto: 0 },
      { id: 'renda-extra', nome: 'Renda extra', tipo: 'entrada', teto: 0 },
    ];
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { S = JSON.parse(raw); return; }
    } catch (e) { /* estado corrompido: recomeça */ }
    seed();
  }
  function save() {
    if (!NET.on) { localStorage.setItem(KEY, JSON.stringify(S)); return; }
    NET.pending = true; schedule(400);
  }

  const catById = id => S.cats.find(c => c.id === id);
  const contaById = id => S.contas.find(c => c.id === id);
  const pessoaById = id => S.pessoas.find(p => p.id === id);
  const catNome = id => (catById(id) || {}).nome || '—';
  const contaNome = id => (contaById(id) || {}).nome || '—';
  const pessoaNome = id => (pessoaById(id) || {}).nome || '—';
  const whoTag = id => `<span class="who ${id}" title="${esc(pessoaNome(id))}">${esc(pessoaNome(id).charAt(0))}</span>`;
  const saldoAtual = () => sum(S.contas.filter(c => !c.reserva && c.tipo !== 'cartao'), c => c.saldo);
  const signed = l => (l.tipo === 'entrada' ? 1 : -1) * l.valor;

  /* ═══════════ status derivado ═══════════ */
  function status(l) {
    if (l.pago) return 'realizado';
    if (l.data < HOJE) return 'atrasado';
    if (l.data === HOJE) return 'hoje';
    return 'previsto';
  }
  function chip(l) {
    const st = status(l);
    if (st === 'realizado') return `<span class="chip done">${l.tipo === 'entrada' ? 'recebido' : 'pago'}</span>`;
    if (st === 'atrasado') return `<span class="chip late">atrasado</span>`;
    if (st === 'hoje') return `<span class="chip today">vence hoje</span>`;
    const d = Math.round((parse(l.data) - parse(HOJE)) / 864e5);
    if (d <= S.cfg.lembreteDias) return `<span class="chip soon">em ${d} d</span>`;
    return `<span class="chip plan">previsto</span>`;
  }

  /* ═══════════ recorrências → lançamentos ═══════════ */
  function datasDaRegra(r, comp) {
    if (!r.ativo) return [];
    if (comp < r.inicio) return [];
    if (r.fim && comp > r.fim) return [];
    const [y, m] = comp.split('-').map(Number);
    const n = dim(y, m);
    const day = d => `${comp}-${pad(Math.min(Math.max(1, +d || 1), n))}`;
    if (r.freq === 'mensal') return [{ data: day(r.dia) }];
    if (r.freq === 'quinzenal') return [{ data: day(r.dia) }, { data: day(Math.min(+r.dia + 15, n)) }];
    if (r.freq === 'anual') return +r.mes === m ? [{ data: day(r.dia) }] : [];
    if (r.freq === 'parcelado') {
      const k = monthsBetween(r.inicio, comp) + 1;
      if (k < 1 || k > +r.parcelas) return [];
      return [{ data: day(r.dia), sufixo: ` · ${k}/${r.parcelas}` }];
    }
    if (r.freq === 'semanal') {
      const out = [];
      for (let d = 1; d <= n; d++) if (new Date(y, m - 1, d).getDay() === +r.wd) out.push({ data: `${comp}-${pad(d)}` });
      return out;
    }
    return [];
  }
  function virtuais(r, comp) {
    return datasDaRegra(r, comp).map(x => ({
      id: null, recId: r.id, tipo: r.tipo, desc: r.desc + (x.sufixo || ''), valor: r.valor, data: x.data,
      quem: r.quem, cat: r.cat, conta: r.conta, pago: false, dataPago: null, obs: '', virtual: true,
    }));
  }
  function gerar(comp, silent) {
    let n = 0;
    S.rec.forEach(r => {
      virtuais(r, comp).forEach(v => {
        const existe = S.lanc.some(l => l.recId === r.id && l.data === v.data);
        if (existe) return;
        v.id = S.seq.lanc++; delete v.virtual; S.lanc.push(v); n++;
      });
    });
    if (!S.gerado.includes(comp)) S.gerado.push(comp);
    if (!silent) { save(); toast(n ? `${n} lançamentos previstos criados para ${fmtComp(comp)}` : `Nada novo para ${fmtComp(comp)}`); }
    return n;
  }
  function itensDoMes(comp) {
    // reais do mês + virtuais das regras cujo par ainda não foi gerado
    const reais = S.lanc.filter(l => compOf(l.data) === comp);
    const virt = [];
    S.rec.forEach(r => virtuais(r, comp).forEach(v => {
      if (!S.lanc.some(l => l.recId === r.id && l.data === v.data)) virt.push(v);
    }));
    return reais.concat(virt);
  }
  function itensNoIntervalo(a, b) {
    const out = [];
    for (let c = compOf(a); c <= compOf(b); c = addMonths(c, 1)) out.push(...itensDoMes(c));
    return out.filter(l => l.data >= a && l.data <= b);
  }

  /* ═══════════ período ═══════════ */
  const UI = { view: 'painel', mode: 'mes', ref: HOJE, filtros: { tipo: 'todos', st: 'todos', quem: 'todos', cat: 'todos', q: '' }, sort: 'data', horizonte: 12 };

  function range(mode, ref) {
    if (mode === 'dia') return [ref, ref];
    if (mode === 'semana') { const w = (parse(ref).getDay() + 6) % 7; const a = addDays(ref, -w); return [a, addDays(a, 6)]; }
    if (mode === 'mes') { const c = compOf(ref); const [y, m] = c.split('-').map(Number); return [c + '-01', c + '-' + pad(dim(y, m))]; }
    return [ref.slice(0, 4) + '-01-01', ref.slice(0, 4) + '-12-31'];
  }
  function shift(mode, ref, n) {
    const d = parse(ref);
    if (mode === 'dia') d.setDate(d.getDate() + n);
    else if (mode === 'semana') d.setDate(d.getDate() + 7 * n);
    else if (mode === 'mes') { d.setDate(1); d.setMonth(d.getMonth() + n); }
    else d.setFullYear(d.getFullYear() + n);
    return iso(d);
  }
  function periodLabel(mode, ref) {
    const d = parse(ref);
    if (mode === 'dia') return `${cap(DIAS[d.getDay()])}, ${d.getDate()} de ${MESES[d.getMonth()]}`;
    if (mode === 'semana') { const [a, b] = range(mode, ref); const pa = parse(a), pb = parse(b); return `${pa.getDate()} ${MES3[pa.getMonth()]} – ${pb.getDate()} ${MES3[pb.getMonth()]} ${pb.getFullYear()}`; }
    if (mode === 'mes') return `${cap(MESES[d.getMonth()])} ${d.getFullYear()}`;
    return String(d.getFullYear());
  }
  function periodState(mode, ref) {
    const [a, b] = range(mode, ref);
    if (HOJE < a) return 'Previsto';
    if (HOJE > b) return 'Encerrado';
    if (mode === 'dia') return 'Hoje';
    const total = Math.round((parse(b) - parse(a)) / 864e5) + 1, dia = Math.round((parse(HOJE) - parse(a)) / 864e5) + 1;
    return `Em aberto · dia ${dia} de ${total}`;
  }

  /* ═══════════ projeção de saldo dia a dia ═══════════ */
  function saldoSerie(a, b) {
    // saldo(d) = saldo atual − pagos com data > d (passado) + previstos não pagos com data ≤ d (futuro)
    const base = saldoAtual();
    const itens = itensNoIntervalo(a < HOJE ? HOJE : a, b > HOJE ? b : HOJE);
    const pagos = S.lanc.filter(l => l.pago && l.data > a && l.data <= HOJE);
    const atrasados = S.lanc.filter(l => !l.pago && l.data < HOJE);
    const futuros = itens.filter(l => !l.pago && l.data >= HOJE);
    const out = [];
    for (let d = a; d <= b; d = addDays(d, 1)) {
      let v = base;
      if (d <= HOJE) v -= sum(pagos.filter(l => l.data > d), signed);
      else { v += sum(atrasados, signed); v += sum(futuros.filter(l => l.data <= d), signed); }
      out.push({ data: d, v, real: d <= HOJE });
    }
    return out;
  }

  /* ═══════════ gráficos (SVG) ═══════════ */
  // cores dos gráficos lidas dos tokens CSS (ui-obs), recalculadas a cada render
  const C = {};
  function themeColors() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    Object.assign(C, { BG: v('--card'), TXT: v('--txt'), MUT: v('--mut'), LAB: v('--lab'), FAINT: v('--dim'), FLOOR: v('--border'), QUIET: v('--divider'), GRID: v('--border'), DATA: v('--accent'), DATA2: v('--accent-hover'), HERO: v('--orange') });
  }
  const THEME_KEY = 'caderno-da-casa:theme';
  function applyTheme(t) {
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light'); else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* sem persistência */ }
    const b = $('#theme-toggle'); if (b) b.textContent = t === 'light' ? 'Tema escuro' : 'Tema claro';
  }
  const currentTheme = () => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (p, t, a) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); p.appendChild(n); return n; };
  const txt = (p, a, s) => { const n = el(p, 'text', a); n.textContent = s; return n; };
  const tip = (n, s) => { const t = document.createElementNS(NS, 'title'); t.textContent = s; n.appendChild(t); };
  const nice = v => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1)))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  const kfmt = v => Math.abs(v) >= 1000 ? (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k' : String(Math.round(v));

  function chartSaldo(svg, serie, colchao) {
    svg.innerHTML = '';
    const W = 640, H = 260, X0 = 46, X1 = 620, base = 218, top = 34;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const n = serie.length; if (!n) return;
    const vals = serie.map(p => p.v).concat([colchao, 0]);
    let vmin = Math.min(...vals), vmax = Math.max(...vals);
    const step = nice((vmax - vmin) / 4 || 1000);
    vmin = Math.floor(vmin / step) * step; vmax = Math.ceil(vmax / step) * step; if (vmax === vmin) vmax = vmin + step;
    const x = i => n === 1 ? (X0 + X1) / 2 : X0 + i * ((X1 - X0) / (n - 1));
    const y = v => base - (v - vmin) / (vmax - vmin) * (base - top);
    for (let v = vmin; v <= vmax; v += step) {
      const zero = v === 0;
      el(svg, 'line', { x1: X0 - 8, y1: y(v), x2: X1 + 8, y2: y(v), stroke: zero ? C.GRID : C.QUIET, 'stroke-width': zero ? .9 : .5, 'stroke-dasharray': zero ? '' : '1 3', class: 'fade' });
      txt(svg, { x: X0 - 12, y: y(v) + 3, 'font-size': 7.5, 'font-weight': 600, fill: C.FAINT, 'text-anchor': 'end' }, kfmt(v));
    }
    el(svg, 'line', { x1: X0 - 8, y1: y(colchao), x2: X1 + 8, y2: y(colchao), stroke: C.TXT, 'stroke-width': .9, 'stroke-dasharray': '2 3', class: 'fade' });
    txt(svg, { x: X1 + 6, y: y(colchao) - 4, 'font-size': 7, 'font-weight': 700, fill: C.LAB, 'text-anchor': 'end', 'letter-spacing': '.08em' }, 'COLCHÃO ' + kfmt(colchao));
    const ih = serie.findIndex(p => p.data === HOJE);
    if (ih >= 0) {
      el(svg, 'line', { x1: x(ih), y1: top - 6, x2: x(ih), y2: base + 2, stroke: C.HERO, 'stroke-width': 1, class: 'fade' });
      txt(svg, { x: x(ih) + 4, y: top - 8, 'font-size': 7, 'font-weight': 700, fill: C.HERO, 'letter-spacing': '.1em' }, 'HOJE');
    }
    const pts = f => serie.map((p, i) => [x(i), y(p.v), p]).filter(f).map(p => `${p[0]} ${p[1]}`).join(' L ');
    const a = pts((p, i) => p[2].real), b = pts((p, i) => !p[2].real || i === ih);
    if (a) el(svg, 'path', { d: 'M' + a, fill: 'none', stroke: C.DATA, 'stroke-width': 2.2, 'stroke-linejoin': 'round', pathLength: 1, class: 'draw' });
    if (b) el(svg, 'path', { d: 'M' + b, fill: 'none', stroke: C.DATA, 'stroke-width': 1.6, 'stroke-dasharray': '3 3', 'stroke-linejoin': 'round', pathLength: 1, class: 'draw', style: 'animation-delay:.4s' });
    const imin = serie.reduce((m, p, i) => p.v < serie[m].v ? i : m, 0), imax = serie.reduce((m, p, i) => p.v > serie[m].v ? i : m, 0);
    const dense = n > 45;
    serie.forEach((p, i) => {
      const big = i === imin || i === imax, ev = itensNoIntervalo(p.data, p.data).length > 0;
      if (dense && !big && !ev) return;
      const below = p.v < colchao;
      const c = el(svg, 'circle', { cx: x(i), cy: y(p.v), r: big ? 4 : 2.2, fill: p.real ? C.DATA : C.BG, stroke: below ? C.HERO : C.DATA, 'stroke-width': 1.3, class: 'pop', style: `animation-delay:${.1 + i * (dense ? .004 : .03)}s` });
      tip(c, `${fmtDY(p.data)} — saldo ${p.real ? '' : 'projetado '}${money(p.v)}`);
      if (big) txt(svg, { x: x(i), y: y(p.v) + (i === imin ? 16 : -10), 'font-size': 9, 'font-weight': 800, fill: below ? C.HERO : C.TXT, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', style: `paint-order:stroke;stroke:${C.BG};stroke-width:3px` }, money(p.v));
    });
    // eixo x
    const every = n <= 14 ? 1 : n <= 45 ? 5 : 0;
    serie.forEach((p, i) => {
      const d = parse(p.data);
      const show = every ? (every === 1 || d.getDate() % every === 0 && d.getDate() <= 30 || i === 0) : d.getDate() === 1;
      if (!show) return;
      txt(svg, { x: x(i), y: base + 16, 'font-size': 7.5, 'font-weight': 600, fill: C.MUT, 'text-anchor': 'middle', 'letter-spacing': '.06em' }, every ? fmtD(p.data) : MES3[d.getMonth()]);
    });
    txt(svg, { x: (X0 + X1) / 2, y: 252, 'font-size': 7.5, 'font-weight': 600, fill: C.FAINT, 'text-anchor': 'middle', 'letter-spacing': '.1em' }, 'SÓLIDO = REALIZADO · TRACEJADO = PROJETADO · ÂMBAR = ABAIXO DO COLCHÃO');
  }

  function chartMeses(svg, rows, colchao) {
    svg.innerHTML = '';
    const W = 640, H = 240, X0 = 46, X1 = 620, base = 200, top = 30, n = rows.length;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const vals = rows.map(r => r.saldo).concat([colchao, 0]);
    let vmin = Math.min(...vals), vmax = Math.max(...vals);
    const step = nice((vmax - vmin) / 4 || 1000);
    vmin = Math.floor(vmin / step) * step; vmax = Math.ceil(vmax / step) * step; if (vmax === vmin) vmax = vmin + step;
    const bw = Math.min(40, (X1 - X0) / n * .55), gap = (X1 - X0) / n;
    const x = i => X0 + i * gap + gap / 2;
    const y = v => base - (v - vmin) / (vmax - vmin) * (base - top);
    for (let v = vmin; v <= vmax; v += step) {
      el(svg, 'line', { x1: X0 - 8, y1: y(v), x2: X1 + 8, y2: y(v), stroke: v === 0 ? C.GRID : C.QUIET, 'stroke-width': v === 0 ? .9 : .5, 'stroke-dasharray': v === 0 ? '' : '1 3' });
      txt(svg, { x: X0 - 12, y: y(v) + 3, 'font-size': 7.5, 'font-weight': 600, fill: C.FAINT, 'text-anchor': 'end' }, kfmt(v));
    }
    el(svg, 'line', { x1: X0 - 8, y1: y(colchao), x2: X1 + 8, y2: y(colchao), stroke: C.TXT, 'stroke-width': .9, 'stroke-dasharray': '2 3' });
    txt(svg, { x: X1 + 6, y: y(colchao) - 4, 'font-size': 7, 'font-weight': 700, fill: C.LAB, 'text-anchor': 'end', 'letter-spacing': '.08em' }, 'COLCHÃO ' + kfmt(colchao));
    rows.forEach((r, i) => {
      const cur = r.comp === COMP_HOJE, low = r.saldo < colchao;
      const y1 = Math.min(y(r.saldo), y(0)), h = Math.abs(y(r.saldo) - y(0));
      const rect = el(svg, 'rect', { x: x(i) - bw / 2, y: y1, width: bw, height: Math.max(h, 1), fill: cur ? C.DATA : 'none', stroke: low ? C.HERO : C.DATA, 'stroke-width': 1.3, class: 'pop', style: `animation-delay:${i * .06}s` });
      tip(rect, `${fmtComp(r.comp)} — saldo projetado ao fim do mês ${money(r.saldo)}`);
      txt(svg, { x: x(i), y: y(r.saldo) - 7, 'font-size': 8.5, 'font-weight': 800, fill: low ? C.HERO : C.TXT, 'text-anchor': 'middle' }, kfmt(r.saldo));
      txt(svg, { x: x(i), y: base + 15, 'font-size': 7.5, 'font-weight': cur ? 800 : 600, fill: cur ? C.TXT : C.MUT, 'text-anchor': 'middle', 'letter-spacing': '.04em' }, fmtComp(r.comp));
    });
    txt(svg, { x: (X0 + X1) / 2, y: 232, 'font-size': 7.5, 'font-weight': 600, fill: C.FAINT, 'text-anchor': 'middle', 'letter-spacing': '.1em' }, 'SALDO DISPONÍVEL AO FIM DE CADA MÊS · SÓLIDO = MÊS ATUAL · ÂMBAR = ABAIXO DO COLCHÃO');
  }

  function ticksHTML(valor, unit, teto, hojeFrac) {
    const n = Math.min(60, Math.round(valor / unit)), nt = teto ? Math.min(60, Math.round(teto / unit)) : 0;
    let h = '';
    const total = Math.max(n, nt);
    for (let k = 0; k < total; k++) {
      const cls = nt && k >= nt ? 'o' : k < n ? '' : 'p';
      h += `<i class="${cls}"></i>`;
      if (nt && hojeFrac != null && k === Math.round(nt * hojeFrac) - 1) h += '<b></b>';
    }
    return `<div class="ticks">${h}</div>`;
  }

  /* ═══════════ render: painel ═══════════ */
  function renderPainel() {
    const [a, b] = range(UI.mode, UI.ref);
    const itens = itensNoIntervalo(a, b);
    const ent = itens.filter(l => l.tipo === 'entrada'), sai = itens.filter(l => l.tipo === 'saida');
    const entR = sum(ent.filter(l => l.pago), l => l.valor), entP = sum(ent, l => l.valor);
    const saiR = sum(sai.filter(l => l.pago), l => l.valor), saiP = sum(sai, l => l.valor);
    const res = entP - saiP;
    const atras = S.lanc.filter(l => !l.pago && l.data < HOJE), venc = S.lanc.filter(l => !l.pago && l.data >= HOJE && l.data <= addDays(HOJE, S.cfg.lembreteDias) && l.tipo === 'saida');
    const modeTxt = { dia: 'no dia', semana: 'na semana', mes: 'no mês', ano: 'no ano' }[UI.mode];
    const pct = (x, y) => y ? Math.max(0, Math.min(100, Math.round(x / y * 100))) : 0;

    // categorias (saídas)
    const porCat = {};
    sai.forEach(l => { const k = l.cat || 'outros'; porCat[k] = porCat[k] || { real: 0, prev: 0 }; porCat[k][l.pago ? 'real' : 'prev'] += l.valor; });
    const cats = Object.keys(porCat).map(k => ({ id: k, nome: catNome(k), teto: (catById(k) || {}).teto || 0, ...porCat[k] })).sort((x, y) => (y.real + y.prev) - (x.real + x.prev));
    const unit = { dia: 10, semana: 25, mes: 50, ano: 500 }[UI.mode];
    const diasTot = Math.round((parse(b) - parse(a)) / 864e5) + 1;
    const hojeFrac = UI.mode === 'mes' && HOJE >= a && HOJE <= b ? (parse(HOJE).getDate()) / diasTot : null;
    const catRows = cats.map(c => {
      const tot = c.real + c.prev, teto = UI.mode === 'mes' ? c.teto : 0;
      const leitura = teto ? (tot > teto ? `<span class="chip late">estoura ${money(tot - teto)}</span>` : c.real > teto * (hojeFrac || 1) * 1.25 && c.real > 0 ? `<span class="chip soon">acima do ritmo</span>` : c.real >= teto * .98 ? `<span class="chip done">fechado</span>` : `<span class="chip plan">${money(teto - tot)} livres</span>`) : '';
      return `<tr><td class="desc"><b>${esc(c.nome)}</b></td><td class="r v">${brl0(c.real)}</td><td class="r d">${brl0(c.prev)}</td>${UI.mode === 'mes' ? `<td class="r d">${teto ? brl0(teto) : '—'}</td>` : ''}<td>${ticksHTML(tot, unit, teto, hojeFrac)}</td><td>${leitura}</td></tr>`;
    }).join('');

    // lembretes resumidos
    const lemb = atras.concat(S.lanc.filter(l => !l.pago && l.data >= HOJE && l.tipo === 'saida')).sort((x, y) => x.data.localeCompare(y.data)).slice(0, 7);

    // lançamentos do período
    const lista = itens.slice().sort((x, y) => x.data.localeCompare(y.data) || y.valor - x.valor);
    const chartRange = UI.mode === 'dia' ? range('semana', UI.ref) : [a, b];
    const serie = saldoSerie(chartRange[0], chartRange[1]);
    const minP = serie.reduce((m, p) => p.v < m.v ? p : m, serie[0]);

    $('#view-painel').innerHTML = `
      <div class="vhead">
        <div><h2>${esc(periodLabel(UI.mode, UI.ref))}${UI.mode === 'dia' ? ` de ${parse(UI.ref).getFullYear()}` : ''}.</h2>
        <p>O que entra, o que sai e o que ainda vence ${modeTxt}. Todo número deriva dos lançamentos e das recorrências.</p></div>
        <div class="tg" id="scope"><button data-quem="todos" aria-pressed="true">Casa</button>${S.pessoas.filter(p => p.id !== 'j').map(p => `<button data-quem="${p.id}" aria-pressed="false">${esc(p.nome)}</button>`).join('')}</div>
      </div>
      <div class="kgrid">
        <div class="kpi"><div class="h">Entradas ${modeTxt}</div><div class="v">${money(entR)}</div><div class="d">de ${money(entP)} previstos · ${pct(entR, entP)}%</div><div class="bar"><i style="width:${pct(entR, entP)}%"></i></div></div>
        <div class="kpi"><div class="h">Saídas ${modeTxt}</div><div class="v">${money(saiR)}</div><div class="d">de ${money(saiP)} previstos · ${pct(saiR, saiP)}%</div><div class="bar"><i style="width:${pct(saiR, saiP)}%"></i></div></div>
        <div class="kpi hero"><div class="h">Resultado previsto</div><div class="v">${res < 0 ? '−' : ''}${money(Math.abs(res))}</div><div class="d">${UI.mode === 'mes' ? (res >= S.cfg.metaSobra ? `meta de ${money(S.cfg.metaSobra)} atingida` : `meta ${money(S.cfg.metaSobra)} · faltam ${money(S.cfg.metaSobra - res)}`) : 'entradas − saídas previstas'}</div><div class="bar"><i style="width:${UI.mode === 'mes' ? pct(res, S.cfg.metaSobra) : 100}%"></i></div></div>
        <div class="kpi ${atras.length ? 'amber' : ''}"><div class="h">Atenção</div><div class="v">${atras.length} · ${venc.length}</div><div class="d">${atras.length} atrasados (${money(sum(atras, l => l.valor))}) · ${venc.length} vencem em ${S.cfg.lembreteDias} d</div><div class="bar"><i style="width:${pct(atras.length, atras.length + venc.length)}%"></i></div></div>
      </div>
      <div class="grid c21">
        <div>
          <div class="sec"><span class="line"></span><h3>Saldo disponível</h3><span class="ex">${UI.mode === 'dia' ? 'semana do dia' : 'no período'}</span></div>
          <div class="claim">${minP.v < S.cfg.colchao ? `Encosta no colchão: menor saldo ${money(minP.v)} em ${fmtD(minP.data)}.` : `Menor saldo ${money(minP.v)} em ${fmtD(minP.data)}, acima do colchão de ${money(S.cfg.colchao)}.`}</div>
          <div class="micro">um ponto = um dia · saldo das contas correntes + carteira · hoje ${money(saldoAtual())}</div>
          <div class="panel fig"><svg id="ch-saldo" preserveAspectRatio="xMidYMid meet"></svg></div>
        </div>
        <div>
          <div class="sec"><span class="line"></span><h3>Lembretes</h3><button class="btn sm ghost" data-view="lembretes">Ver todos</button></div>
          <div class="list">${lemb.length ? lemb.map(rowLembrete).join('') : '<div class="empty">Nenhum pagamento pendente.</div>'}</div>
          <div class="sec" style="margin-top:24px"><span class="line"></span><h3>Números</h3></div>
          <div class="stats">
            <div><div class="v">${entP ? Math.round(sum(sai.filter(l => l.recId), l => l.valor) / entP * 100) : 0}%</div><div class="r">${money(sum(sai.filter(l => l.recId), l => l.valor))} de ${money(entP)}</div><div class="l">fixas sobre a renda</div></div>
            <div><div class="v">${money(saldoAtual())}</div><div class="r">${S.contas.filter(c => !c.reserva && c.tipo !== 'cartao').length} contas</div><div class="l">saldo hoje</div></div>
            <div><div class="v">${money(sum(S.contas.filter(c => c.reserva), c => c.saldo))}</div><div class="r">${(sum(S.contas.filter(c => c.reserva), c => c.saldo) / Math.max(1, sum(itensDoMes(COMP_HOJE).filter(l => l.tipo === 'saida' && l.cat !== 'reserva'), l => l.valor))).toFixed(1).replace('.', ',')} meses de despesas</div><div class="l">reserva</div></div>
          </div>
        </div>
      </div>
      <div class="grid c2">
        <div>
          <div class="sec"><span class="line"></span><h3>Saídas por categoria</h3><span class="ex">um tick = R$ ${unit}${UI.mode === 'mes' ? ' · traço = hoje' : ''}</span></div>
          <div class="tw"><table><thead><tr><th>Categoria</th><th class="r">Pago</th><th class="r">Previsto</th>${UI.mode === 'mes' ? '<th class="r">Teto</th>' : ''}<th>Consumo</th><th>Leitura</th></tr></thead>
          <tbody>${catRows || '<tr><td colspan="6" class="empty">Sem saídas no período.</td></tr>'}</tbody></table></div>
        </div>
        <div>
          <div class="sec"><span class="line"></span><h3>Lançamentos ${modeTxt}</h3><span class="ex">${lista.length} itens</span><button class="btn sm ghost" data-view="lancamentos">Abrir</button></div>
          <div class="tw"><table><thead><tr><th>Data</th><th>Descrição</th><th>Quem</th><th class="r">Valor</th><th>Situação</th></tr></thead>
          <tbody>${lista.slice(0, 12).map(l => `<tr class="${rowCls(l)}"><td>${fmtD(l.data)}</td><td class="desc"><b>${esc(l.desc)}</b> <span class="sub">${esc(catNome(l.cat))}</span></td><td>${whoTag(l.quem)}</td><td class="r v ${l.tipo === 'entrada' ? 'pos' : 'neg'}">${brl(l.valor)}</td><td>${l.virtual ? '<span class="chip plan">regra</span>' : chip(l)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nada no período.</td></tr>'}
          ${lista.length > 12 ? `<tr><td colspan="5" class="mut small">… e mais ${lista.length - 12}. Abra Lançamentos para ver tudo.</td></tr>` : ''}</tbody></table></div>
        </div>
      </div>`;
    chartSaldo($('#ch-saldo'), serie, S.cfg.colchao);
  }
  const rowCls = l => { const st = status(l); return (st === 'atrasado' ? 'late ' : st === 'hoje' ? 'today ' : '') + (l.pago ? 'paid' : ''); };
  function rowLembrete(l) {
    const st = status(l), dd = Math.round((parse(l.data) - parse(HOJE)) / 864e5);
    const m = st === 'atrasado' ? `venceu há ${-dd} d · ${catNome(l.cat)}` : st === 'hoje' ? `vence hoje · ${catNome(l.cat)}` : `em ${dd} d · ${catNome(l.cat)}`;
    return `<div class="row ${st === 'atrasado' ? 'late' : st === 'hoje' ? 'today' : ''}"><span class="dt">${fmtD(l.data)}</span><div class="g"><div class="t">${esc(l.desc)}</div><div class="m">${esc(m)}</div></div><span class="val">${brl(l.valor)}</span>${l.id ? `<button class="btn sm ${st === 'atrasado' ? 'amb' : 'ghost'}" data-action="pagar" data-id="${l.id}">${l.tipo === 'entrada' ? 'Receber' : 'Pagar'}</button>` : ''}</div>`;
  }

  /* ═══════════ render: lançamentos ═══════════ */
  function renderLanc() {
    const [a, b] = range(UI.mode, UI.ref);
    const f = UI.filtros;
    let rows = S.lanc.filter(l => l.data >= a && l.data <= b);
    if (f.tipo !== 'todos') rows = rows.filter(l => l.tipo === f.tipo);
    if (f.st !== 'todos') rows = rows.filter(l => status(l) === f.st || (f.st === 'previsto' && status(l) === 'hoje'));
    if (f.quem !== 'todos') rows = rows.filter(l => l.quem === f.quem || l.quem === 'j');
    if (f.cat !== 'todos') rows = rows.filter(l => l.cat === f.cat);
    if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter(l => (l.desc + ' ' + catNome(l.cat) + ' ' + contaNome(l.conta) + ' ' + brl(l.valor) + ' ' + (l.obs || '')).toLowerCase().includes(q)); }
    rows.sort((x, y) => UI.sort === 'valor' ? y.valor - x.valor : UI.sort === 'desc' ? x.desc.localeCompare(y.desc) : x.data.localeCompare(y.data) || y.valor - x.valor);
    const total = sum(rows, signed);
    const tg = (id, key, opts) => `<div class="tg" data-filter="${key}">${opts.map(([v, t]) => `<button data-f="${v}" aria-pressed="${f[key] === v}">${t}</button>`).join('')}</div>`;
    $('#view-lancamentos').innerHTML = `
      <div class="vhead">
        <div><h2>Cada gasto, uma linha.</h2><p>Lançamentos de ${esc(periodLabel(UI.mode, UI.ref).toLowerCase())}. Previstos nascem das recorrências; pontuais são digitados. Ao pagar, o saldo da conta é ajustado.</p></div>
        <div class="acts"><button class="btn ghost" data-action="export">Exportar CSV</button><button class="btn pri" data-action="new-lanc">Novo</button></div>
      </div>
      <div>
        <div class="sec" style="gap:14px 20px">
          ${tg('tipo', 'tipo', [['todos', 'Todos'], ['entrada', 'Entradas'], ['saida', 'Saídas']])}
          ${tg('st', 'st', [['todos', 'Situação'], ['previsto', 'Previsto'], ['realizado', 'Realizado'], ['atrasado', 'Atrasado']])}
          ${tg('quem', 'quem', [['todos', 'Casa']].concat(S.pessoas.filter(p => p.id !== 'j').map(p => [p.id, p.nome])))}
          <select class="inl" data-filter-cat><option value="todos">Todas as categorias</option>${S.cats.map(c => `<option value="${c.id}" ${f.cat === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
          <label class="search"><span class="mut">⌕</span><input type="text" id="q" value="${esc(f.q)}" placeholder="Buscar descrição, valor, conta…"></label>
          <span class="line"></span>
          <span class="ex">${rows.length} LANÇAMENTOS · SALDO ${total >= 0 ? '+' : '−'}${brl(Math.abs(total))}</span>
        </div>
        <div class="tw"><table>
          <thead><tr><th class="sort" data-sort="data">Data ${UI.sort === 'data' ? '↓' : ''}</th><th class="sort" data-sort="desc">Descrição ${UI.sort === 'desc' ? '↓' : ''}</th><th>Quem</th><th>Categoria</th><th>Conta</th><th class="r sort" data-sort="valor">Valor ${UI.sort === 'valor' ? '↓' : ''}</th><th>Situação</th><th></th></tr></thead>
          <tbody>${rows.map(l => `<tr class="${rowCls(l)}" data-id="${l.id}">
            <td>${fmtD(l.data)}</td>
            <td class="desc"><b>${esc(l.desc)}</b>${l.recId ? ' <span class="chip rec quiet"></span>' : ''}${l.obs ? ` <span class="sub">${esc(l.obs)}</span>` : ''}</td>
            <td>${whoTag(l.quem)}</td><td class="d">${esc(catNome(l.cat))}</td><td class="d">${esc(contaNome(l.conta))}</td>
            <td class="r v ${l.tipo === 'entrada' ? 'pos' : 'neg'}">${brl(l.valor)}</td>
            <td>${chip(l)}</td>
            <td class="acts">${l.pago ? `<button class="btn sm ghost" data-action="despagar" data-id="${l.id}">Desfazer</button>` : `<button class="btn sm ${status(l) === 'atrasado' ? 'amb' : 'ghost'}" data-action="pagar" data-id="${l.id}">${l.tipo === 'entrada' ? 'Receber' : 'Pagar'}</button>`}<button class="btn sm ghost" data-action="edit-lanc" data-id="${l.id}">Editar</button></td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">Nenhum lançamento com esses filtros.</td></tr>'}</tbody>
        </table></div>
      </div>`;
  }

  /* ═══════════ render: lembretes ═══════════ */
  function renderLembretes() {
    const pend = S.lanc.filter(l => !l.pago).sort((x, y) => x.data.localeCompare(y.data) || y.valor - x.valor);
    const d7 = addDays(HOJE, S.cfg.lembreteDias), fimMes = range('mes', HOJE)[1];
    const g = [
      { k: 'late', t: 'Atrasados', it: pend.filter(l => l.data < HOJE && l.tipo === 'saida') },
      { k: 'today', t: 'Vencem hoje', it: pend.filter(l => l.data === HOJE && l.tipo === 'saida') },
      { k: '', t: `Próximos ${S.cfg.lembreteDias} dias`, it: pend.filter(l => l.data > HOJE && l.data <= d7 && l.tipo === 'saida') },
      { k: '', t: 'Até o fim do mês', it: pend.filter(l => l.data > d7 && l.data <= fimMes && l.tipo === 'saida') },
      { k: '', t: 'A receber', it: pend.filter(l => l.tipo === 'entrada' && l.data <= addMonths(COMP_HOJE, 1) + '-31') },
    ];
    const totalPend = sum(g.slice(0, 4).flatMap(x => x.it), l => l.valor);
    $('#view-lembretes').innerHTML = `
      <div class="vhead">
        <div><h2>O que ainda precisa ser pago.</h2><p>Tudo que não foi marcado como pago, ordenado por vencimento. Pagar ajusta o saldo da conta escolhida no lançamento.</p></div>
        <div class="acts"><button class="btn ghost" data-action="pagar-atrasados" ${g[0].it.length ? '' : 'disabled'}>Pagar todos os atrasados</button></div>
      </div>
      <div class="stats">
        <div><div class="v">${money(sum(g[0].it, l => l.valor))}</div><div class="r">${g[0].it.length} lançamentos</div><div class="l">atrasados</div></div>
        <div><div class="v">${money(sum(g[1].it.concat(g[2].it), l => l.valor))}</div><div class="r">${g[1].it.length + g[2].it.length} lançamentos</div><div class="l">hoje e próximos ${S.cfg.lembreteDias} dias</div></div>
        <div><div class="v">${money(totalPend)}</div><div class="r">saldo hoje ${money(saldoAtual())}</div><div class="l">a pagar até o fim do mês</div></div>
      </div>
      <div>${g.map(x => `<div class="group ${x.k}"><div class="gh"><h3>${x.t}</h3><span class="ex">${x.it.length} · ${money(sum(x.it, l => l.valor))}</span></div>
        <div class="list">${x.it.length ? x.it.map(rowLembrete).join('') : '<div class="empty">Nada aqui.</div>'}</div></div>`).join('')}</div>`;
  }

  /* ═══════════ render: recorrências ═══════════ */
  function freqTxt(r) {
    if (r.freq === 'mensal') return `mensal · dia ${r.dia}`;
    if (r.freq === 'quinzenal') return `quinzenal · dias ${r.dia} e ${+r.dia + 15}`;
    if (r.freq === 'semanal') return `semanal · ${DIAS[r.wd]}`;
    if (r.freq === 'anual') return `anual · ${r.dia}/${MES3[r.mes - 1]}`;
    if (r.freq === 'parcelado') return `${r.parcelas}× · dia ${r.dia}`;
    return r.freq;
  }
  function proximaData(r) {
    for (let c = COMP_HOJE; c <= addMonths(COMP_HOJE, 13); c = addMonths(c, 1)) {
      const d = datasDaRegra(r, c).map(x => x.data).filter(x => x >= HOJE);
      if (d.length) return d[0];
    }
    return null;
  }
  function renderRec() {
    const proxComp = addMonths(COMP_HOJE, 1);
    const ativas = S.rec.filter(r => r.ativo);
    const mensalSai = sum(ativas.filter(r => r.tipo === 'saida'), r => sum(virtuais(r, proxComp), v => v.valor));
    const mensalEnt = sum(ativas.filter(r => r.tipo === 'entrada'), r => sum(virtuais(r, proxComp), v => v.valor));
    const rows = S.rec.slice().sort((x, y) => (y.ativo - x.ativo) || (x.tipo > y.tipo ? 1 : -1) || y.valor - x.valor);
    $('#view-recorrencias').innerHTML = `
      <div class="vhead">
        <div><h2>O que se repete.</h2><p>Regras que geram lançamentos previstos. Os meses atual e seguinte são gerados automaticamente ao abrir o app. Editar uma regra atualiza só os previstos ainda não pagos.</p></div>
        <div class="acts"><input type="month" class="inl" id="gerar-comp" value="${addMonths(COMP_HOJE, 2)}"><button class="btn ghost" data-action="gerar">Gerar mês</button><button class="btn pri" data-action="new-rec">Nova regra</button></div>
      </div>
      <div class="stats">
        <div><div class="v">${money(mensalEnt)}</div><div class="r">${ativas.filter(r => r.tipo === 'entrada').length} regras</div><div class="l">entradas em ${fmtComp(proxComp)}</div></div>
        <div><div class="v">${money(mensalSai)}</div><div class="r">${ativas.filter(r => r.tipo === 'saida').length} regras</div><div class="l">saídas em ${fmtComp(proxComp)}</div></div>
        <div><div class="v">${money(mensalEnt - mensalSai)}</div><div class="r">meta ${money(S.cfg.metaSobra)}</div><div class="l">sobra estrutural</div></div>
      </div>
      <div class="tw"><table>
        <thead><tr><th>Regra</th><th>Quem</th><th>Tipo</th><th>Frequência</th><th class="r">Valor</th><th>Categoria</th><th>Conta</th><th>Vigência</th><th>Próxima</th><th></th></tr></thead>
        <tbody>${rows.map(r => { const px = proximaData(r); const k = r.freq === 'parcelado' ? monthsBetween(r.inicio, COMP_HOJE) + 1 : 0; return `<tr class="${r.ativo ? '' : 'off'}">
          <td class="desc"><b>${esc(r.desc)}</b>${k > 0 && k <= r.parcelas ? ` <span class="sub">${k}/${r.parcelas} pagas</span>` : ''}</td>
          <td>${whoTag(r.quem)}</td><td><span class="chip ${r.tipo === 'entrada' ? 'in' : 'out'} quiet">${r.tipo}</span></td>
          <td class="d">${freqTxt(r)}</td><td class="r v">${brl(r.valor)}</td><td class="d">${esc(catNome(r.cat))}</td><td class="d">${esc(contaNome(r.conta))}</td>
          <td class="d">${fmtComp(r.inicio)} → ${r.fim ? fmtComp(r.fim) : (r.freq === 'parcelado' ? fmtComp(addMonths(r.inicio, r.parcelas - 1)) : '—')}</td>
          <td>${r.ativo ? (px ? fmtDY(px) : '<span class="chip quiet">encerrada</span>') : '<span class="chip quiet">inativa</span>'}</td>
          <td class="acts"><button class="btn sm ghost" data-action="edit-rec" data-id="${r.id}">Editar</button></td></tr>`; }).join('')}</tbody>
      </table></div>
      <div class="grid c2">
        <div><div class="sec"><span class="line"></span><h3>Como a geração funciona</h3></div>
          <ul class="tight">
            <li><b>mensal</b>: dia fixo; em meses curtos usa o último dia.</li>
            <li><b>quinzenal</b>: dia fixo e dia + 15.</li>
            <li><b>semanal</b>: todo dia da semana escolhido.</li>
            <li><b>anual</b>: dia e mês (IPVA, seguro, matrícula).</li>
            <li><b>parcelado N×</b>: gera N previstos numerados a partir do início e encerra sozinho.</li>
            <li>Idempotente: gerar de novo não duplica (chave regra + data).</li>
          </ul>
        </div>
        <div><div class="sec"><span class="line"></span><h3>Meses gerados</h3></div>
          <div class="list">${S.gerado.slice().sort().reverse().slice(0, 8).map(c => `<div class="row"><span class="dt">${fmtComp(c)}</span><div class="g"><div class="m">${S.lanc.filter(l => l.recId && compOf(l.data) === c).length} lançamentos de regra · ${S.lanc.filter(l => l.recId && compOf(l.data) === c && !l.pago).length} em aberto</div></div></div>`).join('') || '<div class="empty">Nenhum mês gerado.</div>'}</div>
        </div>
      </div>`;
  }

  /* ═══════════ render: projeções ═══════════ */
  function projecaoMeses(n) {
    let saldo = saldoAtual() + sum(S.lanc.filter(l => !l.pago && l.data < COMP_HOJE + '-01'), signed);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const c = addMonths(COMP_HOJE, i), it = itensDoMes(c);
      const ent = it.filter(l => l.tipo === 'entrada'), sai = it.filter(l => l.tipo === 'saida');
      const entP = sum(ent.filter(l => !l.pago), l => l.valor), saiP = sum(sai.filter(l => !l.pago), l => l.valor);
      saldo += entP - saiP;
      rows.push({ comp: c, entradas: sum(ent, l => l.valor), saidas: sum(sai, l => l.valor), entR: sum(ent.filter(l => l.pago), l => l.valor), saiR: sum(sai.filter(l => l.pago), l => l.valor), fixas: sum(sai.filter(l => l.recId), l => l.valor), saldo, gerado: S.gerado.includes(c) });
    }
    return rows;
  }
  function renderProj() {
    const rows = projecaoMeses(UI.horizonte);
    const low = rows.filter(r => r.saldo < S.cfg.colchao), minR = rows.reduce((m, r) => r.saldo < m.saldo ? r : m, rows[0]);
    const sobraMedia = sum(rows.slice(1), r => r.entradas - r.saidas) / Math.max(1, rows.length - 1);
    $('#view-projecoes').innerHTML = `
      <div class="vhead">
        <div><h2>Para onde o saldo caminha.</h2><p>Saldo disponível projetado mês a mês: saldo de hoje mais previstos das recorrências e lançamentos futuros. Meses ainda não gerados usam as regras diretamente.</p></div>
        <div class="tg" id="horizonte">${[3, 6, 12].map(n => `<button data-h="${n}" aria-pressed="${UI.horizonte === n}">${n} meses</button>`).join('')}</div>
      </div>
      <div class="stats">
        <div><div class="v">${money(minR.saldo)}</div><div class="r">${fmtComp(minR.comp)} · colchão ${money(S.cfg.colchao)}</div><div class="l">menor saldo projetado</div></div>
        <div><div class="v">${money(rows[rows.length - 1].saldo)}</div><div class="r">ao fim de ${fmtComp(rows[rows.length - 1].comp)}</div><div class="l">saldo no horizonte</div></div>
        <div><div class="v">${sobraMedia < 0 ? '−' : ''}${money(Math.abs(sobraMedia))}</div><div class="r">meta ${money(S.cfg.metaSobra)} · ${sobraMedia >= S.cfg.metaSobra ? 'dentro' : 'abaixo'}</div><div class="l">sobra média por mês</div></div>
      </div>
      <div>
        <div class="sec"><span class="line"></span><h3>Saldo ao fim de cada mês</h3></div>
        <div class="claim">${low.length ? `${low.length} ${low.length === 1 ? 'mês encosta' : 'meses encostam'} no colchão: ${low.map(r => fmtComp(r.comp)).join(', ')}.` : 'Nenhum mês encosta no colchão.'}</div>
        <div class="micro">projeção acumulada · aportes na reserva contam como saída</div>
        <div class="panel fig"><svg id="ch-meses" preserveAspectRatio="xMidYMid meet"></svg></div>
      </div>
      <div class="tw"><table>
        <thead><tr><th>Mês</th><th class="r">Entradas</th><th class="r">Saídas</th><th class="r">Fixas</th><th class="r">Sobra</th><th class="r">Saldo final</th><th>Origem</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.saldo < S.cfg.colchao ? 'late' : ''}"><td><b>${fmtComp(r.comp)}</b>${r.comp === COMP_HOJE ? ' <span class="chip today">atual</span>' : ''}</td><td class="r v pos">${brl0(r.entradas)}</td><td class="r v neg">${brl0(r.saidas)}</td><td class="r d">${brl0(r.fixas)}</td><td class="r v ${r.entradas - r.saidas < 0 ? 'neg' : 'pos'}">${brl0(Math.abs(r.entradas - r.saidas))}</td><td class="r v">${brl0(r.saldo)}</td><td>${r.gerado ? '<span class="chip done">lançamentos</span>' : '<span class="chip plan">regras</span>'}</td></tr>`).join('')}</tbody>
      </table></div>`;
    chartMeses($('#ch-meses'), rows, S.cfg.colchao);
  }

  /* ═══════════ render: ajustes ═══════════ */
  function renderAjustes() {
    $('#view-ajustes').innerHTML = `
      <div class="vhead"><div><h2>Tabelas de apoio.</h2><p>Pessoas, contas e categorias. O saldo das contas é o ponto de partida da projeção; pagar um lançamento desconta da conta escolhida. ${NET.on ? 'Os dados ficam no servidor da casa, com histórico de cada alteração.' : 'Os dados ficam neste navegador.'}</p></div>
        <div class="acts"><button class="btn ghost" data-action="backup">Baixar backup JSON</button><label class="btn ghost">Restaurar<input type="file" id="restore" accept="application/json" hidden></label><button class="btn ghost danger" data-action="reset">Recomeçar com exemplo</button></div></div>
      <div class="grid c2">
        <div><div class="sec"><span class="line"></span><h3>Parâmetros</h3></div>
          <form id="form-cfg" class="fgrid">
            <label class="field"><span class="lab">Colchão mínimo (R$)</span><input type="text" name="colchao" value="${brl0(S.cfg.colchao)}"></label>
            <label class="field"><span class="lab">Meta de sobra mensal (R$)</span><input type="text" name="metaSobra" value="${brl0(S.cfg.metaSobra)}"></label>
            <label class="field"><span class="lab">Lembrar com antecedência (dias)</span><input type="number" name="lembreteDias" min="1" max="60" value="${S.cfg.lembreteDias}"></label>
            <div class="field" style="justify-content:flex-end"><button class="btn pri" type="submit">Salvar parâmetros</button></div>
          </form>
        </div>
        <div><div class="sec"><span class="line"></span><h3>Pessoas</h3></div>
          <div class="tw"><table><thead><tr><th>Nome</th><th>Sigla</th><th></th></tr></thead><tbody>${S.pessoas.map(p => `<tr><td><b>${esc(p.nome)}</b>${p.id === 'j' ? ' <span class="sub mut">(conjunto)</span>' : ''}</td><td>${whoTag(p.id)}</td><td class="acts"><button class="btn sm ghost" data-action="rename-pessoa" data-id="${p.id}">Renomear</button></td></tr>`).join('')}</tbody></table></div>
        </div>
        <div><div class="sec"><span class="line"></span><h3>Contas</h3><button class="btn sm ghost" data-action="new-conta">Nova</button></div>
          <div class="tw"><table><thead><tr><th>Nome</th><th>Tipo</th><th class="r">Saldo</th><th>Na projeção</th><th></th></tr></thead>
          <tbody>${S.contas.map(c => `<tr><td><b>${esc(c.nome)}</b></td><td class="d">${c.tipo}</td><td class="r v">${brl(c.saldo)}</td><td>${c.reserva ? '<span class="chip quiet">reserva</span>' : c.tipo === 'cartao' ? '<span class="chip quiet">não</span>' : '<span class="chip done">sim</span>'}</td><td class="acts"><button class="btn sm ghost" data-action="edit-conta" data-id="${c.id}">Editar</button></td></tr>`).join('')}
          <tr class="sum"><td>Disponível</td><td></td><td class="r">${brl(saldoAtual())}</td><td></td><td></td></tr></tbody></table></div>
        </div>
        <div><div class="sec"><span class="line"></span><h3>Categorias</h3><button class="btn sm ghost" data-action="new-cat">Nova</button></div>
          <div class="tw"><table><thead><tr><th>Nome</th><th>Tipo</th><th class="r">Teto mensal</th><th class="r">Em uso</th><th></th></tr></thead>
          <tbody>${S.cats.map(c => `<tr><td><b>${esc(c.nome)}</b></td><td><span class="chip ${c.tipo === 'entrada' ? 'in' : 'out'} quiet">${c.tipo}</span></td><td class="r">${c.teto ? brl0(c.teto) : '—'}</td><td class="r d">${S.lanc.filter(l => l.cat === c.id).length}</td><td class="acts"><button class="btn sm ghost" data-action="edit-cat" data-id="${c.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>
        </div>
      </div>
      ${NET.on ? `<div><div class="sec"><span class="line"></span><h3>Histórico de alterações</h3><span class="ex">últimas 30 revisões · revisão atual ${NET.rev}</span></div><div id="hist"><div class="empty">Carregando…</div></div><div id="hist-detail"></div></div>` : ''}`;
    if (NET.on) renderHistory();
  }

  /* ═══════════ render geral ═══════════ */
  function renderNav() {
    const atras = S.lanc.filter(l => !l.pago && l.data < HOJE).length;
    const pend = S.lanc.filter(l => !l.pago && l.tipo === 'saida' && l.data <= addDays(HOJE, S.cfg.lembreteDias)).length;
    $('#n-painel').textContent = MES3[parse(HOJE).getMonth()].toUpperCase() + '/' + HOJE.slice(2, 4);
    $('#n-lanc').textContent = S.lanc.filter(l => compOf(l.data) === COMP_HOJE).length;
    const nl = $('#n-lemb'); nl.textContent = pend; nl.classList.toggle('warn', atras > 0);
    $('#n-rec').textContent = S.rec.filter(r => r.ativo).length;
    $('#railfoot').innerHTML = `<b>${fmtDY(HOJE)}</b><br>saldo disponível <b>${money(saldoAtual())}</b><br>${atras ? `<b>${atras}</b> atrasado${atras > 1 ? 's' : ''}` : 'nada atrasado'}` + (NET.on && NET.user ? `<br>${esc(NET.user.nome)} · <button class="linkbtn" data-action="logout">sair</button>` : '');
    $$('.nav button').forEach(b => b.setAttribute('aria-current', b.dataset.view === UI.view ? 'page' : 'false'));
    $$('#mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === UI.mode)));
    $('#period-label').textContent = periodLabel(UI.mode, UI.ref);
    $('#period-state').textContent = periodState(UI.mode, UI.ref);
    const periodViews = UI.view === 'painel' || UI.view === 'lancamentos';
    $('#mode').classList.toggle('hidden', !periodViews);
    $('.period').classList.toggle('hidden', !periodViews);
  }
  function render() {
    themeColors();
    renderNav();
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + UI.view));
    ({ painel: renderPainel, lancamentos: renderLanc, lembretes: renderLembretes, recorrencias: renderRec, projecoes: renderProj, ajustes: renderAjustes })[UI.view]();
  }
  function show(view) { UI.view = view; history.replaceState(null, '', '#' + view); window.scrollTo({ top: 0 }); render(); }

  /* ═══════════ ações ═══════════ */
  function pagar(id, undo) {
    const l = S.lanc.find(x => x.id === id); if (!l) return;
    const c = contaById(l.conta);
    if (!undo && !l.pago) { l.pago = true; l.dataPago = HOJE; if (c) c.saldo = Math.round((c.saldo + signed(l)) * 100) / 100; }
    else if (undo && l.pago) { l.pago = false; l.dataPago = null; if (c) c.saldo = Math.round((c.saldo - signed(l)) * 100) / 100; }
    save(); render();
    toast(undo ? 'Pagamento desfeito' : `${l.tipo === 'entrada' ? 'Recebido' : 'Pago'}: ${l.desc} · ${money(l.valor)}`);
  }
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

  /* drawers */
  const openDrawer = id => { const d = $('#' + id); d.classList.add('open'); d.setAttribute('aria-hidden', 'false'); const f = d.querySelector('input:not([type=hidden]),select'); if (f) setTimeout(() => f.focus(), 50); };
  const closeDrawers = () => $$('.drawer').forEach(d => { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); });
  const setSeg = (form, key, val) => $$(`[data-seg="${key}"] button`, form).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.val === val)));
  const getSeg = (form, key) => ($(`[data-seg="${key}"] button[aria-pressed="true"]`, form) || {}).dataset?.val;
  function fillSelects(form, tipo) {
    const cats = S.cats.filter(c => c.tipo === tipo);
    $$('select[name=cat]', form).forEach(s => { const v = s.value; s.innerHTML = cats.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join(''); if (cats.some(c => c.id === v)) s.value = v; });
    $$('select[name=conta]', form).forEach(s => { const v = s.value; s.innerHTML = S.contas.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join(''); if (S.contas.some(c => c.id === v)) s.value = v; });
    $$('[data-seg="quem"]', form).forEach(seg => { const v = getSeg(form, 'quem') || 'j'; seg.innerHTML = S.pessoas.map(p => `<button type="button" data-val="${p.id}" aria-pressed="${p.id === v}">${esc(p.nome)}</button>`).join(''); });
  }

  function openLanc(l) {
    const f = $('#form-lanc'); f.reset();
    const tipo = l ? l.tipo : 'saida';
    setSeg(f, 'tipo', tipo); fillSelects(f, tipo); setSeg(f, 'quem', l ? l.quem : 'j');
    f.id.value = l ? l.id : '';
    f.desc.value = l ? l.desc : '';
    f.valor.value = l ? brl(l.valor) : '';
    f.data.value = l ? l.data : (UI.mode === 'mes' && compOf(UI.ref) !== COMP_HOJE ? range('mes', UI.ref)[0] : HOJE);
    if (l) { f.cat.value = l.cat; f.conta.value = l.conta; }
    f.pago.checked = !!(l && l.pago); f.dataPago.value = l && l.dataPago ? l.dataPago : ''; f.dataPago.disabled = !f.pago.checked;
    f.obs.value = l ? l.obs || '' : '';
    $('#lanc-title').textContent = l ? 'Editar lançamento' : 'Novo lançamento';
    $('#lanc-del').hidden = !l;
    const rec = l && l.recId ? S.rec.find(r => r.id === l.recId) : null;
    $('#lanc-rec-note').hidden = !rec; if (rec) $('#lanc-rec-name').textContent = rec.desc;
    openDrawer('drawer-lanc');
  }
  function saveLanc(e) {
    e.preventDefault();
    const f = $('#form-lanc'), valor = parseMoney(f.valor.value);
    if (!(valor > 0)) { toast('Valor inválido'); f.valor.focus(); return; }
    const id = f.id.value ? +f.id.value : null;
    const prev = id ? S.lanc.find(x => x.id === id) : null;
    const pagoAntes = prev ? prev.pago : false;
    if (prev && prev.pago) { const c = contaById(prev.conta); if (c) c.saldo -= signed(prev); } // desfaz efeito antigo
    const l = prev || { id: S.seq.lanc++, recId: null };
    Object.assign(l, { tipo: getSeg(f, 'tipo'), quem: getSeg(f, 'quem') || 'j', desc: f.desc.value.trim(), valor, data: f.data.value, cat: f.cat.value, conta: f.conta.value, pago: f.pago.checked, dataPago: f.pago.checked ? (f.dataPago.value || HOJE) : null, obs: f.obs.value.trim() });
    if (l.pago) { const c = contaById(l.conta); if (c) c.saldo = Math.round((c.saldo + signed(l)) * 100) / 100; }
    if (!prev) S.lanc.push(l);
    save(); closeDrawers(); render(); toast(prev ? 'Lançamento atualizado' : 'Lançamento criado' + (l.pago && !pagoAntes ? ' e pago' : ''));
  }
  function delLanc() {
    const id = +$('#form-lanc').id.value, l = S.lanc.find(x => x.id === id); if (!l) return;
    if (!confirm(`Excluir "${l.desc}" (${money(l.valor)})?`)) return;
    if (l.pago) { const c = contaById(l.conta); if (c) c.saldo -= signed(l); }
    S.lanc = S.lanc.filter(x => x.id !== id); save(); closeDrawers(); render(); toast('Lançamento excluído');
  }

  function openRec(r) {
    const f = $('#form-rec'); f.reset();
    const tipo = r ? r.tipo : 'saida';
    setSeg(f, 'tipo', tipo); fillSelects(f, tipo); setSeg(f, 'quem', r ? r.quem : 'j');
    f.id.value = r ? r.id : ''; f.desc.value = r ? r.desc : ''; f.valor.value = r ? brl(r.valor) : '';
    f.freq.value = r ? r.freq : 'mensal'; f.dia.value = r ? r.dia : 10; f.wd.value = r ? r.wd : 1; f.mes.value = r ? r.mes : 1; f.parcelas.value = r ? r.parcelas : 12;
    f.inicio.value = r ? r.inicio : COMP_HOJE; f.fim.value = r && r.fim ? r.fim : '';
    if (r) { f.cat.value = r.cat; f.conta.value = r.conta; }
    f.ativo.checked = r ? r.ativo : true;
    $('#rec-title').textContent = r ? 'Editar recorrência' : 'Nova recorrência';
    $('#rec-del').hidden = !r;
    syncFreq(); openDrawer('drawer-rec');
  }
  function syncFreq() {
    const v = $('#rec-freq').value;
    $('#f-dia').hidden = v === 'semanal'; $('#f-wd').hidden = v !== 'semanal'; $('#f-mes').hidden = v !== 'anual'; $('#f-parc').hidden = v !== 'parcelado';
  }
  function saveRec(e) {
    e.preventDefault();
    const f = $('#form-rec'), valor = parseMoney(f.valor.value);
    if (!(valor > 0)) { toast('Valor inválido'); f.valor.focus(); return; }
    const id = f.id.value ? +f.id.value : null;
    const r = id ? S.rec.find(x => x.id === id) : { id: S.seq.rec++ };
    Object.assign(r, { tipo: getSeg(f, 'tipo'), quem: getSeg(f, 'quem') || 'j', desc: f.desc.value.trim(), valor, freq: f.freq.value, dia: +f.dia.value || 1, wd: +f.wd.value, mes: +f.mes.value, parcelas: +f.parcelas.value || 1, inicio: f.inicio.value, fim: f.fim.value || null, cat: f.cat.value, conta: f.conta.value, ativo: f.ativo.checked });
    if (!id) S.rec.push(r);
    // sincroniza previstos não pagos: remove os desta regra e regenera nos meses já gerados
    S.lanc = S.lanc.filter(l => !(l.recId === r.id && !l.pago));
    S.gerado.forEach(c => { if (c >= COMP_HOJE) virtuais(r, c).forEach(v => { if (!S.lanc.some(l => l.recId === r.id && l.data === v.data)) { v.id = S.seq.lanc++; delete v.virtual; S.lanc.push(v); } }); });
    save(); closeDrawers(); render(); toast(id ? 'Regra atualizada e previstos sincronizados' : 'Regra criada');
  }
  function delRec() {
    const id = +$('#form-rec').id.value, r = S.rec.find(x => x.id === id); if (!r) return;
    const n = S.lanc.filter(l => l.recId === id && !l.pago).length;
    if (!confirm(`Excluir a regra "${r.desc}"? ${n} previstos não pagos serão removidos; os pagos ficam.`)) return;
    S.rec = S.rec.filter(x => x.id !== id); S.lanc = S.lanc.filter(l => !(l.recId === id && !l.pago));
    S.lanc.forEach(l => { if (l.recId === id) l.recId = null; });
    save(); closeDrawers(); render(); toast('Regra excluída');
  }

  /* cadastros simples via prompt */
  const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'x';
  function editConta(c) {
    const nome = prompt('Nome da conta', c ? c.nome : ''); if (nome === null || !nome.trim()) return;
    const tipo = prompt('Tipo: corrente, cartao, carteira ou reserva', c ? c.tipo : 'corrente'); if (tipo === null) return;
    const saldo = parseMoney(prompt('Saldo atual (R$)', c ? brl(c.saldo) : '0,00')); if (isNaN(saldo)) { toast('Saldo inválido'); return; }
    if (!c) { let id = slug(nome), k = 1; while (contaById(id)) id = slug(nome) + '-' + k++; c = { id }; S.contas.push(c); }
    Object.assign(c, { nome: nome.trim(), tipo: ['corrente', 'cartao', 'carteira', 'reserva'].includes(tipo.trim()) ? tipo.trim() : 'corrente', saldo, reserva: tipo.trim() === 'reserva' });
    save(); render(); toast('Conta salva');
  }
  function editCat(c) {
    const nome = prompt('Nome da categoria', c ? c.nome : ''); if (nome === null || !nome.trim()) return;
    const tipo = c ? c.tipo : (confirm('É uma categoria de SAÍDA? (Cancelar = entrada)') ? 'saida' : 'entrada');
    const teto = tipo === 'saida' ? parseMoney(prompt('Teto mensal (R$, 0 = sem teto)', c ? brl0(c.teto) : '0')) : 0; if (isNaN(teto)) { toast('Teto inválido'); return; }
    if (!c) { let id = slug(nome), k = 1; while (catById(id)) id = slug(nome) + '-' + k++; c = { id }; S.cats.push(c); }
    Object.assign(c, { nome: nome.trim(), tipo, teto });
    save(); render(); toast('Categoria salva');
  }

  function exportCSV() {
    const [a, b] = range(UI.mode, UI.ref);
    const rows = S.lanc.filter(l => l.data >= a && l.data <= b).sort((x, y) => x.data.localeCompare(y.data));
    const csv = ['data;tipo;descricao;quem;categoria;conta;valor;situacao;pago_em;obs'].concat(rows.map(l => [l.data, l.tipo, l.desc, pessoaNome(l.quem), catNome(l.cat), contaNome(l.conta), brl(l.valor), status(l), l.dataPago || '', l.obs || ''].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(';'))).join('\n');
    download(`caderno-${a}_${b}.csv`, '﻿' + csv, 'text/csv');
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type }), u = URL.createObjectURL(blob), x = document.createElement('a');
    x.href = u; x.download = name; document.body.appendChild(x); x.click(); x.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
  }

  /* ═══════════ eventos ═══════════ */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-action],[data-view],[data-close],[data-mode],#prev,#next,#today,[data-filter] button,#scope button,#horizonte button,[data-sort],.seg button');
    if (!t) return;
    if (t.dataset.close !== undefined) { closeDrawers(); return; }
    if (t.dataset.view) { show(t.dataset.view); return; }
    if (t.dataset.mode) { UI.mode = t.dataset.mode; render(); return; }
    if (t.id === 'prev') { UI.ref = shift(UI.mode, UI.ref, -1); render(); return; }
    if (t.id === 'next') { UI.ref = shift(UI.mode, UI.ref, 1); render(); return; }
    if (t.id === 'today') { UI.ref = HOJE; render(); return; }
    if (t.closest('[data-filter]')) { UI.filtros[t.closest('[data-filter]').dataset.filter] = t.dataset.f; render(); return; }
    if (t.closest('#scope')) { UI.filtros.quem = t.dataset.quem; show('lancamentos'); return; }
    if (t.closest('#horizonte')) { UI.horizonte = +t.dataset.h; render(); return; }
    if (t.dataset.sort) { UI.sort = t.dataset.sort; render(); return; }
    if (t.closest('.seg')) {
      const seg = t.closest('.seg'); $$('button', seg).forEach(b => b.setAttribute('aria-pressed', String(b === t)));
      if (seg.dataset.seg === 'tipo') fillSelects(t.closest('form'), t.dataset.val);
      return;
    }
    const a = t.dataset.action, id = +t.dataset.id;
    if (a === 'new-lanc') openLanc(null);
    else if (a === 'edit-lanc') openLanc(S.lanc.find(x => x.id === id));
    else if (a === 'pagar') pagar(id, false);
    else if (a === 'despagar') pagar(id, true);
    else if (a === 'pagar-atrasados') { const at = S.lanc.filter(l => !l.pago && l.data < HOJE && l.tipo === 'saida'); if (at.length && confirm(`Marcar ${at.length} atrasados como pagos hoje (${money(sum(at, l => l.valor))})?`)) { at.forEach(l => { l.pago = true; l.dataPago = HOJE; const c = contaById(l.conta); if (c) c.saldo += signed(l); }); save(); render(); toast(`${at.length} pagos`); } }
    else if (a === 'new-rec') openRec(null);
    else if (a === 'edit-rec') openRec(S.rec.find(x => x.id === id));
    else if (a === 'gerar') { const c = $('#gerar-comp').value; if (c) { gerar(c, false); render(); } }
    else if (a === 'export') exportCSV();
    else if (a === 'backup') download(`caderno-da-casa-${HOJE}.json`, JSON.stringify(S, null, 2), 'application/json');
    else if (a === 'reset') { if (confirm(NET.on ? 'Substituir todos os dados da casa pelo exemplo? O histórico permite ver o que havia antes.' : 'Apagar todos os dados deste navegador e recomeçar com o exemplo?')) { if (!NET.on) localStorage.removeItem(KEY); seed(); render(); toast('Dados de exemplo restaurados'); } }
    else if (a === 'logout') { api('POST', '/api/logout').catch(() => null).finally(() => location.reload()); }
    else if (a === 'hist-detail') showHistoryDetail(t.dataset.id);
    else if (a === 'new-conta') editConta(null);
    else if (a === 'edit-conta') editConta(contaById(t.dataset.id));
    else if (a === 'new-cat') editCat(null);
    else if (a === 'edit-cat') editCat(catById(t.dataset.id));
    else if (a === 'rename-pessoa') { const p = pessoaById(t.dataset.id); const n = prompt('Nome', p.nome); if (n && n.trim()) { p.nome = n.trim(); save(); render(); } }
  });
  document.addEventListener('change', e => {
    if (e.target.matches('[data-filter-cat]')) { UI.filtros.cat = e.target.value; render(); }
    if (e.target.id === 'chk-pago') { const f = $('#form-lanc'); f.dataPago.disabled = !e.target.checked; if (e.target.checked && !f.dataPago.value) f.dataPago.value = HOJE; }
    if (e.target.id === 'rec-freq') syncFreq();
    if (e.target.id === 'restore') {
      const file = e.target.files[0]; if (!file) return;
      file.text().then(txt => { const d = JSON.parse(txt); if (!d.lanc || !d.rec || !d.contas) throw 0; S = d; save(); render(); toast('Backup restaurado'); }).catch(() => toast('Arquivo inválido'));
    }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'q') { UI.filtros.q = e.target.value; const pos = e.target.selectionStart; renderLanc(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }
  });
  document.addEventListener('submit', e => {
    if (e.target.matches('#form-lanc')) saveLanc(e);
    else if (e.target.matches('#form-rec')) saveRec(e);
    else if (e.target.matches('#form-login')) doLogin(e);
    else if (e.target.matches('#form-cfg')) { e.preventDefault(); const f = e.target; const c = parseMoney(f.colchao.value), m = parseMoney(f.metaSobra.value), d = +f.lembreteDias.value; if (isNaN(c) || isNaN(m) || !(d > 0)) { toast('Valores inválidos'); return; } S.cfg = { colchao: c, metaSobra: m, lembreteDias: d }; save(); render(); toast('Parâmetros salvos'); }
  });
  $('#theme-toggle').addEventListener('click', () => { applyTheme(currentTheme() === 'light' ? 'dark' : 'light'); render(); });
  $('#lanc-del').addEventListener('click', delLanc);
  $('#rec-del').addEventListener('click', delRec);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDrawers();
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.target.closest('input,textarea,select') && !$('.drawer.open') && $('#login').hidden) { e.preventDefault(); openLanc(null); }
  });

  /* ═══════════ boot ═══════════ */
  function afterLoad() {
    [COMP_HOJE, addMonths(COMP_HOJE, 1)].forEach(c => { if (!S.gerado.includes(c)) gerar(c, true); });
    save();
    const initial = location.hash.replace('#', '');
    if (initial && $('#view-' + initial)) UI.view = initial;
    render();
  }
  async function boot() {
    applyTheme(currentTheme());
    const p = await ping();
    if (p) { NET.on = true; NET.user = p.user; NET.users = p.users; $('.brand .ver').textContent = 'v1.0 · servidor da casa'; }
    if (NET.on && !NET.user) { showLogin(); return; }
    if (NET.on) { if (!(await loadRemote())) return; } else load();
    afterLoad();
  }
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (S && v && v !== UI.view && $('#view-' + v)) show(v); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (NET.pending) { clearTimeout(NET.timer); flush(true); } } else poll(); });
  setInterval(poll, 60000);
  boot();
})();
