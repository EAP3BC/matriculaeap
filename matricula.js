/* ============================================================
   MATRICULA.JS — App de Matrícula
   - Cadastro por RE (puxa dados do banco)
   - Visualização de turmas em ESPELHO do eap3bc
     • "Turmas Criadas"    → turmas em andamento (concluida = false)
     • "Turmas Concluídas" → turmas concluídas (concluida = true)
   - Filtro por categoria (Cb/Sd, Subten/Sgt, Oficiais)
   - Controle de acesso por Cia/Seção
   - TRANSFERÊNCIA e EXCLUSÃO geram SOLICITAÇÃO
     com aprovação obrigatória do gestor (tabela eap_solicitacoes)
   - "Minhas Solicitações" mostra apenas PENDENTES por padrão.
     Botão "Ver histórico" alterna para exibir todas.
   - Atualização automática do badge ao voltar foco/visibilidade
     e a cada 60s (polling leve).
   - NOVO: ao criar uma solicitação, também grava entrada no log
     de auditoria (eap_registrar_tentativa).
   - NOVO: cada linha de "Minhas Solicitações" é clicável e abre
     o modal de "Detalhes da Solicitação" (layout profissional).
   ============================================================ */

let currentYear = 2027;
let currentUser = null;
let currentUserCia = null;
let dbMatriculas = [];
let dbAlocacoes = [];
let dbPoliciais = {};
let dbTurmas = [];
let dbLog = [];
let dbSolicitacoes = [];
let currentOfficer = null;

const state = {
  search: '',
  catFiltro: 'cb_sd',
  mostrarHistoricoSolic: false
};

const AVAILABLE_YEARS = [2027, 2028, 2029, 2030];

const CAT_LABELS = {
  cb_sd: 'Cb/Sd',
  subten_sgt: 'Subten/Sgt',
  oficiais: 'Oficiais'
};

/* ============================================================
   CONTROLE DE ACESSO POR CIA/SEÇÃO
   ============================================================ */
const CIA_USERS = {
  '3bpmi1cia@policiamilitar.sp.gov.br':     { num: '1',  label: '1ª CIA PM',     match: 'cia_num' },
  '3bpmi2cia@policiamilitar.sp.gov.br':     { num: '2',  label: '2ª CIA PM',     match: 'cia_num' },
  '3bpmi3cia@policiamilitar.sp.gov.br':     { num: '3',  label: '3ª CIA PM',     match: 'cia_num' },
  '3bpmiciaftat@policiamilitar.sp.gov.br':  { num: 'ft', label: 'CIA FT',        match: 'cia_ft'  },
  'dfukuda@policiamilitar.sp.gov.br':       { num: null, label: 'Admin (todos)', match: 'all'     }
};

function getUserCiaRestriction(email){
  if (!email) return null;
  const key = String(email).toLowerCase().trim();
  return CIA_USERS[key] || null;
}

function getCiaSecao(p){
  return String(p?.cia_secao || p?.ciaSecao || '').trim();
}

function ciaStringMatches(ciaString, num){
  if (!num || !ciaString) return false;
  const s = String(ciaString).toUpperCase();
  const p1 = new RegExp(`(^|[^0-9])${num}\\s*[ªºaAoO°]?\\s*CIA`, 'i');
  const p2 = new RegExp(`CIA\\s*${num}([^0-9]|$)`, 'i');
  return p1.test(s) || p2.test(s);
}

function ciaFTMatches(ciaString){
  if (!ciaString) return false;
  const s = String(ciaString).toUpperCase();
  if (/(^|[^A-Z0-9])FT([^A-Z0-9]|$)/.test(s)) return true;
  if (/FOR[CÇ]A\s*T[AÁ]TICA/.test(s)) return true;
  return false;
}

function policialMatchesUserCia(p){
  if (!currentUserCia) return true;
  if (currentUserCia.match === 'all') return true;
  if (!p) return false;
  const ciaStr = getCiaSecao(p);
  if (!ciaStr) return false;
  if (currentUserCia.match === 'cia_num') return ciaStringMatches(ciaStr, currentUserCia.num);
  if (currentUserCia.match === 'cia_ft')  return ciaFTMatches(ciaStr);
  return false;
}

function logEntryMatchesUserCia(l){
  if (!currentUserCia) return true;
  if (currentUserCia.match === 'all') return true;
  if (!l) return false;
  if (l.policial_cia){
    if (currentUserCia.match === 'cia_num' && ciaStringMatches(l.policial_cia, currentUserCia.num)) return true;
    if (currentUserCia.match === 'cia_ft'  && ciaFTMatches(l.policial_cia)) return true;
  }
  if (l.re){
    const p = dbPoliciais[String(l.re)];
    if (p) return policialMatchesUserCia(p);
  }
  return false;
}

function atualizarCiaBadge(){
  const el = document.getElementById('cia-badge');
  if (!el) return;
  if (currentUserCia){
    el.textContent = currentUserCia.label;
    el.style.display = 'inline-flex';
    el.classList.toggle('admin', currentUserCia.match === 'all');
    el.title = currentUserCia.match === 'all'
      ? 'Acesso total — visualiza todas as Cias'
      : `Acesso restrito à ${currentUserCia.label}`;
  } else {
    el.textContent = '';
    el.style.display = 'none';
    el.title = '';
    el.classList.remove('admin');
  }
}

/* ============================================================
   LABELS
   ============================================================ */
const ACAO_LABEL = {
  criada:                    { txt: 'Matrícula criada',      cls: 'pill-green' },
  cancelada:                 { txt: 'Excluída',              cls: 'pill-red'   },
  reativada:                 { txt: 'Reativada',             cls: 'pill-green' },
  atualizada:                { txt: 'Transferida',           cls: 'pill-blue'  },
  excluida:                  { txt: 'Excluída',              cls: 'pill-red'   },
  tentativa_duplicada:       { txt: 'Tentativa duplicada',   cls: 'pill-red'   },
  tentativa_re_inexistente:  { txt: 'RE não encontrado',     cls: 'pill-amber' },
  aprovada:                  { txt: 'Aprovada',              cls: 'pill-green' },
  reprovada:                 { txt: 'Devolvida',             cls: 'pill-red'   },
  reenviada:                 { txt: 'Reenviada',             cls: 'pill-blue'  },
  solicitacao_transferencia: { txt: 'Solicitou transferência', cls: 'pill-amber' },
  solicitacao_exclusao:      { txt: 'Solicitou exclusão',    cls: 'pill-amber' },
  solicitacao_aprovada:      { txt: 'Solicitação aprovada',  cls: 'pill-green' },
  solicitacao_reprovada:     { txt: 'Solicitação reprovada', cls: 'pill-red'   }
};

const APROVACAO_LABEL = {
  pendente:  { txt: 'Pendente',  cls: 'pill-amber' },
  aprovada:  { txt: 'Aprovada',  cls: 'pill-green' },
  reprovada: { txt: 'Reprovada', cls: 'pill-red'   },
  alocado:   { txt: 'Alocado',   cls: 'pill-blue'  }
};

const SOLIC_LABEL = {
  pendente:  { txt: 'Aguardando gestor', cls: 'pill-amber' },
  aprovada:  { txt: 'Aprovada',          cls: 'pill-green' },
  reprovada: { txt: 'Reprovada',         cls: 'pill-red'   },
  cancelada: { txt: 'Cancelada',         cls: 'pill-gray'  }
};

function romanToInt(r){
  const map = {I:1,V:5,X:10,L:50,C:100,D:500,M:1000};
  let n = 0;
  const s = String(r||'').toUpperCase();
  if (!s) return 999;
  for (let i=0;i<s.length;i++){
    const c = map[s[i]]; const nx = map[s[i+1]];
    if (!c) return 999;
    if (nx && c < nx) n -= c; else n += c;
  }
  return n || 999;
}

