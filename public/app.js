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
  return Object.entries(PAPEIS)
    .map(([valor, label]) => `<option value="${valor}"${valor === selected ? " selected" : ""}>${label}</option>`)
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

async function carregarVideos() {
  const dateFrom = el("dateFrom").value;
  const dateTo = el("dateTo").value;
  const contentTypes = selectedContentTypes();

  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, tipos: contentTypes.join(",") });
  const res = await fetch(`/api/videos?${params}`).then((r) => r.json());
  videosCache = res.videos || [];

  el("downloadCsv").href = `/api/export.csv?${params}`;
  renderVideosTable();
  renderDashboards();
  renderPessoasStats();
}

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

  const temSugestaoClassificacao =
    (v.tipo_conteudo_sugerido && v.tipo_conteudo_sugerido !== v.tipo_conteudo) ||
    (v.competicao_sugerida && v.competicao_sugerida !== v.competicao) ||
    (v.programa_sugerido && v.programa_sugerido !== v.programa);

  const partesSugestao = [];
  if (v.tipo_conteudo_sugerido) partesSugestao.push(v.tipo_conteudo_sugerido);
  if (v.competicao_sugerida) partesSugestao.push(`competição: ${v.competicao_sugerida}`);
  if (v.programa_sugerido) partesSugestao.push(`programa: ${v.programa_sugerido}`);

  const sugestaoClassificacaoHtml = temSugestaoClassificacao
    ? `<div class="sugestao-ia">
        Sugestão IA: ${partesSugestao.join(" | ")} (${Math.round((v.competicao_confianca || 0) * 100)}%)
        <button class="usar-sugestao" type="button">Usar</button>
      </div>`
    : "";

  const participantesSugeridos = (sugestoesParticipantesPorVideo[v.video_id] || [])
    .filter((sug) => !participacoesLocal.some((p) => p.nome === sug.nome && p.papel === sug.papel));

  tr.innerHTML = `
    <td>${v.thumbnail_url ? `<img class="video-thumb" src="${escapeAttr(v.thumbnail_url)}" alt="" loading="lazy" />` : ""}</td>
    <td><code>${v.video_id}</code></td>
    <td>${CONTENT_TYPE_LABELS[v.tipo_video] || v.tipo_video || ""}</td>
    <td class="wrap">${v.titulo || ""}</td>
    <td>${(v.data_publicacao || "").slice(0, 10)}</td>
    <td>${formatDuration(v.duracao_segundos)}</td>
    <td>${v.views ?? ""}</td>
    <td>${v.comentarios ?? ""}</td>
    <td>${v.mensagens_chat ?? ""}</td>
    <td class="transcricao-cell">${v.transcricao_sucesso ? "✓" : ""}</td>
    <td><a href="${v.url}" target="_blank" rel="noopener">abrir</a></td>
    <td>
      <select data-field="tipoConteudo">${tipoConteudoOptionsHtml(v.tipo_conteudo)}</select>
      ${sugestaoClassificacaoHtml}
    </td>
    <td><input type="text" list="competicoesDatalist" value="${escapeAttr(v.competicao)}" data-field="competicao" /></td>
    <td><input type="text" value="${escapeAttr(v.programa)}" data-field="programa" /></td>
    <td class="elenco-video-cell">
      <div class="elenco-pills"></div>
      <div class="elenco-sugestoes"></div>
      <div class="elenco-add-form">
        <input type="text" list="pessoasDatalist" placeholder="Nome" data-field="novoNome" />
        <select data-field="novoPapel"></select>
        <button type="button" class="add-participante">+</button>
      </div>
    </td>
    <td class="acoes-video-cell">
      <button class="save-row buscar-transcricao-row" type="button">Transcrição</button>
      <button class="save-row sugerir-elenco-row" type="button">Sugerir elenco (IA)</button>
      <button class="save-row salvar-video-row">Salvar</button>
    </td>
  `;

  const pillsEl = tr.querySelector(".elenco-pills");
  const sugestoesEl = tr.querySelector(".elenco-sugestoes");
  const tipoConteudoSelect = tr.querySelector('[data-field="tipoConteudo"]');
  const competicaoInput = tr.querySelector('[data-field="competicao"]');
  const programaInput = tr.querySelector('[data-field="programa"]');
  const novoPapelSelect = tr.querySelector('[data-field="novoPapel"]');
  const transcricaoCell = tr.querySelector(".transcricao-cell");

  novoPapelSelect.innerHTML = papelOptionsHtml();

  function renderSugestoesParticipantes() {
    sugestoesEl.innerHTML = participantesSugeridos.length
      ? `<div class="sugestao-ia">Elenco sugerido pela IA: ` +
        participantesSugeridos
          .map((p, i) => `${p.nome} (${PAPEIS[p.papel] || p.papel}) <button type="button" data-add-sugestao="${i}">+</button>`)
          .join(" · ") +
        `</div>`
      : "";

    sugestoesEl.querySelectorAll("[data-add-sugestao]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sug = participantesSugeridos[Number(btn.dataset.addSugestao)];
        participacoesLocal = participacoesLocal.filter((p) => p.nome !== sug.nome);
        participacoesLocal.push(sug);
        participantesSugeridos.splice(Number(btn.dataset.addSugestao), 1);
        renderPills();
        renderSugestoesParticipantes();
      });
    });
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
  renderSugestoesParticipantes();

  tr.querySelector(".add-participante").addEventListener("click", () => {
    const nomeInput = tr.querySelector('[data-field="novoNome"]');
    const nome = nomeInput.value.trim();
    if (!nome) return;

    participacoesLocal = participacoesLocal.filter((p) => p.nome !== nome);
    participacoesLocal.push({ nome, papel: novoPapelSelect.value });
    nomeInput.value = "";
    renderPills();
  });

  const sugestaoBtn = tr.querySelector(".usar-sugestao");
  if (sugestaoBtn) {
    sugestaoBtn.addEventListener("click", async () => {
      await fetch("/api/ai/aplicar-sugestao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: v.video_id }),
      });
      if (v.tipo_conteudo_sugerido) tipoConteudoSelect.value = v.tipo_conteudo_sugerido;
      if (v.competicao_sugerida) competicaoInput.value = v.competicao_sugerida;
      if (v.programa_sugerido) programaInput.value = v.programa_sugerido;
    });
  }

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
  });

  return tr;
}

