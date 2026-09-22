const CONTENT_TYPE_LABELS = { live: "Live", short: "Short", video: "Vídeo normal" };
const PAPEIS = { narrador: "Narrador", comentarista: "Comentarista", reporter: "Repórter", apresentador: "Apresentador" };

const el = (id) => document.getElementById(id);
const escapeAttr = (s) => (s || "").replace(/"/g, "&quot;");

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

el("dateFrom").value = daysAgo(30);
el("dateTo").value = today();

function selectedContentTypes() {
  return Array.from(document.querySelectorAll('.tipos-video-checkboxes input[type="checkbox"][value]'))
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

function formatDuration(totalSeconds) {
  const safe = Math.max(0, totalSeconds || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
}

function papelOptionsHtml(selected) {
  const visiveis = papeisCache.filter((p) => !p.arquivado || p.nome === selected);
  return visiveis
    .map((p) => `<option value="${escapeAttr(p.nome)}"${p.nome === selected ? " selected" : ""}>${PAPEIS[p.nome] || p.nome}${p.arquivado ? " (arquivado)" : ""}</option>`)
    .join("");
}

function tipoConteudoOptionsHtml(selected) {
  const visiveis = tiposConteudoCache.filter((t) => !t.arquivado || t.nome === selected);
  return '<option value="">(não classificado)</option>' +
    visiveis
      .map((t) => `<option value="${escapeAttr(t.nome)}"${t.nome === selected ? " selected" : ""}>${t.nome}${t.arquivado ? " (arquivado)" : ""}</option>`)
      .join("");
}

// ---------- progresso / log / interrupção ----------

const progressBar = el("progressBar");
const progressFill = progressBar.querySelector(".progress-fill");
const progressText = el("progressText");
const logArea = el("logArea");
const btnParar = el("btnPararExecucao");

let execucaoCancelada = false;

function resetExecucao() {
  progressBar.classList.add("active");
  progressFill.style.width = "0%";
  progressText.textContent = "";
  logArea.classList.add("active");
  logArea.textContent = "";
  execucaoCancelada = false;
  btnParar.classList.add("active");
}

function encerrarExecucao() {
  btnParar.classList.remove("active");
}

btnParar.addEventListener("click", () => {
  execucaoCancelada = true;
  log("Pedido de interrupção recebido — parando após o lote atual...");
});

// Chame no início de cada iteração de lote nos loops de mapeamento,
// transcrição e sugestão da IA. Retorna true se a execução deve parar.
function foiInterrompido() {
  return execucaoCancelada;
}

function setProgress(index, total, label) {
  const fraction = total ? index / total : 1;
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  progressText.textContent = `${label}: ${index}/${total}`;
}

function log(message) {
  const time = new Date().toLocaleTimeString("pt-BR");
  logArea.textContent += `[${time}] ${message}\n`;
  logArea.scrollTop = logArea.scrollHeight;
}

function statusMsg(message, kind) {
  progressText.innerHTML = `<span class="status-msg ${kind}">${message}</span>`;
}

// ---------- tabs ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    el(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

document.querySelectorAll(".subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".subtab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    el(`subtab-${btn.dataset.subtab}`).classList.add("active");
  });
});

// ---------- mapeamento ----------

el("btnMapear").addEventListener("click", async () => {
  const handle = el("channelHandle").value.trim();
  const dateFrom = el("dateFrom").value;
  const dateTo = el("dateTo").value;
  const contentTypes = selectedContentTypes();

  if (!handle || !dateFrom || !dateTo || contentTypes.length === 0) {
    alert("Preencha canal, período e pelo menos um tipo de vídeo.");
    return;
  }

  el("btnMapear").disabled = true;
  resetExecucao();

  try {
    log(`Buscando canal @${handle}...`);
    const channelRes = await fetch(`/api/channel?handle=${encodeURIComponent(handle)}`).then((r) => r.json());
    if (channelRes.error) throw new Error(channelRes.error);
    log(`Canal encontrado: ${channelRes.channelId}`);

    log(`Listando vídeos publicados entre ${dateFrom} e ${dateTo}...`);
    const allIds = [];
    let pageToken;
    let interrompidoNaBusca = false;
    do {
      if (foiInterrompido()) { interrompidoNaBusca = true; break; }

      const params = new URLSearchParams({
        channelId: channelRes.channelId,
        publishedAfter: `${dateFrom}T00:00:00Z`,
        publishedBefore: `${dateTo}T23:59:59Z`,
      });
      if (pageToken) params.set("pageToken", pageToken);

      const page = await fetch(`/api/search?${params}`).then((r) => r.json());
      if (page.error) throw new Error(page.error);

      allIds.push(...page.videoIds);
      pageToken = page.nextPageToken;
      log(`  ${allIds.length} vídeo(s) encontrados até agora...`);
    } while (pageToken);

    log(`${allIds.length} vídeo(s) encontrado(s) no período (todos os tipos).`);

    let saved = 0;
    let interrompido = interrompidoNaBusca;
    for (let i = 0; i < allIds.length; i += 50) {
      if (foiInterrompido()) { interrompido = true; break; }

      const batch = allIds.slice(i, i + 50);
      setProgress(i, allIds.length, "Mapeamento");

      const res = await fetch("/api/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: batch, channelHandle: handle, contentTypes }),
      }).then((r) => r.json());

      if (res.error) throw new Error(res.error);

      for (const item of res.saved) {
        saved++;
        log(`[${saved}] (${CONTENT_TYPE_LABELS[item.tipo_video] || item.tipo_video}) ${item.titulo}`);
        if (item.chat_error) log(`  aviso na contagem do chat: ${item.chat_error}`);
      }
    }

    setProgress(saved, allIds.length, "Mapeamento");
    if (interrompido) {
      statusMsg(`Mapeamento interrompido: ${saved} vídeo(s) salvos antes de parar.`, "error");
    } else {
      statusMsg(`Mapeamento concluído: ${saved} vídeo(s). Vídeos já existentes só tiveram views/comentários/chat atualizados.`, "success");
    }
    await carregarVideos();
  } catch (error) {
    statusMsg(`Erro durante o mapeamento: ${error.message}`, "error");
  } finally {
    el("btnMapear").disabled = false;
    encerrarExecucao();
  }
});

// ---------- transcrição ----------

el("btnTranscrever").addEventListener("click", async () => {
  const dateFrom = el("dateFrom").value;
  const dateTo = el("dateTo").value;
  const contentTypes = selectedContentTypes();
  const reprocessar = el("reprocessar").checked;

  el("btnTranscrever").disabled = true;
  resetExecucao();

  try {
    let videoIds;

    if (reprocessar) {
      const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, tipos: contentTypes.join(",") });
      const videosRes = await fetch(`/api/videos?${params}`).then((r) => r.json());
      videoIds = videosRes.videos.map((v) => v.video_id);
    } else {
      const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, tipos: contentTypes.join(",") });
      const pendingRes = await fetch(`/api/transcripts/pending?${params}`).then((r) => r.json());
      videoIds = pendingRes.videoIds;
    }

    if (!videoIds.length) {
      statusMsg("Nenhum vídeo pendente de transcrição nesse período/tipo.", "success");
      return;
    }

    log(`${videoIds.length} vídeo(s) para buscar transcrição.`);
    let processed = 0;
    let interrompido = false;

    for (let i = 0; i < videoIds.length; i += 5) {
      if (foiInterrompido()) { interrompido = true; break; }

      const batch = videoIds.slice(i, i + 5);
      setProgress(processed, videoIds.length, "Transcrição");

      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: batch }),
      }).then((r) => r.json());

      if (res.error) throw new Error(res.error);

      for (const item of res.results) {
        processed++;
        log(`[${processed}/${videoIds.length}] ${item.titulo}: ${item.sucesso ? "sucesso" : `falhou (${item.erro})`}`);
      }
    }

    setProgress(processed, videoIds.length, "Transcrição");
    if (interrompido) {
      statusMsg(`Transcrição interrompida: ${processed} de ${videoIds.length} vídeo(s) processados antes de parar.`, "error");
    } else {
      statusMsg(`Transcrição concluída: ${processed} vídeo(s) processados.`, "success");
    }
    await carregarVideos();
  } catch (error) {
    statusMsg(`Erro durante a transcrição: ${error.message}`, "error");
  } finally {
    el("btnTranscrever").disabled = false;
    encerrarExecucao();
  }
});