function inferirCategoria(postoGrad){
  if (!postoGrad) return 'cb_sd';
  const s = String(postoGrad).toUpperCase();
  if (/(CEL|MAJ|CAP|TEN)\s*PM/.test(s) && !/SUB/.test(s)) return 'oficiais';
  if (/(SUB|SGT)/.test(s)) return 'subten_sgt';
  return 'cb_sd';
}

/* ============================================================
   CONEXÃO
   ============================================================ */
async function checarConexao(){
  const el = document.getElementById('conn-status');
  if (!sb){
    if (el){ el.textContent = 'Local (sem Supabase)'; el.className = 'conn-status offline'; }
    return false;
  }
  try {
    const { error } = await sb.from('policiais').select('re', { count:'exact', head:true }).limit(1);
    if (error) throw error;
    if (el){ el.textContent = 'Supabase Online'; el.className = 'conn-status online'; }
    return true;
  } catch(err){
    if (el){ el.textContent = 'Supabase Offline'; el.className = 'conn-status offline'; }
    return false;
  }
}

/* ============================================================
   SELETOR DE ANO
   ============================================================ */
function popularAno(){
  const sel = document.getElementById('ano-select');
  sel.innerHTML = AVAILABLE_YEARS.map(y =>
    `<option value="${y}" ${y===currentYear?'selected':''}>${y}</option>`
  ).join('');

  ['ano-label', 'ano-label-log', 'ano-label-concl', 'ano-label-solic'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = currentYear;
  });

  sel.addEventListener('change', async () => {
    currentYear = Number(sel.value);
    ['ano-label', 'ano-label-log', 'ano-label-concl', 'ano-label-solic'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = currentYear;
    });
    dbMatriculas = [];
    dbAlocacoes = [];
    dbLog = [];
    dbTurmas = [];
    dbSolicitacoes = [];
    renderTurmasComAlunos();
    renderTurmasConcluidas();
    renderMinhasSolicitacoes();
    renderLog();
    await loadTurmas();
    await loadMatriculas();
    await loadLog();
    await loadMinhasSolicitacoes();
  });
}

/* ============================================================
   CARREGAMENTO DE DADOS
   ============================================================ */
async function loadTurmas(){
  if (!sb) return;
  try {
    const { data, error } = await sb.from('eap_turmas')
      .select('id, numero, categoria, data_inicio, data_fim, concluida')
      .eq('ano', currentYear);
    if (error) throw error;
    dbTurmas = data || [];
  } catch(e){
    console.warn('[turmas] falha:', e);
    dbTurmas = [];
  }
}

async function loadMatriculas(){
  if (!sb) return;
  try {
    const { data: mats, error: errM } = await sb.from('eap_matriculas')
      .select('*').eq('ano', currentYear).order('created_at', { ascending:false });
    if (errM) throw errM;
    dbMatriculas = mats || [];

    const { data: alocs, error: errA } = await sb.from('eap_alocacoes')
      .select('re,ano,turma_id,categoria,taf,taf_iv_tipo,updated_at')
      .eq('ano', currentYear);
    if (errA) console.warn('[alocacoes] falha:', errA);
    dbAlocacoes = alocs || [];

    const reMats  = dbMatriculas.map(m => String(m.re));
    const reAlocs = dbAlocacoes.map(a => String(a.re));
    const res = Array.from(new Set([...reMats, ...reAlocs]));

    dbPoliciais = {};
    if (res.length){
      const { data: pols, error: errP } = await sb.from('policiais')
        .select('re,dg,posto_grad,nome,cia_secao').in('re', res);
      if (errP) throw errP;
      (pols || []).forEach(p => { dbPoliciais[String(p.re)] = p; });
    }
    renderTurmasComAlunos();
    renderTurmasConcluidas();
  } catch(err){
    console.error(err);
    toast('Falha ao carregar matrículas: ' + (err.message || err), 'error');
  }
}

async function loadLog(){
  if (!sb) return;
  try {
    const { data, error } = await sb.from('vw_eap_matriculas_log_auditoria')
      .select('*').eq('ano', currentYear)
      .order('created_at', { ascending:false }).limit(500);
    if (error) throw error;
    dbLog = data || [];
    renderLog();
  } catch(e){
    console.warn('[log] falha:', e);
    dbLog = [];
    renderLog();
  }
}