function renderDashboards() {
  const metricsEl = el("metrics");

  if (videosCache.length === 0) {
    metricsEl.innerHTML = `<p class="hint">Sem dados para mostrar ainda. Rode o mapeamento na aba Mapeamento.</p>`;
    el("chartTipos").innerHTML = "";
    el("chartCompeticao").innerHTML = "";
    el("chartPrograma").innerHTML = "";
    document.querySelector("#top10Table tbody").innerHTML = "";
    document.querySelector("#castRankingTable tbody").innerHTML = "";
    document.querySelector("#castComboTable tbody").innerHTML = "";
    el("castMemberDetail").innerHTML = "";
    return;
  }

  const totalViews = videosCache.reduce((sum, v) => sum + (v.views || 0), 0);
  const totalComentarios = videosCache.reduce((sum, v) => sum + (v.comentarios || 0), 0);
  const comTranscricao = videosCache.filter((v) => v.transcricao_sucesso).length;

  metricsEl.innerHTML = `
    <div class="metric-card"><div class="value">${videosCache.length}</div><div class="label">Vídeos</div></div>
    <div class="metric-card"><div class="value">${totalViews.toLocaleString("pt-BR")}</div><div class="label">Views (soma)</div></div>
    <div class="metric-card"><div class="value">${totalComentarios.toLocaleString("pt-BR")}</div><div class="label">Comentários (soma)</div></div>
    <div class="metric-card"><div class="value">${comTranscricao}/${videosCache.length}</div><div class="label">Com transcrição</div></div>
  `;

  const porTipo = {};
  for (const v of videosCache) {
    const label = CONTENT_TYPE_LABELS[v.tipo_video] || v.tipo_video || "?";
    porTipo[label] = (porTipo[label] || 0) + 1;
  }
  renderBarChart(el("chartTipos"), Object.entries(porTipo).map(([label, value]) => ({ label, value })));

  const top10 = [...videosCache].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);
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

  const porCompeticao = {};
  for (const v of videosCache) {
    if (!v.competicao) continue;
    porCompeticao[v.competicao] = (porCompeticao[v.competicao] || 0) + (v.views || 0);
  }
  const entriesCompeticao = Object.entries(porCompeticao).map(([label, value]) => ({ label, value }));
  el("chartCompeticao").innerHTML = entriesCompeticao.length
    ? ""
    : `<p class="hint">Nenhum vídeo tem competição identificada ainda.</p>`;
  if (entriesCompeticao.length) renderBarChart(el("chartCompeticao"), entriesCompeticao);

  const porPrograma = {};
  for (const v of videosCache) {
    if (!v.programa) continue;
    porPrograma[v.programa] = (porPrograma[v.programa] || 0) + (v.views || 0);
  }
  const entriesPrograma = Object.entries(porPrograma).map(([label, value]) => ({ label, value }));
  el("chartPrograma").innerHTML = entriesPrograma.length
    ? ""
    : `<p class="hint">Nenhum vídeo tem programa identificado ainda.</p>`;
  if (entriesPrograma.length) renderBarChart(el("chartPrograma"), entriesPrograma);

  renderCastDashboard();
}

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

  const papeisKeys = Object.keys(PAPEIS);
  el("pessoasStatsHeader").innerHTML = "<th>Membro</th>" + papeisKeys.map((k) => `<th>${PAPEIS[k]}</th>`).join("") + "<th>Total</th>";

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

// ---------- aba Dashboards: performance do elenco ----------

function participantesDoVideo(v, papelFiltro) {
  return (v.participacoes || []).filter((p) => !papelFiltro || p.papel === papelFiltro);
}