// ---------- sugerir classificação (tipo de conteúdo/competição/programa/elenco) via IA ----------

let sugestoesParticipantesPorVideo = {};

el("btnSugerirIA").addEventListener("click", async () => {
  const dateFrom = el("dateFrom").value;
  const dateTo = el("dateTo").value;
  const contentTypes = selectedContentTypes();

  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, tipos: contentTypes.join(",") });
  const videosRes = await fetch(`/api/videos?${params}`).then((r) => r.json());
  const videoIds = (videosRes.videos || []).filter((v) => !v.tipo_conteudo).map((v) => v.video_id);

  if (!videoIds.length) {
    statusMsg("Nenhum vídeo sem classificação nesse período/tipo.", "success");
    return;
  }

  el("btnSugerirIA").disabled = true;
  resetExecucao();

  try {
    log(`${videoIds.length} vídeo(s) sem classificação. Pedindo sugestão à IA...`);
    let processed = 0;
    let interrompido = false;

    for (let i = 0; i < videoIds.length; i += 5) {
      if (foiInterrompido()) { interrompido = true; break; }

      const batch = videoIds.slice(i, i + 5);
      setProgress(processed, videoIds.length, "Sugestão IA");

      const res = await fetch("/api/ai/sugerir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: batch }),
      }).then((r) => r.json());

      if (res.error) throw new Error(res.error);

      for (const item of res.results) {
        processed++;

        if (item.participantes_sugeridos?.length) {
          sugestoesParticipantesPorVideo[item.video_id] = item.participantes_sugeridos;
        }

        const partes = [];
        if (item.tipo_conteudo_sugerido) partes.push(item.tipo_conteudo_sugerido);
        if (item.competicao_sugerida) partes.push(`competição: ${item.competicao_sugerida}`);
        if (item.programa_sugerido) partes.push(`programa: ${item.programa_sugerido}`);
        if (item.participantes_sugeridos?.length) partes.push(`elenco: ${item.participantes_sugeridos.map((p) => p.nome).join(", ")}`);

        const resultado = partes.length
          ? `${partes.join(" | ")} (confiança ${Math.round((item.confianca || 0) * 100)}%)`
          : `sem sugestão${item.erro ? ` (${item.erro})` : ""}`;
        log(`[${processed}/${videoIds.length}] ${item.titulo}: ${resultado}`);
      }
    }

    setProgress(processed, videoIds.length, "Sugestão IA");
    if (interrompido) {
      statusMsg(`Sugestão interrompida: ${processed} de ${videoIds.length} vídeo(s) processados antes de parar.`, "error");
    } else {
      statusMsg(`Sugestões geradas para ${processed} vídeo(s). Revise na aba Vídeos.`, "success");
    }
    await carregarVideos();
  } catch (error) {
    statusMsg(`Erro ao pedir sugestões à IA: ${error.message}`, "error");
  } finally {
    el("btnSugerirIA").disabled = false;
    encerrarExecucao();
  }
});

// ---------- carregar dados ----------

let videosCache = [];
let pessoasCache = [];
let competicoesCache = [];
let tiposConteudoCache = [];
let papeisCache = [];
let modoTeste = false;

async function carregarVideos() {
  const dateFrom = el("dateFrom").value;
  const dateTo = el("dateTo").value;
  const contentTypes = selectedContentTypes();

  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, tipos: contentTypes.join(",") });
  const res = await fetch(`/api/videos?${params}`).then((r) => r.json());
  videosCache = res.videos || [];
  modoTeste = false;
  atualizarBadgeModoTeste();

  el("downloadCsv").href = `/api/export.csv?${params}`;
  renderVideosTable();
  renderDashboards();
  renderPessoasStats();
  renderAprovacaoIA();
}

// ---------- dados de teste (mocados, só no navegador — nunca salvos) ----------
// Gera vídeos fictícios combinando o elenco, papéis, competições e tipos de
// conteúdo já cadastrados de verdade, pra poder explorar a tela de Vídeos e
// os Dashboards sem depender de mapear vídeos reais.

function atualizarBadgeModoTeste() {
  el("modoDadosBadge").textContent = modoTeste ? "Modo: dados de teste (mocados)" : "Modo: dados reais";
  el("btnUsarDadosTeste").style.display = modoTeste ? "none" : "";
  el("btnVoltarDadosReais").style.display = modoTeste ? "" : "none";
}

function gerarVideosMock(quantidade = 40) {
  const pessoas = pessoasCache.map((p) => p.nome);
  const papeisAtivos = papeisCache.filter((p) => !p.arquivado).map((p) => p.nome);

  if (!pessoas.length || !papeisAtivos.length) {
    alert("Cadastre pelo menos uma pessoa (aba Elenco) e um papel (aba Papéis) antes de usar dados de teste.");
    return null;
  }

  const tiposVideo = ["live", "short", "video"];
  const tiposConteudoAtivos = tiposConteudoCache.filter((t) => !t.arquivado).map((t) => t.nome);
  const competicoes = competicoesCache.map((c) => c.nome);
  const agora = Date.now();
  const videos = [];

  for (let i = 0; i < quantidade; i++) {
    const tipoVideo = tiposVideo[Math.floor(Math.random() * tiposVideo.length)];
    const tipoConteudo = tiposConteudoAtivos.length ? tiposConteudoAtivos[Math.floor(Math.random() * tiposConteudoAtivos.length)] : null;
    const ehTransmissao = Boolean(tipoConteudo && /transmiss/i.test(tipoConteudo) && competicoes.length);
    const competicao = ehTransmissao ? competicoes[Math.floor(Math.random() * competicoes.length)] : null;
    const programa = !ehTransmissao && tipoConteudo && Math.random() > 0.35
      ? `Programa do(a) ${pessoas[Math.floor(Math.random() * pessoas.length)]}`
      : null;

    const duracaoSegundos =
      tipoVideo === "short" ? Math.floor(Math.random() * 55) + 5
      : tipoVideo === "live" ? Math.floor(Math.random() * 10800) + 1800
      : Math.floor(Math.random() * 1500) + 120;

    const views = Math.floor(Math.random() * 500000) + 500;
    const likes = Math.round(views * (0.01 + Math.random() * 0.05));
    const comentarios = Math.round(views * (0.001 + Math.random() * 0.01));
    const mensagensChat = tipoVideo === "live" ? Math.round(views * (0.005 + Math.random() * 0.02)) : null;

    const qtdParticipantes = 1 + Math.floor(Math.random() * Math.min(3, pessoas.length));
    const participacoes = [...pessoas]
      .sort(() => Math.random() - 0.5)
      .slice(0, qtdParticipantes)
      .map((nome) => ({ nome, papel: papeisAtivos[Math.floor(Math.random() * papeisAtivos.length)] }));

    const diasAtras = Math.floor(Math.random() * 90);
    const rotulo = competicao || programa;

    videos.push({
      video_id: `mock-${i + 1}`,
      canal: "mock",
      tipo_video: tipoVideo,
      titulo: `[TESTE] Vídeo mocado #${i + 1}${rotulo ? ` — ${rotulo}` : ""}`,
      descricao: "",
      data_publicacao: new Date(agora - diasAtras * 86400000).toISOString(),
      duracao_segundos: duracaoSegundos,
      views,
      likes,
      comentarios,
      mensagens_chat: mensagensChat,
      url: "#",
      thumbnail_url: null,
      tipo_conteudo: tipoConteudo,
      competicao,
      programa,
      transcricao_sucesso: Math.random() > 0.3 ? 1 : 0,
      participacoes,
      elenco: participacoes.map((p) => p.nome),
      tipo_conteudo_sugerido: null,
      competicao_sugerida: null,
      programa_sugerido: null,
      competicao_confianca: null,
    });
  }

  return videos;
}

