const CONTENT_TYPE_LABELS = { live: "Live", short: "Short", video: "Vídeo normal" };

const el = (id) => document.getElementById(id);

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

el("dateFrom").value = daysAgo(30);
el("dateTo").value = today();

function selectedContentTypes() {
  return Array.from(document.querySelectorAll('.sidebar input[type="checkbox"][value]'))
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

// ---------- progresso / log ----------

const progressBar = el("progressBar");
const progressFill = progressBar.querySelector(".progress-fill");
const progressText = el("progressText");
const logArea = el("logArea");

function resetExecucao() {
  progressBar.classList.add("active");
  progressFill.style.width = "0%";
  progressText.textContent = "";
  logArea.classList.add("active");
  logArea.textContent = "";
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
    alert("Preencha canal, período e pelo menos um tipo de conteúdo.");
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
    do {
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
    for (let i = 0; i < allIds.length; i += 50) {
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
        log(`[${saved}] (${CONTENT_TYPE_LABELS[item.tipo_conteudo] || item.tipo_conteudo}) ${item.titulo}`);
        if (item.chat_error) log(`  aviso na contagem do chat: ${item.chat_error}`);
      }
    }

    setProgress(allIds.length, allIds.length, "Mapeamento");
    statusMsg(`Mapeamento concluído: ${saved} vídeo(s).`, "success");
    await carregarVideos();
  } catch (error) {
    statusMsg(`Erro durante o mapeamento: ${error.message}`, "error");
  } finally {
    el("btnMapear").disabled = false;
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

    for (let i = 0; i < videoIds.length; i += 5) {
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

    setProgress(videoIds.length, videoIds.length, "Transcrição");
    statusMsg(`Transcrição concluída: ${processed} vídeo(s) processados.`, "success");
    await carregarVideos();
  } catch (error) {
    statusMsg(`Erro durante a transcrição: ${error.message}`, "error");
  } finally {
    el("btnTranscrever").disabled = false;
  }
});

// ---------- carregar / exibir dados ----------

let videosCache = [];

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
  renderEnrichTable();
}

function renderVideosTable() {
  el("videosCount").textContent = `${videosCache.length} vídeo(s) no período/tipo selecionado`;
  const tbody = document.querySelector("#videosTable tbody");
  tbody.innerHTML = "";

  for (const v of videosCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${CONTENT_TYPE_LABELS[v.tipo_conteudo] || v.tipo_conteudo || ""}</td>
      <td class="wrap">${v.titulo || ""}</td>
      <td>${(v.data_publicacao || "").slice(0, 10)}</td>
      <td>${formatDuration(v.duracao_segundos)}</td>
      <td>${v.views ?? ""}</td>
      <td>${v.comentarios ?? ""}</td>
      <td>${v.mensagens_chat ?? ""}</td>
      <td>${v.competicao || ""}</td>
      <td>${(v.elenco || []).join(", ")}</td>
      <td>${v.transcricao_sucesso ? "✓" : ""}</td>
      <td><a href="${v.url}" target="_blank" rel="noopener">abrir</a></td>
    `;
    tbody.appendChild(tr);
  }
}

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

function renderDashboards() {
  const metricsEl = el("metrics");

  if (videosCache.length === 0) {
    metricsEl.innerHTML = `<p class="hint">Sem dados para mostrar ainda. Rode o mapeamento na barra lateral.</p>`;
    el("chartTipos").innerHTML = "";
    el("chartCompeticao").innerHTML = "";
    document.querySelector("#top10Table tbody").innerHTML = "";
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
    const label = CONTENT_TYPE_LABELS[v.tipo_conteudo] || v.tipo_conteudo || "?";
    porTipo[label] = (porTipo[label] || 0) + 1;
  }
  renderBarChart(el("chartTipos"), Object.entries(porTipo).map(([label, value]) => ({ label, value })));

  const top10 = [...videosCache].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);
  document.querySelector("#top10Table tbody").innerHTML = top10
    .map(
      (v) => `<tr>
        <td class="wrap">${v.titulo || ""}</td>
        <td>${CONTENT_TYPE_LABELS[v.tipo_conteudo] || ""}</td>
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
}

function renderEnrichTable() {
  const tbody = document.querySelector("#enrichTable tbody");
  tbody.innerHTML = "";

  for (const v of videosCache) {
    const tr = document.createElement("tr");
    const elencoStr = (v.elenco || []).join(", ");

    tr.innerHTML = `
      <td class="wrap">${v.titulo || ""}</td>
      <td><input type="text" value="${(v.competicao || "").replace(/"/g, "&quot;")}" data-field="competicao" /></td>
      <td><input type="text" value="${elencoStr.replace(/"/g, "&quot;")}" data-field="elenco" /></td>
      <td><button class="save-row">Salvar</button></td>
    `;

    tr.querySelector(".save-row").addEventListener("click", async () => {
      const competicao = tr.querySelector('[data-field="competicao"]').value.trim();
      const elenco = tr
        .querySelector('[data-field="elenco"]')
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: v.video_id, competicao: competicao || null, elenco }),
      });

      v.competicao = competicao;
      v.elenco = elenco;
      renderVideosTable();
      renderDashboards();
    });

    tbody.appendChild(tr);
  }
}

carregarVideos();
