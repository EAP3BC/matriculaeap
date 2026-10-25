/* ============================================================
   MATRICULA.JS — App de Matrícula (com Devolvidas)
   Lê policiais e eap_turmas. Grava só em eap_matriculas.
   ============================================================ */

let currentYear = 2027;
let currentUser = null;
let dbMatriculas = [];
let dbPoliciais = {};
let dbTurmas = [];
let dbLog = [];
let currentOfficer = null;
const state = { search: '' };

const AVAILABLE_YEARS = [2027, 2028, 2029, 2030];

const CAT_LABELS = {
  cb_sd: 'Cb/Sd',
  subten_sgt: 'Subten/Sgt',
  oficiais: 'Oficiais'
};

const ACAO_LABEL = {
  criada:                   { txt: 'Matrícula criada',   cls: 'pill-green' },
  cancelada:                { txt: 'Cancelada',          cls: 'pill-amber' },
  reativada:                { txt: 'Reativada',          cls: 'pill-green' },
  atualizada:               { txt: 'Atualizada',         cls: 'pill-blue'  },
  excluida:                 { txt: 'Excluída',           cls: 'pill-red'   },
  tentativa_duplicada:      { txt: 'Tentativa duplicada',cls: 'pill-red'   },
  tentativa_re_inexistente: { txt: 'RE não encontrado',  cls: 'pill-amber' },
  aprovada:                 { txt: 'Aprovada',           cls: 'pill-green' },
  reprovada:                { txt: 'Devolvida',          cls: 'pill-red'   },
  reenviada:                { txt: 'Reenviada',          cls: 'pill-blue'  }
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

/* ---------- Conexão ---------- */
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

/* ---------- Seletor de ano ---------- */
function popularAno(){
  const sel = document.getElementById('ano-select');
  sel.innerHTML = AVAILABLE_YEARS.map(y =>
    `<option value="${y}" ${y===currentYear?'selected':''}>${y}</option>`
  ).join('');
  sel.addEventListener('change', () => {
    currentYear = Number(sel.value);
    ['ano-label', 'ano-label-log', 'ano-label-dev'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = currentYear;
    });
    dbMatriculas = [];
    dbLog = [];
    dbTurmas = [];
    renderTabela();
    renderDevolvidas();
    renderLog();
    loadTurmas();
    loadMatriculas();
    loadLog();
  });
  ['ano-label', 'ano-label-log', 'ano-label-dev'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = currentYear;
  });
}

/* ---------- Turmas ---------- */
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

/* ---------- Busca por RE ---------- */
async function buscarPorRE(re){
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
    currentOfficer = {
      re: data.re, dg: data.dg, postoGrad: data.posto_grad, nome: data.nome,
      ciaSecao: data.cia_secao, dataNascimento: data.data_nascimento,
      dataExameOdonto: data.ias_odonto, dataExameMedico: data.ias_medico,
      validadeIAS: data.validade_ias
    };
    renderPreview();
  } catch(err){
    console.error(err);
    alertEl.textContent = 'Falha ao buscar: ' + (err.message || err);
    alertEl.className = 'alert alert-error show';
  }
}

/* ---------- Pré-visualização ---------- */
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
      alertEl.innerHTML = `Este policial tem uma matrícula <strong>DEVOLVIDA</strong> para reenvio. Use a seção <strong>"Matrículas Devolvidas"</strong> abaixo para editar e reenviar.`;
    } else if (matriculaExistente.aprovacao === 'aprovada'){
      alertEl.innerHTML = `Este policial <strong>já está matriculado e APROVADO</strong> (Turma ${escapeHTML(matriculaExistente.turma_numero || '—')}).`;
    } else {
      alertEl.innerHTML = `Este policial <strong>já está matriculado</strong>, aguardando aprovação (Turma ${escapeHTML(matriculaExistente.turma_numero || '—')}).`;
    }
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

/* ---------- Matricular ---------- */
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

/* ---------- Listagem de matrículas ---------- */
async function loadMatriculas(){
  if (!sb) return;
  try {
    const { data: mats, error: errM } = await sb.from('eap_matriculas')
      .select('*').eq('ano', currentYear).order('created_at', { ascending:false });
    if (errM) throw errM;
    dbMatriculas = mats || [];

    const res = Array.from(new Set(dbMatriculas.map(m => String(m.re))));
    dbPoliciais = {};
    if (res.length){
      const { data: pols, error: errP } = await sb.from('policiais')
        .select('re,dg,posto_grad,nome,cia_secao').in('re', res);
      if (errP) throw errP;
      (pols || []).forEach(p => { dbPoliciais[String(p.re)] = p; });
    }
    renderTabela();
    renderDevolvidas();
  } catch(err){
    console.error(err);
    toast('Falha ao carregar matrículas: ' + (err.message || err), 'error');
  }
}