el("btnUsarDadosTeste").addEventListener("click", () => {
  const mock = gerarVideosMock();
  if (!mock) return;

  modoTeste = true;
  videosCache = mock;
  atualizarBadgeModoTeste();
  renderVideosTable();
  renderDashboards();
  renderPessoasStats();
  renderAprovacaoIA();
});

el("btnVoltarDadosReais").addEventListener("click", async () => {
  await carregarVideos();
});

async function carregarPessoas() {
  const res = await fetch("/api/pessoas").then((r) => r.json());
  pessoasCache = res.pessoas || [];
  renderPessoasTable();
  renderPessoasDatalist();
}

async function carregarCompeticoes() {
  const res = await fetch("/api/competicoes").then((r) => r.json());
  competicoesCache = res.competicoes || [];
  renderCompeticoesTable();
  renderCompeticoesDatalist();
}

async function carregarTiposConteudo() {
  const res = await fetch("/api/tipos-conteudo").then((r) => r.json());
  tiposConteudoCache = res.tipos || [];
  renderTiposConteudoTable();
  renderVideosTable();
  renderPessoasStats();
}

async function carregarPapeis() {
  const res = await fetch("/api/papeis").then((r) => r.json());
  papeisCache = res.papeis || [];
  renderPapeisTable();
  renderVideosTable();
  renderPessoasStats();
}

function getOrCreateDatalist(id) {
  let datalist = el(id);
  if (!datalist) {
    datalist = document.createElement("datalist");
    datalist.id = id;
    document.body.appendChild(datalist);
  }
  return datalist;
}

// ---------- aba Vídeos (listagem + classificação + elenco por vídeo) ----------

function renderBarChart(container, entries) {
  const max = Math.max(1, ...entries.map((e) => e.value));
  container.innerHTML = entries
    .map(
      (e) => `
      <div class="bar-row">
        <span>${e.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(e.value / max) * 100}%"></div></div>
        <span>${e.value.toLocaleString("pt-BR")}</span>
      </div>`
    )
    .join("");
}

function renderVideosTable() {
  el("videosCount").textContent = `${videosCache.length} vídeo(s) no período/tipo selecionado`;
  const tbody = document.querySelector("#videosTable tbody");
  tbody.innerHTML = "";

  for (const v of videosCache) {
    tbody.appendChild(criarLinhaVideo(v));
  }
}