async function loadMinhasSolicitacoes(){
  if (!sb || !currentUser) {
    dbSolicitacoes = [];
    renderMinhasSolicitacoes();
    return;
  }
  try {
    const { data, error } = await sb.from('eap_solicitacoes')
      .select('*')
      .eq('ano', currentYear)
      .eq('solicitado_por', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    dbSolicitacoes = data || [];
    renderMinhasSolicitacoes();
  } catch(e){
    console.warn('[solicitacoes] falha:', e);
    dbSolicitacoes = [];
    renderMinhasSolicitacoes();
  }
}

async function atualizarTudo(){
  const btn = document.getElementById('btn-atualizar');
  if (btn) btn.classList.add('spinning');
  try {
    await loadTurmas();
    await loadMatriculas();
    await loadLog();
    await loadMinhasSolicitacoes();
    toast('Dados atualizados do servidor.', 'success');
  } catch(e){
    toast('Falha ao atualizar: ' + (e.message||e), 'error');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

/* ============================================================
   BUSCA POR RE
   ============================================================ */
let __buscaReqId = 0;

async function buscarPorRE(re){
  const reqId = ++__buscaReqId;

  currentOfficer = null;
  const alertEl = document.getElementById('alert-preview');
  alertEl.className = 'alert';
  alertEl.textContent = '';
  document.getElementById('preview').innerHTML = '';
  document.getElementById('btn-matricular').disabled = true;

  if (!/^\d{6}$/.test(re)){
    if (re.length > 0){
      alertEl.textContent = 'O RE deve ter exatamente 6 dígitos numéricos.';
      alertEl.className = 'alert alert-warn show';
    }
    return;
  }
  if (!sb){
    alertEl.textContent = 'Supabase não configurado.';
    alertEl.className = 'alert alert-error show';
    return;
  }

  try {
    const { data, error } = await sb.from('policiais')
      .select('re,dg,posto_grad,nome,cia_secao,data_nascimento,ias_odonto,ias_medico,validade_ias')
      .eq('re', re).maybeSingle();
    if (error) throw error;
    if (!data){
      alertEl.textContent = `Nenhum policial encontrado com o RE ${re}.`;
      alertEl.className = 'alert alert-error show';
      return;
    }

    const encontrado = {
      re: data.re, dg: data.dg, postoGrad: data.posto_grad, nome: data.nome,
      ciaSecao: data.cia_secao, dataNascimento: data.data_nascimento,
      dataExameOdonto: data.ias_odonto, dataExameMedico: data.ias_medico,
      validadeIAS: data.validade_ias
    };

    if (!policialMatchesUserCia(encontrado)){
      alertEl.innerHTML = `Este policial pertence à <strong>${escapeHTML(getCiaSecao(encontrado) || 'outra Cia/Seção')}</strong>.<br>
        Você só pode matricular policiais da <strong>${escapeHTML(currentUserCia?.label || 'sua Cia/Seção')}</strong>.`;
      alertEl.className = 'alert alert-error show';
      currentOfficer = null;
      return;
    }

    currentOfficer = encontrado;
    renderPreview();
  } catch(err){
    console.error(err);
    alertEl.textContent = 'Falha ao buscar: ' + (err.message || err);
    alertEl.className = 'alert alert-error show';
  }
}

/* ============================================================
   PRÉ-VISUALIZAÇÃO
   ============================================================ */
function renderPreview(){
  const box = document.getElementById('preview');
  const alertEl = document.getElementById('alert-preview');
  const btn = document.getElementById('btn-matricular');
  if (!currentOfficer){ box.innerHTML = ''; btn.disabled = true; return; }

  const matriculaExistente = dbMatriculas.find(m =>
    String(m.re) === String(currentOfficer.re) &&
    m.ano === currentYear &&
    m.status === 'confirmada'
  );

  const alocExistente = dbAlocacoes.find(a =>
    String(a.re) === String(currentOfficer.re) && a.turma_id
  );
  const turmaAloc = alocExistente
    ? dbTurmas.find(t => String(t.id) === String(alocExistente.turma_id))
    : null;

  box.innerHTML = `
    <div class="preview">
      <div class="preview-grid">
        <div class="preview-item"><div class="lbl">Posto/Grad</div><div class="val">${escapeHTML(currentOfficer.postoGrad||'—')}</div></div>
        <div class="preview-item"><div class="lbl">RE</div><div class="val">${escapeHTML(currentOfficer.re)}${currentOfficer.dg ? '-' + escapeHTML(currentOfficer.dg) : ''}</div></div>
        <div class="preview-item"><div class="lbl">Nome</div><div class="val">${escapeHTML(currentOfficer.nome||'—')}</div></div>
        <div class="preview-item"><div class="lbl">Cia/Seção</div><div class="val">${escapeHTML(currentOfficer.ciaSecao||'—')}</div></div>
        <div class="preview-item"><div class="lbl">Nascimento</div><div class="val">${currentOfficer.dataNascimento ? fmtDate(currentOfficer.dataNascimento) : '—'}</div></div>
        <div class="preview-item"><div class="lbl">Validade IAS</div><div class="val">${currentOfficer.validadeIAS ? fmtDate(currentOfficer.validadeIAS) : '—'}</div></div>
      </div>
      <div class="field" style="margin-top:14px;width:100%">
        <label for="turma-select">Turma Desejada <span style="color:var(--red)">*</span></label>
        <select id="turma-select"></select>
      </div>
    </div>`;

  const { aviso, bloqueado } = renderTurmaOptions(matriculaExistente);

  if (matriculaExistente){
    if (matriculaExistente.aprovacao === 'reprovada'){
      alertEl.innerHTML = `Este policial tem uma matrícula <strong>reprovada</strong> registrada. Entre em contato com o gestor.`;
    } else if (matriculaExistente.aprovacao === 'aprovada'){
      alertEl.innerHTML = `Este policial <strong>já está matriculado e APROVADO</strong> (Turma ${escapeHTML(matriculaExistente.turma_numero || '—')}).`;
    } else {
      alertEl.innerHTML = `Este policial <strong>já está matriculado</strong>, aguardando aprovação (Turma ${escapeHTML(matriculaExistente.turma_numero || '—')}).`;
    }
    alertEl.className = 'alert alert-warn show';
    btn.disabled = true;
  } else if (alocExistente && turmaAloc){
    alertEl.innerHTML = `Este policial <strong>já está alocado na Turma ${escapeHTML(turmaAloc.numero)}</strong> pelo gestor no EAP 3º B.C. Para mudar de turma, use os botões na seção "Turmas Criadas".`;
    alertEl.className = 'alert alert-warn show';
    btn.disabled = true;
  } else if (bloqueado){
    alertEl.textContent = aviso;
    alertEl.className = 'alert alert-error show';
    btn.disabled = true;
  } else if (aviso){
    alertEl.textContent = aviso;
    alertEl.className = 'alert alert-warn show';
    btn.disabled = false;
  } else {
    alertEl.innerHTML = 'Confirme os dados, escolha a <strong>Turma</strong> e clique em <strong>Confirmar Matrícula</strong>.';
    alertEl.className = 'alert alert-info show';
    btn.disabled = false;
  }
}

function renderTurmaOptions(jaMatriculado = null){
  const sel = document.getElementById('turma-select');
  if (!sel) return { aviso: '', bloqueado: true };

  if (!currentOfficer){
    sel.innerHTML = '<option value="">— Busque um policial primeiro —</option>';
    sel.disabled = true;
    return { aviso: '', bloqueado: true };
  }

  const categoria = inferirCategoria(currentOfficer.postoGrad);
  let turmas = dbTurmas.filter(t => t.categoria === categoria && !t.concluida);
  let aviso = '';
  let bloqueado = false;

  if (turmas.length === 0){
    const todas = dbTurmas.filter(t => !t.concluida);
    if (todas.length === 0){
      sel.innerHTML = '<option value="">— Nenhuma turma aberta —</option>';
      sel.disabled = true;
      return {
        aviso: `Nenhuma turma aberta cadastrada no ano ${currentYear}.`,
        bloqueado: true
      };
    }
    turmas = todas;
    aviso = `Nenhuma turma de ${CAT_LABELS[categoria] || categoria} disponível. Mostrando todas as turmas abertas.`;
  }

  turmas = turmas.slice().sort((a,b) => romanToInt(a.numero) - romanToInt(b.numero));

  const opts = ['<option value="">— Selecione a turma —</option>'];
  turmas.forEach(t => {
    const dataTxt = t.data_inicio ? ' — ' + fmtDate(t.data_inicio) : '';
    const selected = jaMatriculado && String(jaMatriculado.turma_id) === String(t.id) ? 'selected' : '';
    opts.push(`<option value="${t.id}" data-numero="${escapeHTML(t.numero)}" ${selected}>Turma ${escapeHTML(t.numero)}${dataTxt}</option>`);
  });
  sel.innerHTML = opts.join('');
  sel.disabled = !!jaMatriculado || bloqueado;

  return { aviso, bloqueado };
}

/* ============================================================
   MATRICULAR
   ============================================================ */
async function matricular(){
  if (!currentOfficer){
    const reDigitado = document.getElementById('re-input').value.trim();
    if (/^\d{6}$/.test(reDigitado)){
      await registrarTentativa(reDigitado, currentYear, 'tentativa_re_inexistente',
        { motivo: 'Clique em Confirmar sem localizar policial' });
    }
    toast('Busque um policial primeiro.', 'error');
    return;
  }
  if (!sb){ toast('Supabase não configurado.', 'error'); return; }
  if (!currentUser){ toast('Faça login primeiro.', 'error'); return; }

  if (!policialMatchesUserCia(currentOfficer)){
    toast(`Policial não pertence à ${currentUserCia?.label || 'sua Cia/Seção'}.`, 'error');
    return;
  }

  const turmaSel = document.getElementById('turma-select');
  const turmaId = turmaSel ? turmaSel.value : '';
  if (!turmaId){
    toast('Selecione a turma desejada antes de confirmar.', 'error');
    if (turmaSel) turmaSel.focus();
    return;
  }
  const turmaNumero = (turmaSel.selectedOptions[0] && turmaSel.selectedOptions[0].dataset.numero) || '';

  const obs = document.getElementById('obs-input').value.trim();
  const btn = document.getElementById('btn-matricular');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  try {
    const { error } = await sb.from('eap_matriculas').insert({
      re: String(currentOfficer.re),
      ano: currentYear,
      status: 'confirmada',
      observacao: obs,
      matriculado_por: currentUser.id,
      turma_id: turmaId,
      turma_numero: turmaNumero,
      aprovacao: 'pendente'
    });

    if (error){
      if (error.code === '23505'){
        await registrarTentativa(currentOfficer.re, currentYear, 'tentativa_duplicada',
          { nome: currentOfficer.nome || '', observacao: obs, turma_numero: turmaNumero });
        toast('Este policial já está matriculado neste ano.', 'error');
        await loadMatriculas();
        await loadLog();
        return;
      }
      throw error;
    }

    toast(`Matrícula de ${currentOfficer.nome} (Turma ${turmaNumero}) enviada para análise!`, 'success');
    document.getElementById('re-input').value = '';
    document.getElementById('obs-input').value = '';
    currentOfficer = null;
    document.getElementById('preview').innerHTML = '';
    document.getElementById('alert-preview').className = 'alert';
    await loadMatriculas();
    await loadLog();
  } catch(err){
    console.error(err);
    toast('Falha ao matricular: ' + (err.message || err), 'error');
  } finally {
    btn.textContent = 'Confirmar Matrícula';
    if (currentOfficer) btn.disabled = false;
  }
}

/* ============================================================
   TURMAS — RENDERIZAÇÃO
   ============================================================ */
function renderTurmasForCategory(container, onlyConcluded){
  if (!container) return;

  const catFiltro = state.catFiltro || 'cb_sd';
  const turmasCat = dbTurmas.filter(t => t.categoria === catFiltro && !!t.concluida === !!onlyConcluded);

  if (!turmasCat.length){
    const titulo = onlyConcluded
      ? `Nenhuma turma de ${escapeHTML(CAT_LABELS[catFiltro] || catFiltro)} CONCLUÍDA no ano ${currentYear}.`
      : `Nenhuma turma de ${escapeHTML(CAT_LABELS[catFiltro] || catFiltro)} em andamento no ano ${currentYear}.`;
    const sub = onlyConcluded
      ? 'As turmas são marcadas como concluídas pelo gestor no app EAP 3º B.C.'
      : 'A criação de turmas é feita pelo gestor no app EAP 3º B.C.';
    container.innerHTML = `
      <div class="empty">
        <strong>${titulo}</strong><br>
        <small style="color:var(--g500)">${sub}</small>
      </div>`;
    return;
  }

  const q = (state.search || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const matchQ = (reVal, p, turmaNumero) => {
    if (!q) return true;
    return [reVal, p?.nome, p?.cia_secao, p?.posto_grad, turmaNumero].map(v =>
      String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    ).join(' ').includes(q);
  };

  const porTurma = new Map();
  const addAluno = (turmaId, reVal, policial, matricula, alocacao) => {
    const k = String(turmaId);
    if (!porTurma.has(k)) porTurma.set(k, new Map());
    porTurma.get(k).set(String(reVal), { re: String(reVal), policial, matricula, alocacao });
  };

  const matriculasPorRE = new Map();
  dbMatriculas
    .filter(m => m.status === 'confirmada' && m.aprovacao !== 'reprovada')
    .forEach(m => matriculasPorRE.set(String(m.re), m));

  dbAlocacoes.forEach(a => {
    if (!a.turma_id) return;
    const reVal = String(a.re);
    const p = dbPoliciais[reVal];
    if (currentUserCia && (!p || !policialMatchesUserCia(p))) return;
    const turma = dbTurmas.find(t => String(t.id) === String(a.turma_id));
    if (!turma) return;
    if (turma.categoria !== catFiltro) return;
    if (!!turma.concluida !== !!onlyConcluded) return;
    if (q && !matchQ(reVal, p, turma.numero)) return;
    addAluno(a.turma_id, reVal, p || {}, matriculasPorRE.get(reVal) || null, a);
  });

  dbMatriculas
    .filter(m => m.status === 'confirmada' && m.aprovacao !== 'reprovada' && m.turma_id)
    .forEach(m => {
      const reVal = String(m.re);
      if (porTurma.get(String(m.turma_id))?.has(reVal)) return;
      const p = dbPoliciais[reVal];
      if (currentUserCia && (!p || !policialMatchesUserCia(p))) return;
      const turma = dbTurmas.find(t => String(t.id) === String(m.turma_id));
      if (!turma) return;
      if (turma.categoria !== catFiltro) return;
      if (!!turma.concluida !== !!onlyConcluded) return;
      if (q && !matchQ(reVal, p, turma.numero)) return;
      addAluno(m.turma_id, reVal, p || {}, m, null);
    });

  const turmasOrdenadas = turmasCat.slice().sort((a,b) => romanToInt(a.numero) - romanToInt(b.numero));

  const turmasFiltradas = q
    ? turmasOrdenadas.filter(t => {
        const m = porTurma.get(String(t.id));
        return m && m.size > 0;
      })
    : turmasOrdenadas;

  if (turmasFiltradas.length === 0){
    container.innerHTML = `<div class="empty">Nenhum resultado encontrado para "${escapeHTML(state.search)}".</div>`;
    return;
  }

  let totalAlunos = 0;
  const html = turmasFiltradas.map(t => {
    const mapAlunos = porTurma.get(String(t.id)) || new Map();
    const alunos = Array.from(mapAlunos.values())
      .sort((a,b) => {
        const da = a.matricula?.created_at || a.alocacao?.updated_at || '';
        const db_ = b.matricula?.created_at || b.alocacao?.updated_at || '';
        return da.localeCompare(db_);
      });
    totalAlunos += alunos.length;

    const rows = alunos.length === 0
      ? `<tr><td colspan="7" class="empty-turma">${currentUserCia
          ? `Nenhum policial da ${escapeHTML(currentUserCia.label)} nesta turma.`
          : 'Turma sem alunos.'}</td></tr>`
      : alunos.map(a => {
          const p = a.policial || {};
          let apr;
          if (a.matricula){
            apr = APROVACAO_LABEL[a.matricula.aprovacao || 'pendente'] || APROVACAO_LABEL.pendente;
          } else {
            apr = APROVACAO_LABEL.alocado;
          }
          const dataRef = a.matricula?.created_at || a.alocacao?.updated_at || '';

          const actionsCell = t.concluida
            ? `<td style="text-align:right"><span class="cell-muted">—</span></td>`
            : `<td style="text-align:right">
                 <button class="btn btn-outline btn-sm" data-transf-re="${escapeHTML(a.re)}" title="Solicitar transferência (aprovação do gestor)">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                     <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/>
                     <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
                   </svg>
                   Solicitar Transferência
                 </button>
                 <button class="btn btn-outline btn-sm btn-excluir" data-excluir-re="${escapeHTML(a.re)}" title="Solicitar exclusão (aprovação do gestor)">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                     <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"/>
                   </svg>
                   Solicitar Exclusão
                 </button>
               </td>`;

          return `
            <tr>
              <td class="cell-re">${escapeHTML(a.re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}</td>
              <td>${escapeHTML(p.posto_grad||'—')}</td>
              <td>${escapeHTML(p.nome||'—')}</td>
              <td>${escapeHTML(p.cia_secao||'—')}</td>
              <td><span class="pill ${apr.cls}">${apr.txt}</span></td>
              <td class="cell-muted">${dataRef ? fmtDate(dataRef) : '—'}</td>
              ${actionsCell}
            </tr>`;
        }).join('');

    const catLabel = CAT_LABELS[t.categoria] || t.categoria;
    const dataTxt = t.data_inicio ? `${fmtDate(t.data_inicio)} a ${fmtDate(t.data_fim)}` : '—';
    const concluidaBadge = t.concluida ? '<span class="tag-concluida">✓ CONCLUÍDA</span>' : '';
    const concluidaClass = t.concluida ? ' concluida' : '';

    return `
      <div class="turma-visual${concluidaClass}">
        <div class="turma-visual-head">
          <div class="turma-visual-num">${escapeHTML(t.numero)}</div>
          <div class="turma-visual-info">
            <div class="turma-visual-title">
              Turma ${escapeHTML(t.numero)} — ${escapeHTML(catLabel)} ${concluidaBadge}
            </div>
            <div class="turma-visual-dates">${dataTxt}</div>
          </div>
          <div class="turma-visual-count">${alunos.length} ${alunos.length === 1 ? 'policial' : 'policiais'}</div>
        </div>
        <div class="turma-visual-body">
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr>
                  <th>RE</th><th>Posto/Grad</th><th>Nome</th><th>Cia/Seção</th>
                  <th>Status</th><th>Data</th>
                  <th style="text-align:right">Ações</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }).join('');

  const escopoCia = currentUserCia ? ` (${currentUserCia.label})` : '';
  const statusTxt = onlyConcluded ? 'concluída(s)' : 'em andamento';
  container.innerHTML = `
    <div class="resumo-turmas">
      <strong>${turmasFiltradas.length}</strong> turma(s) de <strong>${escapeHTML(CAT_LABELS[catFiltro])}</strong> ${statusTxt}${escopoCia} •
      <strong>${totalAlunos}</strong> policial(is) matriculado(s)
    </div>
    ${html}
  `;

  if (!onlyConcluded){
    container.querySelectorAll('[data-transf-re]').forEach(btn => {
      btn.addEventListener('click', () => abrirModalTransferir(btn.dataset.transfRe));
    });
    container.querySelectorAll('[data-excluir-re]').forEach(btn => {
      btn.addEventListener('click', () => solicitarExclusao(btn.dataset.excluirRe));
    });
  }
}

function renderTurmasComAlunos(){
  const container = document.getElementById('turmas-list');
  renderTurmasForCategory(container, false);
}

function renderTurmasConcluidas(){
  const container = document.getElementById('turmas-concluidas-list');
  renderTurmasForCategory(container, true);
}

/* ============================================================
   SOLICITAR TRANSFERÊNCIA
   ============================================================ */
function abrirModalTransferir(reInput){
  const re = String(reInput);
  const p = dbPoliciais[re] || {};

  if (!policialMatchesUserCia(p)){
    toast('Este policial não pertence à sua Cia/Seção.', 'error');
    return;
  }

  const jaPendente = dbSolicitacoes.find(s =>
    String(s.re) === re && s.status === 'pendente' && s.tipo === 'transferencia'
  );
  if (jaPendente){
    toast('Já existe uma solicitação de transferência pendente para este RE.', 'error');
    return;
  }

  const aloc = dbAlocacoes.find(a => String(a.re) === re && a.turma_id);
  const mat  = dbMatriculas.find(m => String(m.re) === re && m.status === 'confirmada' && m.aprovacao !== 'reprovada');
  const turmaAtualId = aloc?.turma_id || mat?.turma_id || null;
  const turmaAtual = dbTurmas.find(t => String(t.id) === String(turmaAtualId));
  const categoria = turmaAtual?.categoria || inferirCategoria(p.posto_grad);

  const turmasDisponiveis = dbTurmas
    .filter(t =>
      t.categoria === categoria &&
      !t.concluida &&
      String(t.id) !== String(turmaAtualId)
    )
    .sort((a,b) => romanToInt(a.numero) - romanToInt(b.numero));

  if (turmasDisponiveis.length === 0){
    toast(`Não há outras turmas abertas de ${CAT_LABELS[categoria]||categoria} para transferir.`, 'error');
    return;
  }

  const turmaOpts = turmasDisponiveis.map(t =>
    `<option value="${t.id}" data-numero="${escapeHTML(t.numero)}">
       Turma ${escapeHTML(t.numero)}${t.data_inicio ? ' — ' + fmtDate(t.data_inicio) : ''}
     </option>`
  ).join('');

  const alvo = document.getElementById('modal-root') || document.body;
  alvo.innerHTML = `
    <div class="modal-overlay">
      <div class="modal sm" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>Solicitar Transferência</h2>
          <button class="modal-close" data-close title="Fechar">✕</button>
        </div>
        <div class="modal-body">
          <div class="alert alert-info show" style="margin-top:0">
            A transferência <strong>só será efetivada após aprovação do gestor</strong>.
            Você pode acompanhar o status em <strong>"Minhas Solicitações"</strong>.
          </div>
          <div class="preview" style="margin:14px 0">
            <div class="preview-grid">
              <div class="preview-item"><div class="lbl">RE</div><div class="val">${escapeHTML(re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}</div></div>
              <div class="preview-item"><div class="lbl">Policial</div><div class="val">${escapeHTML(p.nome||'—')}</div></div>
              <div class="preview-item"><div class="lbl">Cia/Seção</div><div class="val">${escapeHTML(p.cia_secao||'—')}</div></div>
              <div class="preview-item"><div class="lbl">Turma Atual</div><div class="val">${turmaAtual ? 'Turma ' + escapeHTML(turmaAtual.numero) : '—'}</div></div>
            </div>
          </div>
          <div class="field">
            <label for="transf-destino">Turma de Destino <span style="color:var(--red)">*</span></label>
            <select id="transf-destino">${turmaOpts}</select>
          </div>
          <div class="field" style="margin-top:12px">
            <label for="transf-motivo">Motivo da Transferência (opcional)</label>
            <input type="text" id="transf-motivo" placeholder="Ex.: conflito de escala, solicitação do policial">
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" data-close>Cancelar</button>
          <button class="btn btn-gold" id="btn-confirmar-solic-transf">Enviar Solicitação</button>
        </div>
      </div>
    </div>`;

  const close = () => { alvo.innerHTML = ''; };
  alvo.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  alvo.querySelector('.modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('btn-confirmar-solic-transf').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const sel = document.getElementById('transf-destino');
    const novaTurmaId = sel.value;
    const novaTurmaNumero = sel.selectedOptions[0].dataset.numero || '';
    const motivo = document.getElementById('transf-motivo').value.trim();

    if (!novaTurmaId){ toast('Selecione a turma de destino.', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      await criarSolicitacao({
        re,
        tipo: 'transferencia',
        turmaAtualId,
        turmaAtualNumero: turmaAtual?.numero || null,
        turmaNovaId: novaTurmaId,
        turmaNovaNumero: novaTurmaNumero,
        motivo
      });
      toast('Solicitação de transferência enviada. Aguarde aprovação do gestor.', 'success');
      close();
      await loadMinhasSolicitacoes();
      await loadLog();
    } catch (err){
      console.error(err);
      toast('Falha ao enviar: ' + (err.message || err), 'error');
      btn.disabled = false;
      btn.textContent = 'Enviar Solicitação';
    }
  });
}

/* ============================================================
   SOLICITAR EXCLUSÃO
   ============================================================ */
async function solicitarExclusao(reInput){
  if (!sb) { toast('Supabase não configurado.', 'error'); return; }
  const re = String(reInput);
  const p = dbPoliciais[re] || {};

  if (!policialMatchesUserCia(p)){
    toast('Este policial não pertence à sua Cia/Seção.', 'error');
    return;
  }

  const jaPendente = dbSolicitacoes.find(s =>
    String(s.re) === re && s.status === 'pendente' && s.tipo === 'exclusao'
  );
  if (jaPendente){
    toast('Já existe uma solicitação de exclusão pendente para este RE.', 'error');
    return;
  }

  const aloc = dbAlocacoes.find(a => String(a.re) === re && a.turma_id);
  const mat  = dbMatriculas.find(m => String(m.re) === re && m.status === 'confirmada' && m.aprovacao !== 'reprovada');
  const turmaId = aloc?.turma_id || mat?.turma_id || null;
  const turmaAtual = dbTurmas.find(t => String(t.id) === String(turmaId));

  const alvo = document.getElementById('modal-root') || document.body;
  alvo.innerHTML = `
    <div class="modal-overlay">
      <div class="modal sm" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>Solicitar Exclusão</h2>
          <button class="modal-close" data-close title="Fechar">✕</button>
        </div>
        <div class="modal-body">
          <div class="alert alert-warn show" style="margin-top:0">
            A exclusão <strong>só será efetivada após aprovação do gestor</strong>.
          </div>
          <div class="preview" style="margin:14px 0">
            <div class="preview-grid">
              <div class="preview-item"><div class="lbl">RE</div><div class="val">${escapeHTML(re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}</div></div>
              <div class="preview-item"><div class="lbl">Policial</div><div class="val">${escapeHTML(p.nome||'—')}</div></div>
              <div class="preview-item"><div class="lbl">Turma Atual</div><div class="val">${turmaAtual ? 'Turma ' + escapeHTML(turmaAtual.numero) : '—'}</div></div>
            </div>
          </div>
          <div class="field">
            <label for="excl-motivo">Motivo da Exclusão <span style="color:var(--red)">*</span></label>
            <input type="text" id="excl-motivo" placeholder="Ex.: transferência de unidade, desistência" required>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" data-close>Cancelar</button>
          <button class="btn btn-gold" id="btn-confirmar-solic-excl">Enviar Solicitação</button>
        </div>
      </div>
    </div>`;

  const close = () => { alvo.innerHTML = ''; };
  alvo.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  alvo.querySelector('.modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('btn-confirmar-solic-excl').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const motivo = document.getElementById('excl-motivo').value.trim();
    if (!motivo){ toast('Informe o motivo da exclusão.', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      await criarSolicitacao({
        re,
        tipo: 'exclusao',
        turmaAtualId: turmaId,
        turmaAtualNumero: turmaAtual?.numero || null,
        turmaNovaId: null,
        turmaNovaNumero: null,
        motivo
      });
      toast('Solicitação de exclusão enviada. Aguarde aprovação do gestor.', 'success');
      close();
      await loadMinhasSolicitacoes();
      await loadLog();
    } catch (err){
      console.error(err);
      toast('Falha ao enviar: ' + (err.message || err), 'error');
      btn.disabled = false;
      btn.textContent = 'Enviar Solicitação';
    }
  });
}

/* ============================================================
   HELPER: criar solicitação + registrar no log
   ============================================================ */
async function criarSolicitacao({
  re, tipo, turmaAtualId, turmaAtualNumero,
  turmaNovaId, turmaNovaNumero, motivo
}){
  if (!currentUser) throw new Error('Faça login primeiro.');

  const { data, error } = await sb.from('eap_solicitacoes').insert({
    ano: currentYear,
    re: String(re),
    tipo,
    turma_atual_id: turmaAtualId || null,
    turma_atual_numero: turmaAtualNumero || null,
    turma_nova_id: turmaNovaId || null,
    turma_nova_numero: turmaNovaNumero || null,
    motivo: motivo || null,
    status: 'pendente',
    solicitado_por: currentUser.id,
    solicitado_por_email: currentUser.email,
    solicitado_por_cia: currentUserCia?.label || null
  }).select().single();

  if (error) throw error;

  try {
    await sb.rpc('eap_registrar_tentativa', {
      p_re: String(re),
      p_ano: currentYear,
      p_acao: tipo === 'transferencia' ? 'solicitacao_transferencia' : 'solicitacao_exclusao',
      p_detalhes: {
        solicitacao_id: data.id,
        tipo,
        turma_atual: turmaAtualNumero || null,
        turma_nova: turmaNovaNumero || null,
        turma_numero: turmaNovaNumero || turmaAtualNumero || null,
        motivo: motivo || null
      }
    });
  } catch(logErr){
    console.warn('[criarSolicitacao] falha ao registrar log:', logErr);
  }

  return data;
}

/* ============================================================
   MINHAS SOLICITAÇÕES — render (linhas clicáveis + botão "Ver")
   ============================================================ */
function renderMinhasSolicitacoes(){
  const tbody = document.getElementById('tbody-solicitacoes');
  if (!tbody) return;

  const pendentes = dbSolicitacoes.filter(s => s.status === 'pendente');
  const badge = document.getElementById('badge-solicitacoes');
  if (badge){
    if (pendentes.length > 0){
      badge.style.display = 'inline-flex';
      badge.textContent = pendentes.length;
    } else {
      badge.style.display = 'none';
    }
  }

  const lista = state.mostrarHistoricoSolic ? dbSolicitacoes : pendentes;

  const btnHist = document.getElementById('btn-toggle-historico-solic');
  if (btnHist){
    btnHist.textContent = state.mostrarHistoricoSolic ? 'Ver só pendentes' : 'Ver histórico';
  }

  if (!lista.length){
    tbody.innerHTML = state.mostrarHistoricoSolic
      ? '<tr><td colspan="9" class="empty">Nenhuma solicitação registrada neste ano.</td></tr>'
      : '<tr><td colspan="9" class="empty">Nenhuma solicitação pendente. Use "Ver histórico" para ver as já processadas.</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(s => {
    const p = dbPoliciais[String(s.re)] || {};
    const st = SOLIC_LABEL[s.status] || SOLIC_LABEL.pendente;
    const tipo = s.tipo === 'transferencia'
      ? '<span class="sol-tipo transf">Transferência</span>'
      : '<span class="sol-tipo excl">Exclusão</span>';

    const statusCell = s.status === 'reprovada' && s.motivo_decisao
      ? `<span class="pill ${st.cls}">${st.txt}</span>
         <span class="sol-motivo-decisao">${escapeHTML(s.motivo_decisao)}</span>`
      : `<span class="pill ${st.cls}">${st.txt}</span>`;

    return `
      <tr data-sol-id="${s.id}" style="cursor:pointer" title="Clique para ver detalhes">
        <td>${tipo}</td>
        <td class="cell-re">${escapeHTML(s.re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}</td>
        <td>${escapeHTML(p.nome || '—')}</td>
        <td>${s.turma_atual_numero ? 'Turma ' + escapeHTML(s.turma_atual_numero) : '<span class="cell-muted">—</span>'}</td>
        <td>${s.turma_nova_numero ? 'Turma ' + escapeHTML(s.turma_nova_numero) : '<span class="cell-muted">—</span>'}</td>
        <td class="cell-muted">${escapeHTML(s.motivo || '—')}</td>
        <td>${statusCell}</td>
        <td class="cell-muted">${fmtDateTime(s.created_at)}</td>
        <td style="text-align:right">
          <button class="btn btn-outline" style="padding:6px 10px;font-size:11px" data-sol-view="${s.id}" title="Ver detalhes">
            Detalhes
          </button>
        </td>
      </tr>`;
  }).join('');

  // Clique na linha inteira
  tbody.querySelectorAll('tr[data-sol-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      // Ignora clique no botão (que também tem handler próprio)
      if (e.target.closest('[data-sol-view]')) return;
      mostrarDetalhesSolicitacao(tr.dataset.solId);
    });
  });

  // Clique no botão "Detalhes"
  tbody.querySelectorAll('[data-sol-view]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      mostrarDetalhesSolicitacao(btn.dataset.solView);
    });
  });
}

/* ============================================================
   MODAL "DETALHES DA SOLICITAÇÃO" — matriculaeap
   ============================================================ */
function mostrarDetalhesSolicitacao(id){
  const s = dbSolicitacoes.find(x => String(x.id) === String(id));
  if (!s) return;

  const p = dbPoliciais[String(s.re)] || {};
  const st = SOLIC_LABEL[s.status] || SOLIC_LABEL.pendente;
  const isTransf = s.tipo === 'transferencia';
  const tipoClass = isTransf ? 'transf' : 'excl';
  const tipoLabel = isTransf ? 'Transferência' : 'Exclusão';

  const initials = (p.nome || '?')
    .split(' ').filter(Boolean).slice(0, 2)
    .map(n => n[0]).join('').toUpperCase();

  // ---- Trajeto ----
  let routeHTML = '';
  if (isTransf && s.turma_nova_numero) {
    routeHTML = `
      <div class="sol-detail-route">
        <div class="sol-detail-turma from">
          <small>Turma Atual</small>
          <strong>${escapeHTML(s.turma_atual_numero || '—')}</strong>
        </div>
        <div class="sol-detail-arrow">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="5" y1="12" x2="19" y2="12"/>
            <polyline points="12 5 19 12 12 19"/>
          </svg>
        </div>
        <div class="sol-detail-turma to">
          <small>Turma Destino</small>
          <strong>${escapeHTML(s.turma_nova_numero)}</strong>
        </div>
      </div>`;
  } else if (!isTransf) {
    routeHTML = `
      <div class="sol-detail-route">
        <div class="sol-detail-turma from">
          <small>Turma Atual</small>
          <strong>${escapeHTML(s.turma_atual_numero || '—')}</strong>
        </div>
        <div class="sol-detail-arrow">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="5" y1="12" x2="19" y2="12"/>
            <polyline points="12 5 19 12 12 19"/>
          </svg>
        </div>
        <div class="sol-detail-turma" style="border-color:#dc2626;background:linear-gradient(180deg,#fef2f2,#fee2e2)">
          <small>Destino</small>
          <strong style="color:#b91c1c;font-size:16px">EXCLUSÃO</strong>
        </div>
      </div>`;
  } else {
    routeHTML = `<div class="sol-detail-text empty">Turma de destino não informada.</div>`;
  }

  // ---- Decisão ----
  let decisionHTML = '';
  if (s.status === 'aprovada' || s.status === 'reprovada') {
    const decClass = s.status === 'aprovada' ? 'aprovada' : '';
    const decLabel = s.status === 'aprovada' ? 'Solicitação Aprovada' : 'Solicitação Reprovada';
    const decIcon = s.status === 'aprovada'
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    const decDate = s.decidido_em ? new Date(s.decidido_em).toLocaleString('pt-BR') : '—';

    decisionHTML = `
      <div class="sol-detail-section">
        <div class="sol-detail-label">Decisão do Gestor</div>
        <div class="sol-detail-decision ${decClass}">
          <div class="sol-detail-decision-head">
            ${decIcon}
            ${decLabel}
          </div>
          <div class="sol-detail-decision-body">
            <div style="margin-bottom:6px"><strong>Em:</strong> ${decDate}</div>
            <div style="margin-bottom:6px"><strong>Por:</strong> ${escapeHTML(s.decidido_por_email || '—')}</div>
            ${s.motivo_decisao ? `<div><strong>Motivo:</strong> ${escapeHTML(s.motivo_decisao)}</div>` : ''}
          </div>
        </div>
      </div>`;
  }

  // ---- Timeline ----
  const envioDate = s.created_at ? new Date(s.created_at).toLocaleString('pt-BR') : '—';
  const timelineHTML = `
    <div class="sol-detail-section">
      <div class="sol-detail-label">Histórico</div>
      <div class="sol-detail-timeline">
        <div class="sol-detail-timeline-item done">
          <div class="sol-detail-timeline-time">${envioDate}</div>
          <div class="sol-detail-timeline-text">Solicitação enviada por você</div>
        </div>
        <div class="sol-detail-timeline-item ${
          s.status === 'aprovada' ? 'done'
          : s.status === 'reprovada' ? 'rejected'
          : 'current'
        }">
          <div class="sol-detail-timeline-time">${
            s.decidido_em ? new Date(s.decidido_em).toLocaleString('pt-BR')
            : 'Aguardando decisão'
          }</div>
          <div class="sol-detail-timeline-text">${
            s.status === 'aprovada' ? 'Aprovada pelo gestor'
            : s.status === 'reprovada' ? 'Reprovada pelo gestor'
            : s.status === 'cancelada' ? 'Cancelada'
            : 'Pendente de análise'
          }</div>
        </div>
      </div>
    </div>`;

  const alvo = document.getElementById('modal-root') || document.body;
  alvo.innerHTML = `
    <div class="modal-overlay">
      <div class="modal sm sol-detail-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>Detalhes da Solicitação</h2>
          <button class="modal-close" data-close title="Fechar">✕</button>
        </div>
        <div class="modal-body">

          <div class="sol-detail-hero">
            <div class="sol-detail-tags">
              <span class="sol-detail-tag ${tipoClass}">${tipoLabel}</span>
              <span class="sol-detail-tag status-${s.status}">${st.txt}</span>
            </div>
            <div class="sol-detail-police">
              <div class="sol-detail-avatar">${escapeHTML(initials || '?')}</div>
              <div class="sol-detail-police-info">
                <div class="sol-detail-police-name">${escapeHTML(p.nome || '—')}</div>
                <div class="sol-detail-police-meta">
                  <span>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="4" width="18" height="16" rx="2"/>
                      <line x1="7" y1="9" x2="17" y2="9"/>
                    </svg>
                    RE ${escapeHTML(s.re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}
                  </span>
                  ${p.posto_grad ? `<span>${escapeHTML(p.posto_grad)}</span>` : ''}
                  ${p.cia_secao ? `<span>${escapeHTML(p.cia_secao)}</span>` : ''}
                </div>
              </div>
            </div>
          </div>

          <div class="sol-detail-section">
            <div class="sol-detail-label">Trajeto da Solicitação</div>
            ${routeHTML}
          </div>

          <div class="sol-detail-section">
            <div class="sol-detail-label">Motivo Informado</div>
            <div class="sol-detail-text ${s.motivo ? '' : 'empty'}">${escapeHTML(s.motivo || 'Nenhum motivo informado.')}</div>
          </div>

          ${decisionHTML}
          ${timelineHTML}

        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" data-close>Fechar</button>
        </div>
      </div>
    </div>`;

  const close = () => { alvo.innerHTML = ''; };
  alvo.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  alvo.querySelector('.modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) close();
  });
}

/* ============================================================
   LOG
   ============================================================ */
async function registrarTentativa(re, ano, acao, detalhes = {}){
  if (!sb) return;
  try {
    const { error } = await sb.rpc('eap_registrar_tentativa', {
      p_re: String(re || ''),
      p_ano: ano,
      p_acao: acao,
      p_detalhes: detalhes
    });
    if (error) console.warn('[log] falha:', error);
  } catch(e){ console.warn('[log] erro:', e); }
}

function renderLog(){
  const tbody = document.getElementById('tbody-log');
  if (!tbody) return;

  const q = (state.search || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const filtrados = dbLog
    .filter(logEntryMatchesUserCia)
    .filter(l => {
      if (!q) return true;
      const turma = (l.detalhes && l.detalhes.turma_numero) || '';
      return [l.re, l.policial_nome, l.policial_cia, l.feito_por_email, l.acao, turma]
        .map(v => String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase())
        .join(' ').includes(q);
    });

  if (!filtrados.length){
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Sem registros de auditoria.</td></tr>';
    return;
  }

  tbody.innerHTML = filtrados.map(l => {
    const meta = ACAO_LABEL[l.acao] || { txt: l.acao, cls: 'pill-blue' };
    const dt = l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '—';
    const quem = l.feito_por_email || '—';
    const turma = (l.detalhes && l.detalhes.turma_numero) || '';
    const alvo = l.re
      ? `${escapeHTML(l.re)}${l.policial_nome ? ' — ' + escapeHTML(l.policial_nome) : ''}${turma ? ` <span class="pill pill-blue" style="font-size:10px">T ${escapeHTML(turma)}</span>` : ''}`
      : '—';
    return `
      <tr>
        <td class="cell-muted">${dt}</td>
        <td><span class="pill ${meta.cls}">${meta.txt}</span></td>
        <td>${alvo}</td>
        <td class="cell-muted">${escapeHTML(quem)}</td>
        <td class="cell-muted">${l.status_anterior || '—'} → ${l.status_novo || '—'}</td>
        <td style="text-align:right">
          <button class="btn btn-outline" style="padding:6px 12px;font-size:12px"
                  data-detalhes="${escapeHTML(JSON.stringify(l.detalhes||{}))}">Ver</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-detalhes]').forEach(b => {
    b.addEventListener('click', () => {
      try { alert(JSON.stringify(JSON.parse(b.dataset.detalhes), null, 2)); }
      catch(_){ alert(b.dataset.detalhes); }
    });
  });
}

/* ============================================================
   EXPORTAÇÕES
   ============================================================ */
function exportarXLSX(){
  const rows = [['RE','Dg','Posto/Grad','Nome','Cia/Seção','Turma','Categoria','Status','Data','Observação']];

  const matriculasPorRE = new Map();
  dbMatriculas.filter(m => m.status === 'confirmada' && m.aprovacao !== 'reprovada')
    .forEach(m => matriculasPorRE.set(String(m.re), m));

  const vistos = new Set();
  const pushRow = (reVal, turmaId, mat) => {
    if (vistos.has(reVal)) return;
    const p = dbPoliciais[reVal] || {};
    if (currentUserCia && !policialMatchesUserCia(p)) return;
    vistos.add(reVal);

    const turma = dbTurmas.find(t => String(t.id) === String(turmaId));
    if (!turma) return;
    const aprTxt = mat
      ? ((APROVACAO_LABEL[mat.aprovacao || 'pendente'] || APROVACAO_LABEL.pendente).txt)
      : 'Alocado';
    const dataRef = mat?.created_at || dbAlocacoes.find(a => String(a.re) === reVal)?.updated_at || '';
    rows.push([
      reVal, p.dg || '', p.posto_grad || '', p.nome || '', p.cia_secao || '',
      turma.numero || '', CAT_LABELS[turma.categoria] || turma.categoria, aprTxt,
      dataRef ? fmtDate(dataRef) : '', mat?.observacao || ''
    ]);
  };

  dbAlocacoes.forEach(a => {
    if (!a.turma_id) return;
    pushRow(String(a.re), a.turma_id, matriculasPorRE.get(String(a.re)) || null);
  });
  dbMatriculas
    .filter(m => m.status === 'confirmada' && m.aprovacao !== 'reprovada' && m.turma_id)
    .forEach(m => pushRow(String(m.re), m.turma_id, m));

  if (rows.length === 1){ toast('Nenhuma matrícula para exportar.', 'error'); return; }
  downloadXLSX([{ name: `Matriculas ${currentYear}`, rows }],
    `EAP${currentYear}_Matriculas_${todayStamp()}.xlsx`);
  toast(`${rows.length - 1} matrícula(s) exportada(s).`, 'success');
}

function exportarLogXLSX(){
  const rows = [['Data/Hora','Ação','RE','Policial','Turma','Usuário','Status Anterior','Status Novo','Detalhes']];
  dbLog
    .filter(logEntryMatchesUserCia)
    .forEach(l => {
      const det = l.detalhes || {};
      rows.push([
        l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '',
        (ACAO_LABEL[l.acao] || {}).txt || l.acao,
        l.re || '', l.policial_nome || '', det.turma_numero || '',
        l.feito_por_email || '',
        l.status_anterior || '', l.status_novo || '',
        JSON.stringify(det)
      ]);
    });
  if (rows.length === 1){ toast('Nenhum log para exportar.', 'error'); return; }
  downloadXLSX([{ name: `Log Auditoria ${currentYear}`, rows }],
    `EAP${currentYear}_LogAuditoria_${todayStamp()}.xlsx`);
  toast(`${rows.length - 1} registro(s) exportado(s).`, 'success');
}

/* ============================================================
   LOGIN / BOOT
   ============================================================ */
async function entrarNoApp(user){
  currentUser = user;
  currentUserCia = getUserCiaRestriction(user?.email);
  atualizarCiaBadge();

  document.body.classList.add('autenticado');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('user-email').textContent = user.email || '—';

  await checarConexao();
  await loadTurmas();
  await loadMatriculas();
  await loadLog();
  await loadMinhasSolicitacoes();
}

function mostrarLogin(){
  currentUser = null;
  currentUserCia = null;
  dbSolicitacoes = [];
  atualizarCiaBadge();
  document.body.classList.remove('autenticado');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('user-email').textContent = '—';
}

function traduzirErro(msg){
  const m = String(msg||'').toLowerCase();
  if (m.includes('invalid login')) return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed')) return 'E-mail ainda não confirmado.';
  if (m.includes('too many')) return 'Muitas tentativas. Aguarde alguns minutos.';
  return 'Erro: ' + msg;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('re-input').addEventListener('input', e => {
    const v = e.target.value.replace(/\D/g,'').slice(0,6);
    e.target.value = v;
    clearTimeout(window.__reTimeout);
    window.__reTimeout = setTimeout(() => buscarPorRE(v), 350);
  });

  document.getElementById('btn-buscar').addEventListener('click', () => {
    buscarPorRE(document.getElementById('re-input').value.trim());
  });

  document.getElementById('btn-matricular').addEventListener('click', matricular);
  document.getElementById('btn-export').addEventListener('click', exportarXLSX);

  const btnExportLog = document.getElementById('btn-export-log');
  if (btnExportLog) btnExportLog.addEventListener('click', exportarLogXLSX);

  const btnAtualizar = document.getElementById('btn-atualizar');
  if (btnAtualizar) btnAtualizar.addEventListener('click', atualizarTudo);

  document.querySelectorAll('.cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const cat = tab.dataset.cat;
      if (!cat) return;
      state.catFiltro = cat;
      document.querySelectorAll('.cat-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.cat === cat);
      });
      renderTurmasComAlunos();
      renderTurmasConcluidas();
    });
  });

 let __searchDebounce;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(__searchDebounce);
  __searchDebounce = setTimeout(() => {
    state.search = e.target.value;
    renderTurmasComAlunos();
    renderTurmasConcluidas();
    renderLog();
  }, 200);
});

  const btnHistSolic = document.getElementById('btn-toggle-historico-solic');
  if (btnHistSolic){
    btnHistSolic.addEventListener('click', () => {
      state.mostrarHistoricoSolic = !state.mostrarHistoricoSolic;
      renderMinhasSolicitacoes();
    });
  }

  popularAno();

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const senha = document.getElementById('login-password').value;
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-error');
    err.className = 'login-error';
    err.textContent = '';
    if (!sb){
      err.textContent = 'Supabase não configurado.';
      err.className = 'login-error show';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Entrando...';
    try {
      const { data, error } = await sb.auth.signInWithPassword({
        email: email.trim().toLowerCase(), password: senha
      });
      if (error) throw error;
      document.getElementById('login-password').value = '';
      await entrarNoApp(data.user);
    } catch(ex){
      console.error('[LOGIN ERRO CRU]', ex);
      err.textContent = traduzirErro(ex.message);
      err.className = 'login-error show';
      document.getElementById('login-password').value = '';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (!confirm('Deseja sair?')) return;
    try { await sb.auth.signOut(); } catch(e){ console.warn(e); }
    mostrarLogin();
  });

  (async () => {
    if (!sb){ mostrarLogin(); return; }
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session && data.session.user){
        await entrarNoApp(data.session.user);
        return;
      }
    } catch(e){ console.warn(e); }
    mostrarLogin();
  })();

  let refreshEmAndamento = false;
  async function refreshSilencioso(){
    if (!currentUser || !sb || refreshEmAndamento) return;
    refreshEmAndamento = true;
    try {
      await loadMinhasSolicitacoes();
      await loadLog();
    } catch(e){
      console.warn('[auto-refresh] falha:', e);
    } finally {
      refreshEmAndamento = false;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshSilencioso();
  });

  window.addEventListener('focus', refreshSilencioso);

  setInterval(() => {
    if (document.visibilityState === 'visible') refreshSilencioso();
  }, 60000);
});