function populateCastFilters() {
  const membros = new Set();
  const competicoesOuProgramas = new Set();

  for (const v of videosCache) {
    for (const nome of v.elenco || []) membros.add(nome);
    if (v.competicao) competicoesOuProgramas.add(v.competicao);
    if (v.programa) competicoesOuProgramas.add(v.programa);
  }

  const membroSelect = el("castFiltroMembro");
  const competicaoSelect = el("castFiltroCompeticao");
  const papelSelect = el("castFiltroPapel");
  const prevMembro = membroSelect.value;
  const prevCompeticao = competicaoSelect.value;

  membroSelect.innerHTML = '<option value="">(nenhum)</option>' +
    [...membros].sort((a, b) => a.localeCompare(b)).map((m) => `<option value="${escapeAttr(m)}">${m}</option>`).join("");
  competicaoSelect.innerHTML = '<option value="">Todas</option>' +
    [...competicoesOuProgramas].sort((a, b) => a.localeCompare(b)).map((c) => `<option value="${escapeAttr(c)}">${c}</option>`).join("");

  if (!papelSelect.dataset.preenchido) {
    papelSelect.innerHTML = '<option value="">Todos</option>' + papelOptionsHtml();
    papelSelect.value = "";
    papelSelect.dataset.preenchido = "1";
  }

  if (membros.has(prevMembro)) membroSelect.value = prevMembro;
  if (competicoesOuProgramas.has(prevCompeticao)) competicaoSelect.value = prevCompeticao;
}

function castFilteredVideos() {
  const tipo = el("castFiltroTipo").value;
  const competicaoOuPrograma = el("castFiltroCompeticao").value;

  return videosCache.filter(
    (v) =>
      (!tipo || v.tipo_video === tipo) &&
      (!competicaoOuPrograma || v.competicao === competicaoOuPrograma || v.programa === competicaoOuPrograma)
  );
}

function renderCastRanking(videos) {
  const papelFiltro = el("castFiltroPapel").value;
  const porMembro = {};

  for (const v of videos) {
    for (const p of participantesDoVideo(v, papelFiltro)) {
      if (!porMembro[p.nome]) porMembro[p.nome] = { videos: 0, views: 0, comentarios: 0 };
      porMembro[p.nome].videos++;
      porMembro[p.nome].views += v.views || 0;
      porMembro[p.nome].comentarios += v.comentarios || 0;
    }
  }

  const linhas = Object.entries(porMembro)
    .map(([nome, s]) => ({ nome, ...s, media: s.videos ? Math.round(s.views / s.videos) : 0 }))
    .sort((a, b) => b.views - a.views);

  document.querySelector("#castRankingTable tbody").innerHTML = linhas
    .map(
      (l) => `<tr>
        <td>${l.nome}</td><td>${l.videos}</td>
        <td>${l.views.toLocaleString("pt-BR")}</td>
        <td>${l.media.toLocaleString("pt-BR")}</td>
        <td>${l.comentarios.toLocaleString("pt-BR")}</td>
      </tr>`
    )
    .join("") || `<tr><td colspan="5" class="hint">Sem dados de elenco nesse recorte.</td></tr>`;
}

function renderCastCombos(videos) {
  const papelFiltro = el("castFiltroPapel").value;
  const porCombo = {};

  for (const v of videos) {
    const participantes = participantesDoVideo(v, papelFiltro);
    if (!participantes.length) continue;

    const combo = [...participantes].sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => `${p.nome} (${PAPEIS[p.papel] || p.papel})`).join(" + ");
    if (!porCombo[combo]) porCombo[combo] = { videos: 0, views: 0 };
    porCombo[combo].videos++;
    porCombo[combo].views += v.views || 0;
  }

  const linhas = Object.entries(porCombo)
    .map(([combo, s]) => ({ combo, ...s, media: s.videos ? Math.round(s.views / s.videos) : 0 }))
    .sort((a, b) => b.views - a.views);

  document.querySelector("#castComboTable tbody").innerHTML = linhas
    .map(
      (l) => `<tr>
        <td class="wrap">${l.combo}</td><td>${l.videos}</td>
        <td>${l.views.toLocaleString("pt-BR")}</td>
        <td>${l.media.toLocaleString("pt-BR")}</td>
      </tr>`
    )
    .join("") || `<tr><td colspan="4" class="hint">Sem combinações de elenco nesse recorte.</td></tr>`;
}

function renderCastMemberDetail(videos) {
  const membro = el("castFiltroMembro").value;
  const papelFiltro = el("castFiltroPapel").value;
  const container = el("castMemberDetail");

  if (!membro) {
    container.innerHTML = "";
    return;
  }

  const doMembro = videos.filter((v) => participantesDoVideo(v, papelFiltro).some((p) => p.nome === membro));

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

function renderCastDashboard() {
  populateCastFilters();
  const videos = castFilteredVideos();
  renderCastRanking(videos);
  renderCastCombos(videos);
  renderCastMemberDetail(videos);
}

["castFiltroTipo", "castFiltroCompeticao", "castFiltroPapel", "castFiltroMembro"].forEach((id) => {
  el(id).addEventListener("change", () => {
    const videos = castFilteredVideos();
    renderCastRanking(videos);
    renderCastCombos(videos);
    renderCastMemberDetail(videos);
  });
});

carregarPessoas();
carregarCompeticoes();
carregarTiposConteudo().then(carregarVideos);