function criarLinhaVideo(v) {
  const tr = document.createElement("tr");
  let participacoesLocal = (v.participacoes || []).map((p) => ({ ...p }));

  tr.innerHTML = `
    <td>${v.thumbnail_url ? `<img class="video-thumb" src="${escapeAttr(v.thumbnail_url)}" alt="" loading="lazy" />` : ""}</td>
    <td><code>${v.video_id}</code></td>
    <td>${CONTENT_TYPE_LABELS[v.tipo_video] || v.tipo_video || ""}</td>
    <td class="wrap">${v.titulo || ""}</td>
    <td>${(v.data_publicacao || "").slice(0, 10)}</td>
    <td>${formatDuration(v.duracao_segundos)}</td>
    <td>${v.views ?? ""}</td>
    <td>${v.likes ?? ""}</td>
    <td>${v.comentarios ?? ""}</td>
    <td>${v.mensagens_chat ?? ""}</td>
    <td class="transcricao-cell">${v.transcricao_sucesso ? "✓" : ""}</td>
    <td><a href="${v.url}" target="_blank" rel="noopener">abrir</a></td>
    <td>
      <select data-field="tipoConteudo">${tipoConteudoOptionsHtml(v.tipo_conteudo)}</select>
    </td>
    <td><input type="text" list="competicoesDatalist" value="${escapeAttr(v.competicao)}" data-field="competicao" /></td>
    <td><input type="text" value="${escapeAttr(v.programa)}" data-field="programa" /></td>
    <td class="elenco-video-cell">
      <div class="elenco-pills"></div>
      <div class="elenco-add-form">
        <input type="text" list="pessoasDatalist" placeholder="Nome" data-field="novoNome" />
        <select data-field="novoPapel"></select>
        <button type="button" class="add-participante">+</button>
      </div>
    </td>
    <td class="avaliacao-ia-cell"></td>
    <td class="acoes-video-cell">
      <button class="save-row buscar-transcricao-row" type="button">Transcrição</button>
      <button class="save-row sugerir-elenco-row" type="button">Sugerir elenco (IA)</button>
      <button class="save-row salvar-video-row">Salvar</button>
    </td>
  `;

  const pillsEl = tr.querySelector(".elenco-pills");
  const avaliacaoIaCell = tr.querySelector(".avaliacao-ia-cell");
  const tipoConteudoSelect = tr.querySelector('[data-field="tipoConteudo"]');
  const competicaoInput = tr.querySelector('[data-field="competicao"]');
  const programaInput = tr.querySelector('[data-field="programa"]');
  const novoPapelSelect = tr.querySelector('[data-field="novoPapel"]');
  const transcricaoCell = tr.querySelector(".transcricao-cell");

  novoPapelSelect.innerHTML = papelOptionsHtml();
  renderAvaliacaoIACell(avaliacaoIaCell, v);

  if (modoTeste) {
    tr.querySelector(".buscar-transcricao-row").disabled = true;
    tr.querySelector(".sugerir-elenco-row").disabled = true;
    tr.querySelector(".salvar-video-row").disabled = true;
  }

  function renderPills() {
    pillsEl.innerHTML = participacoesLocal
      .map(
        (p, i) => `<span class="elenco-pill">${p.nome} (${PAPEIS[p.papel] || p.papel})<button type="button" data-remove="${i}">×</button></span>`
      )
      .join("");

    pillsEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        participacoesLocal.splice(Number(btn.dataset.remove), 1);
        renderPills();
      });
    });
  }
  renderPills();

  tr.querySelector(".add-participante").addEventListener("click", () => {
    const nomeInput = tr.querySelector('[data-field="novoNome"]');
    const nome = nomeInput.value.trim();
    if (!nome) return;

    participacoesLocal = participacoesLocal.filter((p) => p.nome !== nome);
    participacoesLocal.push({ nome, papel: novoPapelSelect.value });
    nomeInput.value = "";
    renderPills();
  });

  tr.querySelector(".buscar-transcricao-row").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Buscando...";

    try {
      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: [v.video_id] }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);

      const item = res.results?.[0];
      v.transcricao_sucesso = item?.sucesso ? 1 : 0;
      transcricaoCell.textContent = v.transcricao_sucesso ? "✓" : "";
      if (!item?.sucesso && item?.erro) alert(`Não foi possível buscar a transcrição: ${item.erro}`);
    } catch (error) {
      alert(`Erro ao buscar transcrição: ${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Transcrição";
    }
  });

  tr.querySelector(".sugerir-elenco-row").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Sugerindo...";

    try {
      const res = await fetch("/api/ai/sugerir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: [v.video_id] }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);

      const item = res.results?.[0];
      if (item) {
        v.tipo_conteudo_sugerido = item.tipo_conteudo_sugerido;
        v.competicao_sugerida = item.competicao_sugerida;
        v.programa_sugerido = item.programa_sugerido;
        v.competicao_confianca = item.confianca;
        if (item.participantes_sugeridos?.length) {
          sugestoesParticipantesPorVideo[v.video_id] = item.participantes_sugeridos;
        } else {
          delete sugestoesParticipantesPorVideo[v.video_id];
        }
        if (!item.tipo_conteudo_sugerido && !item.competicao_sugerida && !item.programa_sugerido && !item.participantes_sugeridos?.length) {
          alert(`A IA não encontrou sugestão para este vídeo${item.erro ? `: ${item.erro}` : "."}`);
        }
      }

      const novaLinha = criarLinhaVideo(v);
      tr.replaceWith(novaLinha);
      renderAprovacaoIA();
    } catch (error) {
      alert(`Erro ao pedir sugestão à IA: ${error.message}`);
      btn.disabled = false;
      btn.textContent = "Sugerir elenco (IA)";
    }
  });

  tr.querySelector(".salvar-video-row").addEventListener("click", async () => {
    const competicao = competicaoInput.value.trim();
    const programa = programaInput.value.trim();
    const tipoConteudo = tipoConteudoSelect.value;

    await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: v.video_id,
        competicao: competicao || null,
        programa: programa || null,
        tipo_conteudo: tipoConteudo || null,
        participacoes: participacoesLocal,
      }),
    });

    v.competicao = competicao || null;
    v.programa = programa || null;
    v.tipo_conteudo = tipoConteudo || null;
    v.participacoes = participacoesLocal.map((p) => ({ ...p }));
    v.elenco = participacoesLocal.map((p) => p.nome);
    delete sugestoesParticipantesPorVideo[v.video_id];
    await carregarPessoas();
    renderDashboards();
    renderPessoasStats();
  });

  return tr;
}

// ---------- avaliação (aprovação/descarte) de sugestões da IA ----------
// Usada tanto na coluna "Avaliação IA" da aba Vídeos quanto na aba
// "Aprovação IA" — as duas mostram a mesma pendência e chamam as mesmas
// ações, só muda a apresentação.

function temSugestaoPendente(v) {
  const temClassificacao =
    (v.tipo_conteudo_sugerido && v.tipo_conteudo_sugerido !== v.tipo_conteudo) ||
    (v.competicao_sugerida && v.competicao_sugerida !== v.competicao) ||
    (v.programa_sugerido && v.programa_sugerido !== v.programa);
  const temParticipantes = (sugestoesParticipantesPorVideo[v.video_id] || []).length > 0;
  return Boolean(temClassificacao || temParticipantes);
}

function resumoSugestaoHtml(v) {
  const partes = [];
  if (v.tipo_conteudo_sugerido) partes.push(v.tipo_conteudo_sugerido);
  if (v.competicao_sugerida) partes.push(`competição: ${v.competicao_sugerida}`);
  if (v.programa_sugerido) partes.push(`programa: ${v.programa_sugerido}`);

  const participantes = sugestoesParticipantesPorVideo[v.video_id] || [];
  if (participantes.length) {
    partes.push(`elenco: ${participantes.map((p) => `${p.nome} (${PAPEIS[p.papel] || p.papel})`).join(", ")}`);
  }

  if (!partes.length) return "";
  const confianca = v.competicao_confianca != null ? ` (${Math.round(v.competicao_confianca * 100)}%)` : "";
  return `${partes.join(" | ")}${confianca}`;
}

// Aplica a sugestão pendente (classificação e/ou elenco sugerido) como
// dado oficial do vídeo. Atualiza o objeto `v` em memória e re-renderiza
// as telas que dependem dele.
async function aprovarSugestaoIA(v) {
  const participantesSugeridos = sugestoesParticipantesPorVideo[v.video_id] || [];
  const temClassificacao = v.tipo_conteudo_sugerido || v.competicao_sugerida || v.programa_sugerido;

  if (temClassificacao) {
    await fetch("/api/ai/aplicar-sugestao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: v.video_id }),
    });
    if (v.tipo_conteudo_sugerido) v.tipo_conteudo = v.tipo_conteudo_sugerido;
    if (v.competicao_sugerida) v.competicao = v.competicao_sugerida;
    if (v.programa_sugerido) v.programa = v.programa_sugerido;
  }

  if (participantesSugeridos.length) {
    const participacoes = (v.participacoes || []).map((p) => ({ ...p }));
    for (const sug of participantesSugeridos) {
      if (!participacoes.some((p) => p.nome === sug.nome && p.papel === sug.papel)) participacoes.push(sug);
    }

    await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: v.video_id,
        competicao: v.competicao || null,
        programa: v.programa || null,
        tipo_conteudo: v.tipo_conteudo || null,
        participacoes,
      }),
    });

    v.participacoes = participacoes;
    v.elenco = participacoes.map((p) => p.nome);
  }

  v.tipo_conteudo_sugerido = null;
  v.competicao_sugerida = null;
  v.programa_sugerido = null;
  v.competicao_confianca = null;
  delete sugestoesParticipantesPorVideo[v.video_id];

  await carregarPessoas();
  renderVideosTable();
  renderDashboards();
  renderPessoasStats();
  renderAprovacaoIA();
}

// Descarta a sugestão pendente sem alterar o que já estava salvo no vídeo.
async function descartarSugestaoIA(v) {
  await fetch("/api/ai/descartar-sugestao", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: v.video_id }),
  });

  v.tipo_conteudo_sugerido = null;
  v.competicao_sugerida = null;
  v.programa_sugerido = null;
  v.competicao_confianca = null;
  delete sugestoesParticipantesPorVideo[v.video_id];

  renderVideosTable();
  renderAprovacaoIA();
}

function renderAvaliacaoIACell(cell, v) {
  if (!temSugestaoPendente(v)) {
    cell.innerHTML = `<span class="hint">Sem sugestão pendente</span>`;
    return;
  }

  cell.innerHTML = `
    <div class="sugestao-ia">${resumoSugestaoHtml(v)}</div>
    <div class="acoes-ia">
      <button class="save-row aprovar-ia" type="button">Aprovar</button>
      <button class="save-row descartar-ia" type="button">Descartar</button>
    </div>
  `;

  cell.querySelector(".aprovar-ia").addEventListener("click", () => aprovarSugestaoIA(v));
  cell.querySelector(".descartar-ia").addEventListener("click", () => descartarSugestaoIA(v));
}

function renderAprovacaoIA() {
  const pendencias = videosCache.filter(temSugestaoPendente);
  el("aprovacaoIACount").textContent = `${pendencias.length} vídeo(s) pendente(s)`;

  const tbody = document.querySelector("#aprovacaoIATable tbody");
  tbody.innerHTML = pendencias.length
    ? pendencias
        .map(
          (v) => `
      <tr data-video-id="${escapeAttr(v.video_id)}">
        <td>${v.thumbnail_url ? `<img class="video-thumb" src="${escapeAttr(v.thumbnail_url)}" alt="" loading="lazy" />` : ""}</td>
        <td class="wrap">${v.titulo || ""}</td>
        <td class="wrap">${resumoSugestaoHtml(v)}</td>
        <td>${v.competicao_confianca != null ? `${Math.round(v.competicao_confianca * 100)}%` : ""}</td>
        <td>
          <button class="save-row aprovar-ia" type="button">Aprovar</button>
          <button class="save-row descartar-ia" type="button">Descartar</button>
        </td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="hint">Nenhuma sugestão pendente de aprovação.</td></tr>`;

  tbody.querySelectorAll("tr[data-video-id]").forEach((row) => {
    const v = videosCache.find((vv) => vv.video_id === row.dataset.videoId);
    if (!v) return;
    row.querySelector(".aprovar-ia").addEventListener("click", () => aprovarSugestaoIA(v));
    row.querySelector(".descartar-ia").addEventListener("click", () => descartarSugestaoIA(v));
  });
}

// ---------- aba Dashboards ----------

function selectedMultiValues(id) {
  return Array.from(el(id).selectedOptions).map((o) => o.value);
}

function sum(list, field) {
  return list.reduce((total, item) => total + (item[field] || 0), 0);
}

// Views + curtidas + comentários + chat, tudo sobre views — normaliza
// audiências diferentes pra comparar o quanto um vídeo/membro "engaja".
function engajamento(g) {
  return g.views ? (g.likes + g.comentarios + g.chat) / g.views : 0;
}

function formatPct(x) {
  return `${(x * 100).toFixed(2)}%`;
}

function populateDashFilters() {
  const prevCompeticao = selectedMultiValues("dashFiltroCompeticao");
  const prevPrograma = selectedMultiValues("dashFiltroPrograma");
  const prevElenco = selectedMultiValues("dashFiltroElenco");
  const prevPapel = selectedMultiValues("dashFiltroPapel");

  const competicoes = new Set();
  const programas = new Set();
  const membros = new Set();
  for (const v of videosCache) {
    if (v.competicao) competicoes.add(v.competicao);
    if (v.programa) programas.add(v.programa);
    for (const nome of v.elenco || []) membros.add(nome);
  }

  el("dashFiltroCompeticao").innerHTML = [...competicoes]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => `<option value="${escapeAttr(c)}"${prevCompeticao.includes(c) ? " selected" : ""}>${c}</option>`)
    .join("");
  el("dashFiltroPrograma").innerHTML = [...programas]
    .sort((a, b) => a.localeCompare(b))
    .map((p) => `<option value="${escapeAttr(p)}"${prevPrograma.includes(p) ? " selected" : ""}>${p}</option>`)
    .join("");
  el("dashFiltroElenco").innerHTML = [...membros]
    .sort((a, b) => a.localeCompare(b))
    .map((m) => `<option value="${escapeAttr(m)}"${prevElenco.includes(m) ? " selected" : ""}>${m}</option>`)
    .join("");
  el("dashFiltroPapel").innerHTML = papeisCache
    .filter((p) => !p.arquivado)
    .map((p) => `<option value="${escapeAttr(p.nome)}"${prevPapel.includes(p.nome) ? " selected" : ""}>${PAPEIS[p.nome] || p.nome}</option>`)
    .join("");
}

function dashFilteredVideos() {
  const competicoes = selectedMultiValues("dashFiltroCompeticao");
  const programas = selectedMultiValues("dashFiltroPrograma");
  const tiposVideo = selectedMultiValues("dashFiltroTipoVideo");
  const elencoSel = selectedMultiValues("dashFiltroElenco");
  const papeisSel = selectedMultiValues("dashFiltroPapel");
  const duracaoMin = parseFloat(el("dashFiltroDuracaoMin").value);
  const duracaoMax = parseFloat(el("dashFiltroDuracaoMax").value);
  const dataDe = el("dashFiltroDataDe").value;
  const dataAte = el("dashFiltroDataAte").value;

  return videosCache.filter((v) => {
    if (competicoes.length && !competicoes.includes(v.competicao)) return false;
    if (programas.length && !programas.includes(v.programa)) return false;
    if (tiposVideo.length && !tiposVideo.includes(v.tipo_video)) return false;

    const dataPub = (v.data_publicacao || "").slice(0, 10);
    if (dataDe && dataPub < dataDe) return false;
    if (dataAte && dataPub > dataAte) return false;

    const minutos = (v.duracao_segundos || 0) / 60;
    if (!Number.isNaN(duracaoMin) && minutos < duracaoMin) return false;
    if (!Number.isNaN(duracaoMax) && minutos > duracaoMax) return false;

    if (elencoSel.length || papeisSel.length) {
      const bate = (v.participacoes || []).some(
        (p) => (!elencoSel.length || elencoSel.includes(p.nome)) && (!papeisSel.length || papeisSel.includes(p.papel))
      );
      if (!bate) return false;
    }

    return true;
  });
}

// Agrupa vídeos por uma chave (ex.: tipo de vídeo, competição, faixa de
// duração) e soma as métricas que interessam pra performance/engajamento.
function agruparPor(videos, chaveFn) {
  const grupos = {};
  for (const v of videos) {
    const chave = chaveFn(v);
    if (chave == null) continue;
    if (!grupos[chave]) grupos[chave] = { chave, videos: 0, views: 0, likes: 0, comentarios: 0, chat: 0 };
    const g = grupos[chave];
    g.videos++;
    g.views += v.views || 0;
    g.likes += v.likes || 0;
    g.comentarios += v.comentarios || 0;
    g.chat += v.mensagens_chat || 0;
  }
  return Object.values(grupos)
    .map((g) => ({ ...g, mediaViews: g.videos ? Math.round(g.views / g.videos) : 0, engajamento: engajamento(g) }))
    .sort((a, b) => b.views - a.views);
}

function renderTabelaAgregada(selector, grupos) {
  document.querySelector(selector).innerHTML = grupos.length
    ? grupos
        .map(
          (g) => `<tr>
        <td>${g.chave}</td>
        <td>${g.videos}</td>
        <td>${g.views.toLocaleString("pt-BR")}</td>
        <td>${g.mediaViews.toLocaleString("pt-BR")}</td>
        <td>${g.likes.toLocaleString("pt-BR")}</td>
        <td>${g.comentarios.toLocaleString("pt-BR")}</td>
        <td>${formatPct(g.engajamento)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="hint">Sem dados nesse recorte.</td></tr>`;
}

function renderDadosGerais(videos) {
  const metricsEl = el("metrics");

  if (videos.length === 0) {
    metricsEl.innerHTML = `<p class="hint">Nenhum vídeo nesse recorte. Ajuste os filtros ou rode o mapeamento na aba Mapeamento.</p>`;
    el("chartTipos").innerHTML = "";
    document.querySelector("#top10Table tbody").innerHTML = "";
    return;
  }

  const comTranscricao = videos.filter((v) => v.transcricao_sucesso).length;

  metricsEl.innerHTML = `
    <div class="metric-card"><div class="value">${videos.length}</div><div class="label">Vídeos</div></div>
    <div class="metric-card"><div class="value">${sum(videos, "views").toLocaleString("pt-BR")}</div><div class="label">Views (soma)</div></div>
    <div class="metric-card"><div class="value">${sum(videos, "likes").toLocaleString("pt-BR")}</div><div class="label">Curtidas (soma)</div></div>
    <div class="metric-card"><div class="value">${sum(videos, "comentarios").toLocaleString("pt-BR")}</div><div class="label">Comentários (soma)</div></div>
    <div class="metric-card"><div class="value">${comTranscricao}/${videos.length}</div><div class="label">Com transcrição</div></div>
  `;

  const porTipo = {};
  for (const v of videos) {
    const label = CONTENT_TYPE_LABELS[v.tipo_video] || v.tipo_video || "?";
    porTipo[label] = (porTipo[label] || 0) + 1;
  }
  renderBarChart(el("chartTipos"), Object.entries(porTipo).map(([label, value]) => ({ label, value })));

  const top10 = [...videos].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);
  document.querySelector("#top10Table tbody").innerHTML = top10
    .map(
      (v) => `<tr>
        <td class="wrap">${v.titulo || ""}</td>
        <td>${CONTENT_TYPE_LABELS[v.tipo_video] || ""}</td>
        <td>${formatDuration(v.duracao_segundos)}</td>
        <td>${(v.views || 0).toLocaleString("pt-BR")}</td>
      </tr>`
    )
    .join("");
}

function renderPorTipoVideo(videos) {
  const grupos = agruparPor(videos, (v) => CONTENT_TYPE_LABELS[v.tipo_video] || v.tipo_video || "?");
  renderTabelaAgregada("#statsTipoVideoTable tbody", grupos);
}

function renderPorCompeticao(videos) {
  const grupos = agruparPor(videos.filter((v) => v.competicao), (v) => v.competicao);
  el("chartCompeticao").innerHTML = grupos.length ? "" : `<p class="hint">Nenhum vídeo tem competição identificada nesse recorte.</p>`;
  if (grupos.length) renderBarChart(el("chartCompeticao"), grupos.map((g) => ({ label: g.chave, value: g.views })));
  renderTabelaAgregada("#statsCompeticaoTable tbody", grupos);
}

function renderPorPrograma(videos) {
  const grupos = agruparPor(videos.filter((v) => v.programa), (v) => v.programa);
  el("chartPrograma").innerHTML = grupos.length ? "" : `<p class="hint">Nenhum vídeo tem programa identificado nesse recorte.</p>`;
  if (grupos.length) renderBarChart(el("chartPrograma"), grupos.map((g) => ({ label: g.chave, value: g.views })));
  renderTabelaAgregada("#statsProgramaTable tbody", grupos);
}

const FAIXAS_DURACAO = [
  { label: "Até 1 min (Shorts)", min: 0, max: 60 },
  { label: "1–5 min", min: 60, max: 300 },
  { label: "5–15 min", min: 300, max: 900 },
  { label: "15–30 min", min: 900, max: 1800 },
  { label: "30–60 min", min: 1800, max: 3600 },
  { label: "Mais de 1h", min: 3600, max: Infinity },
];

function renderPorDuracao(videos) {
  const grupos = agruparPor(videos, (v) => {
    const segundos = v.duracao_segundos || 0;
    const faixa = FAIXAS_DURACAO.find((f) => segundos >= f.min && segundos < f.max);
    return faixa ? faixa.label : "Sem duração";
  });
  const ordem = FAIXAS_DURACAO.map((f) => f.label);
  grupos.sort((a, b) => ordem.indexOf(a.chave) - ordem.indexOf(b.chave));
  renderTabelaAgregada("#statsDuracaoTable tbody", grupos);
}

function renderPorData(videos) {
  const grupos = agruparPor(videos, (v) => (v.data_publicacao || "").slice(0, 7) || "Sem data");
  grupos.sort((a, b) => a.chave.localeCompare(b.chave));
  el("chartData").innerHTML = grupos.length ? "" : `<p class="hint">Sem dados nesse recorte.</p>`;
  if (grupos.length) renderBarChart(el("chartData"), grupos.map((g) => ({ label: g.chave, value: g.views })));
  renderTabelaAgregada("#statsDataTable tbody", grupos);
}

function renderDashboards() {
  populateDashFilters();
  const videos = dashFilteredVideos();
  renderDadosGerais(videos);
  renderPorTipoVideo(videos);
  renderPorCompeticao(videos);
  renderPorPrograma(videos);
  renderPorDuracao(videos);
  renderPorData(videos);
  renderCastDashboard(videos);
}

["dashFiltroCompeticao", "dashFiltroPrograma", "dashFiltroTipoVideo", "dashFiltroElenco", "dashFiltroPapel"].forEach((id) => {
  el(id).addEventListener("change", renderDashboards);
});
["dashFiltroDuracaoMin", "dashFiltroDuracaoMax", "dashFiltroDataDe", "dashFiltroDataAte"].forEach((id) => {
  el(id).addEventListener("change", renderDashboards);
});
el("btnLimparFiltrosDash").addEventListener("click", () => {
  ["dashFiltroCompeticao", "dashFiltroPrograma", "dashFiltroTipoVideo", "dashFiltroElenco", "dashFiltroPapel"].forEach((id) => {
    Array.from(el(id).options).forEach((o) => { o.selected = false; });
  });
  ["dashFiltroDuracaoMin", "dashFiltroDuracaoMax", "dashFiltroDataDe", "dashFiltroDataAte"].forEach((id) => {
    el(id).value = "";
  });
  renderDashboards();
});

// ---------- aba Elenco (pessoas cadastradas) ----------

function renderPessoasTable() {
  const tbody = document.querySelector("#pessoasTable tbody");
  tbody.innerHTML = pessoasCache
    .map(
      (p) => `
      <tr>
        <td><input type="text" value="${escapeAttr(p.nome)}" data-pessoa-nome="${p.id}" /></td>
        <td><input type="text" value="${escapeAttr((p.apelidos || []).join(", "))}" data-pessoa-apelidos="${p.id}" /></td>
        <td>
          <button class="save-row" data-salvar-pessoa="${p.id}">Salvar</button>
          <button class="save-row" data-excluir-pessoa="${p.id}">Excluir</button>
        </td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-salvar-pessoa]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.salvarPessoa;
      const nome = tbody.querySelector(`[data-pessoa-nome="${id}"]`).value.trim();
      const apelidos = tbody.querySelector(`[data-pessoa-apelidos="${id}"]`).value.split(",").map((s) => s.trim()).filter(Boolean);

      await fetch("/api/pessoas/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(id), nome, apelidos }),
      });
      await carregarPessoas();
    });
  });

  tbody.querySelectorAll("[data-excluir-pessoa]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Excluir essa pessoa? Isso remove ela de qualquer vídeo em que foi marcada.")) return;

      await fetch("/api/pessoas/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(btn.dataset.excluirPessoa) }),
      });
      await carregarPessoas();
      await carregarVideos();
    });
  });
}