function renderTabela(){
  const tbody = document.getElementById('tbody-matriculas');
  if (!tbody) return;
  const q = (state.search || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const filtradas = dbMatriculas.filter(m => {
    if (m.status !== 'confirmada') return false;
    if (m.aprovacao === 'reprovada') return false; // vai para Devolvidas
    if (!q) return true;
    const p = dbPoliciais[String(m.re)] || {};
    return [m.re, p.nome, p.cia_secao, p.posto_grad, m.turma_numero].map(v =>
      String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    ).join(' ').includes(q);
  });

  if (!filtradas.length){
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma matrícula encontrada.</td></tr>';
    return;
  }

  const APR_PILL = {
    pendente:  { txt: 'Pendente',  cls: 'pill-amber' },
    aprovada:  { txt: 'Aprovada',  cls: 'pill-green' }
  };

  tbody.innerHTML = filtradas.map(m => {
    const p = dbPoliciais[String(m.re)] || {};
    const apr = APR_PILL[m.aprovacao] || APR_PILL.pendente;
    return `
      <tr>
        <td class="cell-re">${escapeHTML(m.re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}</td>
        <td>${escapeHTML(p.posto_grad||'—')}</td>
        <td>${escapeHTML(p.nome||'—')}</td>
        <td>${escapeHTML(p.cia_secao||'—')}</td>
        <td>${m.turma_numero ? `<span class="pill pill-blue">Turma ${escapeHTML(m.turma_numero)}</span>` : '<span class="cell-muted">—</span>'}</td>
        <td><span class="pill ${apr.cls}">${apr.txt}</span></td>
        <td class="cell-muted">${fmtDate(m.created_at)}</td>
      </tr>`;
  }).join('');
}

function renderDevolvidas(){
  const tbody = document.getElementById('tbody-devolvidas');
  if (!tbody) return;

  const q = (state.search || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const devolvidas = dbMatriculas.filter(m => {
    if (m.status !== 'confirmada') return false;
    if (m.aprovacao !== 'reprovada') return false;
    if (!q) return true;
    const p = dbPoliciais[String(m.re)] || {};
    return [m.re, p.nome, p.cia_secao, p.posto_grad, m.turma_numero, m.motivo_reprovacao].map(v =>
      String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    ).join(' ').includes(q);
  });

  const badge = document.getElementById('badge-devolvidas');
  if (badge){
    if (devolvidas.length > 0){
      badge.style.display = 'inline-flex';
      badge.textContent = devolvidas.length;
    } else {
      badge.style.display = 'none';
    }
  }

  if (devolvidas.length === 0){
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Nenhuma matrícula devolvida.</td></tr>';
    return;
  }

  tbody.innerHTML = devolvidas.map(m => {
    const p = dbPoliciais[String(m.re)] || {};
    const dtApr = m.aprovado_em ? new Date(m.aprovado_em).toLocaleString('pt-BR') : '—';
    return `
      <tr>
        <td class="cell-re">${escapeHTML(m.re)}${p.dg ? '-' + escapeHTML(p.dg) : ''}</td>
        <td>${escapeHTML(p.posto_grad||'—')}</td>
        <td class="cell-nome">${escapeHTML(p.nome||'—')}</td>
        <td>${escapeHTML(p.cia_secao||'—')}</td>
        <td>${m.turma_numero ? `<span class="pill pill-blue">Turma ${escapeHTML(m.turma_numero)}</span>` : '<span class="cell-muted">—</span>'}</td>
        <td><span class="motivo-reprovacao" title="${escapeHTML(m.motivo_reprovacao||'')}">${escapeHTML(m.motivo_reprovacao||'—')}</span></td>
        <td class="cell-muted">${dtApr}</td>
        <td style="text-align:right">
          <button class="btn btn-outline" data-reenviar="${m.id}" style="padding:6px 12px;font-size:12px">Reenviar</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-reenviar]').forEach(btn => {
    btn.addEventListener('click', () => abrirModalReenviar(btn.dataset.reenviar));
  });
}

async function cancelarMatricula(id){
  if (!confirm('Deseja cancelar esta matrícula? O policial poderá se matricular novamente depois.')) return;
  try {
    const { error } = await sb.from('eap_matriculas')
      .update({ status: 'cancelada' }).eq('id', id);
    if (error) throw error;
    toast('Matrícula cancelada.', 'info');
    await loadMatriculas();
    await loadLog();
  } catch(err){
    toast('Falha ao cancelar: ' + (err.message || err), 'error');
  }
}

/* ---------- Reenviar matrícula devolvida ---------- */
function abrirModalReenviar(id){
  const m = dbMatriculas.find(x => String(x.id) === String(id));
  if (!m) return;
  const p = dbPoliciais[String(m.re)] || {};
  const categoria = inferirCategoria(p.posto_grad);

  const turmas = dbTurmas.filter(t => t.categoria === categoria && !t.concluida)
    .sort((a,b) => romanToInt(a.numero) - romanToInt(b.numero));

  const turmaOpts = turmas.length === 0
    ? '<option value="">— Nenhuma turma aberta —</option>'
    : turmas.map(t =>
        `<option value="${t.id}" data-numero="${escapeHTML(t.numero)}" ${String(t.id)===String(m.turma_id)?'selected':''}>Turma ${escapeHTML(t.numero)}${t.data_inicio ? ' — ' + fmtDate(t.data_inicio) : ''}</option>`
      ).join('');

  const alvo = document.getElementById('modal-root') || document.body;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal sm" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>Reenviar Matrícula — RE ${escapeHTML(m.re)}</h2>
        <button class="modal-close" data-close title="Fechar">✕</button>
      </div>
      <div class="modal-body">
        <div class="alert alert-warn show" style="margin-top:0">
          <strong>Motivo da devolução:</strong><br>
          ${escapeHTML(m.motivo_reprovacao || '(não informado)')}
        </div>

        <div class="preview" style="margin:14px 0">
          <div class="preview-grid">
            <div class="preview-item"><div class="lbl">Posto/Grad</div><div class="val">${escapeHTML(p.posto_grad||'—')}</div></div>
            <div class="preview-item"><div class="lbl">Nome</div><div class="val">${escapeHTML(p.nome||'—')}</div></div>
            <div class="preview-item"><div class="lbl">Cia/Seção</div><div class="val">${escapeHTML(p.cia_secao||'—')}</div></div>
          </div>
        </div>

        <div class="field" style="margin-top:14px">
          <label for="reenviar-turma">Turma Desejada <span style="color:var(--red)">*</span></label>
          <select id="reenviar-turma">${turmaOpts}</select>
        </div>
        <div class="field" style="margin-top:14px">
          <label for="reenviar-obs">Observação (opcional)</label>
          <input type="text" id="reenviar-obs" value="${escapeHTML(m.observacao||'')}" placeholder="Ex.: Corrigido conforme solicitado">
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" data-close>Cancelar</button>
        <button class="btn btn-gold" id="btn-confirmar-reenvio">Reenviar Matrícula</button>
      </div>
    </div>`;

  alvo.innerHTML = '';
  alvo.appendChild(overlay);

  const close = () => { alvo.innerHTML = ''; };
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('btn-confirmar-reenvio').addEventListener('click', async () => {
    const sel = document.getElementById('reenviar-turma');
    const novaTurmaId = sel.value;
    if (!novaTurmaId){ toast('Selecione uma turma.', 'error'); return; }
    const novaTurmaNumero = sel.selectedOptions[0].dataset.numero || '';
    const novaObs = document.getElementById('reenviar-obs').value.trim();

    const btn = document.getElementById('btn-confirmar-reenvio');
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      const { error } = await sb.from('eap_matriculas').update({
        turma_id: novaTurmaId,
        turma_numero: novaTurmaNumero,
        observacao: novaObs,
        aprovacao: 'pendente',
        aprovado_por: null,
        aprovado_em: null,
        motivo_reprovacao: ''
      }).eq('id', m.id);
      if (error) throw error;

      toast('Matrícula reenviada para análise!', 'success');
      close();
      await loadMatriculas();
      await loadLog();
    } catch(e){
      toast('Falha ao reenviar: ' + (e.message||e), 'error');
      btn.disabled = false;
      btn.textContent = 'Reenviar Matrícula';
    }
  });
}

/* ---------- Exportações ---------- */
function exportarXLSX(){
  const rows = [['RE','Dg','Posto/Grad','Nome','Cia/Seção','Turma','Aprovação','Data Matrícula','Observação']];
  dbMatriculas.filter(m => m.status === 'confirmada').forEach(m => {
    const p = dbPoliciais[String(m.re)] || {};
    const apr = m.aprovacao === 'aprovada' ? 'Aprovada'
              : m.aprovacao === 'reprovada' ? 'Devolvida'
              : 'Pendente';
    rows.push([
      m.re, p.dg || '', p.posto_grad || '', p.nome || '', p.cia_secao || '',
      m.turma_numero || '', apr, fmtDate(m.created_at), m.observacao || ''
    ]);
  });
  if (rows.length === 1){ toast('Nenhuma matrícula para exportar.', 'error'); return; }
  downloadXLSX([{ name: `Matriculas ${currentYear}`, rows }],
    `EAP${currentYear}_Matriculas_${todayStamp()}.xlsx`);
  toast(`${rows.length - 1} matrícula(s) exportada(s).`, 'success');
}

function exportarLogXLSX(){
  const rows = [['Data/Hora','Ação','RE','Policial','Turma','Usuário','Status Anterior','Status Novo','Detalhes']];
  dbLog.forEach(l => {
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

/* ---------- LOG DE AUDITORIA ---------- */
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

function renderLog(){
  const tbody = document.getElementById('tbody-log');
  if (!tbody) return;

  const q = (state.search || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const filtrados = dbLog.filter(l => {
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

/* ---------- Login / Boot ---------- */
async function entrarNoApp(user){
  currentUser = user;
  document.body.classList.add('autenticado');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('user-email').textContent = user.email || '—';
  await checarConexao();
  await loadTurmas();
  await loadMatriculas();
  await loadLog();
}

function mostrarLogin(){
  currentUser = null;
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

/* ---------- Bootstrap ---------- */
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

  document.getElementById('search').addEventListener('input', e => {
    state.search = e.target.value;
    renderTabela();
    renderDevolvidas();
    renderLog();
  });

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
});