function renderPessoasDatalist() {
  const datalist = getOrCreateDatalist("pessoasDatalist");
  datalist.innerHTML = pessoasCache
    .flatMap((p) => [p.nome, ...(p.apelidos || [])])
    .map((nome) => `<option value="${escapeAttr(nome)}"></option>`)
    .join("");
}

el("btnAdicionarPessoa").addEventListener("click", async () => {
  const nome = el("novaPessoaNome").value.trim();
  const apelidos = el("novaPessoaApelidos").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!nome) return;

  await fetch("/api/pessoas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome, apelidos }),
  });

  el("novaPessoaNome").value = "";
  el("novaPessoaApelidos").value = "";
  await carregarPessoas();
});

// Quantas vezes cada membro apareceu em cada papel, considerando os vídeos
// já carregados (período/tipo de vídeo da aba Mapeamento) e os filtros de
// tipo de conteúdo/competição desta aba.
function populateElencoFilters() {
  const tipoSelect = el("elencoFiltroTipoConteudo");
  const competicaoSelect = el("elencoFiltroCompeticao");
  const prevTipo = tipoSelect.value;
  const prevCompeticao = competicaoSelect.value;

  const tiposAtivos = tiposConteudoCache.filter((t) => !t.arquivado);
  tipoSelect.innerHTML = '<option value="">Todos</option>' +
    tiposAtivos.map((t) => `<option value="${escapeAttr(t.nome)}">${t.nome}</option>`).join("");

  const competicoes = new Set();
  for (const v of videosCache) { if (v.competicao) competicoes.add(v.competicao); }
  competicaoSelect.innerHTML = '<option value="">Todas</option>' +
    [...competicoes].sort((a, b) => a.localeCompare(b)).map((c) => `<option value="${escapeAttr(c)}">${c}</option>`).join("");

  if (tiposAtivos.some((t) => t.nome === prevTipo)) tipoSelect.value = prevTipo;
  if (competicoes.has(prevCompeticao)) competicaoSelect.value = prevCompeticao;
}

function renderPessoasStats() {
  populateElencoFilters();

  const tipoFiltro = el("elencoFiltroTipoConteudo").value;
  const competicaoFiltro = el("elencoFiltroCompeticao").value;
  const videosFiltrados = videosCache.filter(
    (v) => (!tipoFiltro || v.tipo_conteudo === tipoFiltro) && (!competicaoFiltro || v.competicao === competicaoFiltro)
  );

  const porPessoa = {};
  for (const v of videosFiltrados) {
    for (const p of v.participacoes || []) {
      if (!porPessoa[p.nome]) porPessoa[p.nome] = {};
      porPessoa[p.nome][p.papel] = (porPessoa[p.nome][p.papel] || 0) + 1;
    }
  }

  const papeisKeys = papeisCache.map((p) => p.nome);
  el("pessoasStatsHeader").innerHTML = "<th>Membro</th>" + papeisKeys.map((k) => `<th>${PAPEIS[k] || k}</th>`).join("") + "<th>Total</th>";

  const linhas = Object.entries(porPessoa)
    .map(([nome, porPapel]) => ({ nome, porPapel, total: papeisKeys.reduce((sum, k) => sum + (porPapel[k] || 0), 0) }))
    .sort((a, b) => b.total - a.total);

  document.querySelector("#pessoasStatsTable tbody").innerHTML = linhas
    .map(
      (l) => `<tr><td>${l.nome}</td>${papeisKeys.map((k) => `<td>${l.porPapel[k] || 0}</td>`).join("")}<td>${l.total}</td></tr>`
    )
    .join("") || `<tr><td colspan="${papeisKeys.length + 2}" class="hint">Sem participações nesse recorte.</td></tr>`;
}

["elencoFiltroTipoConteudo", "elencoFiltroCompeticao"].forEach((id) => {
  el(id).addEventListener("change", renderPessoasStats);
});

// ---------- aba Competições ----------

function renderCompeticoesTable() {
  const tbody = document.querySelector("#competicoesTable tbody");
  tbody.innerHTML = competicoesCache
    .map(
      (c) => `
      <tr>
        <td><input type="text" value="${escapeAttr(c.nome)}" data-competicao-nome="${c.id}" /></td>
        <td>
          <button class="save-row" data-salvar-competicao="${c.id}">Salvar</button>
          <button class="save-row" data-excluir-competicao="${c.id}">Excluir</button>
        </td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-salvar-competicao]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.salvarCompeticao;
      const nome = tbody.querySelector(`[data-competicao-nome="${id}"]`).value.trim();
      if (!nome) return;

      await fetch("/api/competicoes/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(id), nome }),
      });
      await carregarCompeticoes();
    });
  });

  tbody.querySelectorAll("[data-excluir-competicao]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Excluir essa competição da lista de referência?")) return;

      await fetch("/api/competicoes/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(btn.dataset.excluirCompeticao) }),
      });
      await carregarCompeticoes();
    });
  });
}

function renderCompeticoesDatalist() {
  const datalist = getOrCreateDatalist("competicoesDatalist");
  datalist.innerHTML = competicoesCache.map((c) => `<option value="${escapeAttr(c.nome)}"></option>`).join("");
}

el("btnAdicionarCompeticao").addEventListener("click", async () => {
  const nome = el("novaCompeticaoNome").value.trim();
  if (!nome) return;

  await fetch("/api/competicoes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome }),
  });

  el("novaCompeticaoNome").value = "";
  await carregarCompeticoes();
});

// ---------- aba Tipo de Conteúdo ----------

function renderTiposConteudoTable() {
  const tbody = document.querySelector("#tiposConteudoTable tbody");
  tbody.innerHTML = tiposConteudoCache
    .map(
      (t) => `
      <tr>
        <td>${t.nome}</td>
        <td>${t.arquivado ? "Arquivado" : "Ativo"}</td>
        <td><button class="save-row" data-arquivar-tipo="${t.id}" data-arquivado="${t.arquivado ? 0 : 1}">${t.arquivado ? "Restaurar" : "Arquivar"}</button></td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-arquivar-tipo]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch("/api/tipos-conteudo/arquivar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(btn.dataset.arquivarTipo), arquivado: Number(btn.dataset.arquivado) === 1 }),
      });
      await carregarTiposConteudo();
    });
  });
}

el("btnAdicionarTipoConteudo").addEventListener("click", async () => {
  const nome = el("novoTipoConteudoNome").value.trim();
  if (!nome) return;

  await fetch("/api/tipos-conteudo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome }),
  });

  el("novoTipoConteudoNome").value = "";
  await carregarTiposConteudo();
});

// ---------- aba Papéis ----------

function renderPapeisTable() {
  const tbody = document.querySelector("#papeisTable tbody");
  tbody.innerHTML = papeisCache
    .map(
      (p) => `
      <tr>
        <td>${PAPEIS[p.nome] || p.nome}</td>
        <td>${p.arquivado ? "Arquivado" : "Ativo"}</td>
        <td><button class="save-row" data-arquivar-papel="${p.id}" data-arquivado="${p.arquivado ? 0 : 1}">${p.arquivado ? "Restaurar" : "Arquivar"}</button></td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-arquivar-papel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch("/api/papeis/arquivar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(btn.dataset.arquivarPapel), arquivado: Number(btn.dataset.arquivado) === 1 }),
      });
      await carregarPapeis();
    });
  });
}

el("btnAdicionarPapel").addEventListener("click", async () => {
  const nome = el("novoPapelNome").value.trim();
  if (!nome) return;

  await fetch("/api/papeis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome }),
  });

  el("novoPapelNome").value = "";
  await carregarPapeis();
});

// ---------- importar CSV (classificação + elenco por vídeo) ----------

el("btnImportarCsv").addEventListener("click", async () => {
  const fileInput = el("csvImportFile");
  const statusEl = el("csvImportStatus");
  const file = fileInput.files[0];

  if (!file) {
    statusEl.textContent = "Selecione um arquivo CSV primeiro.";
    statusEl.className = "status-msg error";
    return;
  }

  statusEl.textContent = "Importando...";
  statusEl.className = "status-msg";

  try {
    const text = await file.text();
    const res = await fetch("/api/enrich/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: text,
    }).then((r) => r.json());

    if (res.error) throw new Error(res.error);

    let msg = `${res.atualizados} vídeo(s) atualizado(s) a partir do CSV.`;
    if (res.naoEncontrados?.length) {
      msg += ` ${res.naoEncontrados.length} video_id(s) não encontrados: ${res.naoEncontrados.slice(0, 10).join(", ")}${res.naoEncontrados.length > 10 ? "..." : ""}`;
    }
    statusEl.textContent = msg;
    statusEl.className = "status-msg success";

    await carregarPessoas();
    await carregarVideos();
  } catch (error) {
    statusEl.textContent = `Erro ao importar: ${error.message}`;
    statusEl.className = "status-msg error";
  }
});

// ---------- sub-aba "Por elenco" dos Dashboards ----------
// Recebe sempre o mesmo conjunto de vídeos já filtrado pelos filtros
// globais (dashFilteredVideos) — o papel selecionado nos filtros globais
// já decide quais participações contam; aqui só sobra o drill-down por
// membro (select local, porque é sempre de "um de cada vez").

function participantesDoVideo(v) {
  const papeisSel = selectedMultiValues("dashFiltroPapel");
  return (v.participacoes || []).filter((p) => !papeisSel.length || papeisSel.includes(p.papel));
}

function populateCastMemberFilter(videos) {
  const membros = new Set();
  for (const v of videos) {
    for (const p of participantesDoVideo(v)) membros.add(p.nome);
  }

  const membroSelect = el("castFiltroMembro");
  const prevMembro = membroSelect.value;
  membroSelect.innerHTML = '<option value="">(nenhum)</option>' +
    [...membros].sort((a, b) => a.localeCompare(b)).map((m) => `<option value="${escapeAttr(m)}">${m}</option>`).join("");
  if (membros.has(prevMembro)) membroSelect.value = prevMembro;
}

function renderCastRanking(videos) {
  const porMembro = {};

  for (const v of videos) {
    for (const p of participantesDoVideo(v)) {
      if (!porMembro[p.nome]) porMembro[p.nome] = { videos: 0, views: 0, likes: 0, comentarios: 0, chat: 0 };
      const s = porMembro[p.nome];
      s.videos++;
      s.views += v.views || 0;
      s.likes += v.likes || 0;
      s.comentarios += v.comentarios || 0;
      s.chat += v.mensagens_chat || 0;
    }
  }

  const linhas = Object.entries(porMembro)
    .map(([nome, s]) => ({ nome, ...s, media: s.videos ? Math.round(s.views / s.videos) : 0, engajamento: engajamento(s) }))
    .sort((a, b) => b.views - a.views);

  document.querySelector("#castRankingTable tbody").innerHTML = linhas.length
    ? linhas
        .map(
          (l) => `<tr>
        <td>${l.nome}</td><td>${l.videos}</td>
        <td>${l.views.toLocaleString("pt-BR")}</td>
        <td>${l.media.toLocaleString("pt-BR")}</td>
        <td>${l.likes.toLocaleString("pt-BR")}</td>
        <td>${l.comentarios.toLocaleString("pt-BR")}</td>
        <td>${l.chat.toLocaleString("pt-BR")}</td>
        <td>${formatPct(l.engajamento)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="hint">Sem dados de elenco nesse recorte.</td></tr>`;
}

function renderCastCombos(videos) {
  const porCombo = {};

  for (const v of videos) {
    const participantes = participantesDoVideo(v);
    if (!participantes.length) continue;

    const combo = [...participantes].sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => `${p.nome} (${PAPEIS[p.papel] || p.papel})`).join(" + ");
    if (!porCombo[combo]) porCombo[combo] = { videos: 0, views: 0 };
    porCombo[combo].videos++;
    porCombo[combo].views += v.views || 0;
  }

  const linhas = Object.entries(porCombo)
    .map(([combo, s]) => ({ combo, ...s, media: s.videos ? Math.round(s.views / s.videos) : 0 }))
    .sort((a, b) => b.views - a.views);

  document.querySelector("#castComboTable tbody").innerHTML = linhas.length
    ? linhas
        .map(
          (l) => `<tr>
        <td class="wrap">${l.combo}</td><td>${l.videos}</td>
        <td>${l.views.toLocaleString("pt-BR")}</td>
        <td>${l.media.toLocaleString("pt-BR")}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="hint">Sem combinações de elenco nesse recorte.</td></tr>`;
}

function renderCastMemberDetail(videos) {
  const membro = el("castFiltroMembro").value;
  const container = el("castMemberDetail");

  if (!membro) {
    container.innerHTML = "";
    return;
  }

  const doMembro = videos.filter((v) => participantesDoVideo(v).some((p) => p.nome === membro));

  const porTipo = {};
  const porCompeticao = {};
  for (const v of doMembro) {
    const tipoLabel = CONTENT_TYPE_LABELS[v.tipo_video] || v.tipo_video || "?";
    porTipo[tipoLabel] = (porTipo[tipoLabel] || 0) + (v.views || 0);
    const rotulo = v.competicao || v.programa;
    if (rotulo) porCompeticao[rotulo] = (porCompeticao[rotulo] || 0) + (v.views || 0);
  }

  container.innerHTML = `
    <h5>Detalhe: ${membro} (${doMembro.length} vídeo(s) no recorte atual)</h5>
    <div class="charts">
      <div class="chart-card">
        <h4>Views por tipo de conteúdo</h4>
        <div class="bar-chart" id="castMemberTipoChart"></div>
      </div>
      <div class="chart-card">
        <h4>Views por competição/programa</h4>
        <div class="bar-chart" id="castMemberCompeticaoChart"></div>
      </div>
    </div>
  `;

  renderBarChart(el("castMemberTipoChart"), Object.entries(porTipo).map(([label, value]) => ({ label, value })));
  const comboEntries = Object.entries(porCompeticao).map(([label, value]) => ({ label, value }));
  el("castMemberCompeticaoChart").innerHTML = comboEntries.length ? "" : `<p class="hint">Sem competição/programa registrado.</p>`;
  if (comboEntries.length) renderBarChart(el("castMemberCompeticaoChart"), comboEntries);
}

function renderCastDashboard(videos) {
  populateCastMemberFilter(videos);
  renderCastRanking(videos);
  renderCastCombos(videos);
  renderCastMemberDetail(videos);
}

el("castFiltroMembro").addEventListener("change", () => {
  renderCastMemberDetail(dashFilteredVideos());
});

carregarPessoas();
carregarCompeticoes();
Promise.all([carregarTiposConteudo(), carregarPapeis()]).then(carregarVideos);
