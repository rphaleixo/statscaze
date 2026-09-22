import {
  getChannelId,
  searchVideoIdsPage,
  getVideoDetails,
  getLiveChatMessageCount,
  TIPOS_VIDEO,
} from "./youtube.js";
import { extractTranscript } from "./transcript.js";
import {
  upsertVideoMetadata,
  updateVideoTranscript,
  updateClassificacao,
  getVideos,
  getVideoIdsPendingTranscript,
  getVideoTitlesUrls,
  PAPEIS,
  listPessoas,
  upsertPessoa,
  updatePessoa,
  deletePessoa,
  setParticipacoes,
  saveClassificacaoSugerida,
  aplicarClassificacaoSugerida,
  descartarClassificacaoSugerida,
  getCompeticoesConhecidas,
  getProgramasConhecidos,
  listCompeticoesCadastradas,
  createCompeticaoCadastrada,
  updateCompeticaoCadastrada,
  deleteCompeticaoCadastrada,
  listTiposConteudo,
  createTipoConteudo,
  arquivarTipoConteudo,
} from "./db.js";
import { sugerirClassificacao } from "./ai.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function handleSearch(url, env) {
  const channelId = url.searchParams.get("channelId");
  const publishedAfter = url.searchParams.get("publishedAfter");
  const publishedBefore = url.searchParams.get("publishedBefore");
  const pageToken = url.searchParams.get("pageToken") || undefined;

  if (!channelId || !publishedAfter) {
    return json({ error: "channelId e publishedAfter são obrigatórios." }, 400);
  }

  const { videoIds, nextPageToken } = await searchVideoIdsPage(
    channelId,
    publishedAfter,
    publishedBefore,
    env.YOUTUBE_API_KEY,
    pageToken
  );

  return json({ videoIds, nextPageToken });
}

async function handleChannel(url, env) {
  const handle = url.searchParams.get("handle");
  if (!handle) return json({ error: "Parâmetro 'handle' é obrigatório." }, 400);

  const channelId = await getChannelId(handle, env.YOUTUBE_API_KEY);
  return json({ channelId });
}

async function handleDetails(request, env) {
  const body = await request.json();
  const videoIds = (body.videoIds || []).slice(0, 50);
  const channelHandle = body.channelHandle || "";
  const tiposVideo = body.contentTypes || Object.keys(TIPOS_VIDEO);

  if (!videoIds.length) return json({ error: "videoIds vazio." }, 400);

  const videos = await getVideoDetails(videoIds, channelHandle, env.YOUTUBE_API_KEY);
  const saved = [];

  for (const video of videos) {
    if (!tiposVideo.includes(video.tipo_video)) continue;

    let mensagensChat = null;
    let chatError = null;

    if (video._live_chat_id) {
      const chatResult = await getLiveChatMessageCount(video._live_chat_id, env.YOUTUBE_API_KEY);
      mensagensChat = chatResult.total;
      chatError = chatResult.error;
    }

    const row = {
      video_id: video.video_id,
      canal: video.canal,
      tipo_video: video.tipo_video,
      titulo: video.titulo,
      descricao: video.descricao,
      data_publicacao: video.data_publicacao,
      duracao_segundos: video.duracao_segundos,
      views: video.views,
      comentarios: video.comentarios,
      mensagens_chat: mensagensChat,
      url: video.url,
      thumbnail_url: video.thumbnail_url,
      coletado_em: new Date().toISOString(),
    };

  await upsertVideoMetadata(env.DB, row);
    saved.push({ video_id: video.video_id, titulo: video.titulo, tipo_video: video.tipo_video, chat_error: chatError });
  }

  return json({ saved });
}

async function handleTranscripts(request, env) {
  const body = await request.json();
  const videoIds = (body.videoIds || []).slice(0, 10);

  if (!videoIds.length) return json({ error: "videoIds vazio." }, 400);

  const titles = await getVideoTitlesUrls(env.DB, videoIds);
  const results = [];

  for (const videoId of videoIds) {
    const { segments, method, error } = await extractTranscript(videoId);
    const titulo = titles[videoId]?.titulo || videoId;

    await updateVideoTranscript(env.DB, videoId, {
      transcricao_sucesso: segments ? 1 : 0,
      transcricao_metodo: method,
      transcricao_trechos: segments ? segments.length : 0,
      transcricao_completa: segments ? segments.map((s) => s.text).join(" ") : null,
      log_transcricao: error || `Sucesso: ${segments.length} trechos (${method}).`,
    });

    results.push({ video_id: videoId, titulo, sucesso: Boolean(segments), erro: error });
  }

  return json({ results });
}

async function handlePendingTranscripts(url, env) {
  const dateFrom = url.searchParams.get("date_from") || undefined;
  const dateTo = url.searchParams.get("date_to") || undefined;
  const contentTypes = url.searchParams.get("tipos")?.split(",").filter(Boolean);

  const videoIds = await getVideoIdsPendingTranscript(env.DB, { dateFrom, dateTo, contentTypes });
  return json({ videoIds });
}

async function handleVideos(url, env) {
  const dateFrom = url.searchParams.get("date_from") || undefined;
  const dateTo = url.searchParams.get("date_to") || undefined;
  const contentTypes = url.searchParams.get("tipos")?.split(",").filter(Boolean);

  const videos = await getVideos(env.DB, { dateFrom, dateTo, contentTypes });
  return json({ videos });
}

async function handleExportCsv(url, env) {
  const dateFrom = url.searchParams.get("date_from") || undefined;
  const dateTo = url.searchParams.get("date_to") || undefined;
  const contentTypes = url.searchParams.get("tipos")?.split(",").filter(Boolean);

  const videos = await getVideos(env.DB, { dateFrom, dateTo, contentTypes });

  const columns = [
    "video_id", "canal", "tipo_video", "tipo_conteudo", "titulo", "data_publicacao",
    "duracao_segundos", "views", "comentarios", "mensagens_chat",
    "competicao", "programa", "elenco", "transcricao_sucesso", "url", "thumbnail_url",
  ];

  const lines = [columns.join(",")];
  for (const video of videos) {
    const row = columns.map((col) => {
      if (col === "elenco") {
        return csvEscape((video.participacoes || []).map((p) => `${p.nome} (${PAPEIS[p.papel] || p.papel})`).join("; "));
      }
      return csvEscape(video[col]);
    });
    lines.push(row.join(","));
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="videos_cazetv.csv"',
    },
  });
}

// body: { video_id, competicao, programa, tipo_conteudo, participacoes: [{ nome, papel }] }
async function handleEnrich(request, env) {
  const body = await request.json();
  const { video_id: videoId, competicao, programa, tipo_conteudo: tipoConteudo, participacoes } = body;

  if (!videoId) return json({ error: "video_id é obrigatório." }, 400);

  await updateClassificacao(env.DB, videoId, { competicao, programa, tipoConteudo });
  if (Array.isArray(participacoes)) {
    await setParticipacoes(env.DB, videoId, participacoes);
  }

  return json({ ok: true });
}

// Importação em lote por CSV, no formato "uma linha por pessoa": colunas
// video_id, tipo_conteudo (nome cadastrado na aba Tipo de Conteúdo,
// opcional), competicao (opcional), programa (opcional), nome, papel
// (narrador/comentarista/reporter/apresentador). Repita
// tipo_conteudo/competicao/programa em cada linha do mesmo vídeo, ou deixe
// só na primeira.
// Outras colunas são ignoradas. Linhas com video_id desconhecido são
// reportadas mas não travam o restante da importação.
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];

  const parseLine = (line) => {
    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (inQuotes) {
        if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (char === '"') inQuotes = false;
        else current += char;
      } else if (char === '"') inQuotes = true;
      else if (char === ",") { cells.push(current); current = ""; }
      else current += char;
    }
    cells.push(current);
    return cells;
  };

  const header = parseLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row = {};
    header.forEach((key, i) => { row[key] = (cells[i] || "").trim(); });
    return row;
  });
}

async function handleEnrichImport(request, env) {
  const csvText = await request.text();
  const rows = parseCsv(csvText);

  if (!rows.length) return json({ error: "CSV vazio ou ilegível." }, 400);
  if (!("video_id" in rows[0])) {
    return json({ error: "O CSV precisa ter uma coluna 'video_id'." }, 400);
  }

  const papeisValidos = new Set(Object.keys(PAPEIS));
  const tiposConteudo = await listTiposConteudo(env.DB, { incluirArquivados: true });
  const nomePorTipoConteudoLower = new Map(tiposConteudo.map((t) => [t.nome.toLowerCase(), t.nome]));

  // Agrupa as linhas por vídeo: cada vídeo pode ter várias linhas (uma por pessoa).
  const porVideo = new Map();
  for (const row of rows) {
    const videoId = row.video_id?.trim();
    if (!videoId) continue;

    if (!porVideo.has(videoId)) porVideo.set(videoId, { participacoes: [] });
    const entry = porVideo.get(videoId);

    if (row.competicao?.trim()) entry.competicao = row.competicao.trim();
    if (row.programa?.trim()) entry.programa = row.programa.trim();

    const tipoConteudoNome = nomePorTipoConteudoLower.get(row.tipo_conteudo?.trim().toLowerCase());
    if (tipoConteudoNome) entry.tipoConteudo = tipoConteudoNome;

    if (row.nome?.trim()) {
      const papel = (row.papel || "comentarista").trim().toLowerCase();
      if (papeisValidos.has(papel)) entry.participacoes.push({ nome: row.nome.trim(), papel });
    }
  }

  let atualizados = 0;
  const naoEncontrados = [];

  for (const [videoId, entry] of porVideo) {
    const existing = await env.DB.prepare("SELECT tipo_conteudo FROM videos WHERE video_id = ?").bind(videoId).first();
    if (!existing) {
      naoEncontrados.push(videoId);
      continue;
    }

    if (entry.competicao || entry.programa || entry.tipoConteudo) {
      await updateClassificacao(env.DB, videoId, entry);
    }
    if (entry.participacoes.length) {
      await setParticipacoes(env.DB, videoId, entry.participacoes);
    }
    atualizados++;
  }

  return json({ atualizados, naoEncontrados });
}

// ---------- elenco (pessoas cadastradas) ----------

async function handleListPessoas(env) {
  const pessoas = await listPessoas(env.DB);
  return json({ pessoas, papeis: PAPEIS });
}

// body: { nome, apelidos: ["..."], papeis_padrao: ["comentarista", ...] }
async function handleCreatePessoa(request, env) {
  const body = await request.json();
  if (!body.nome?.trim()) return json({ error: "nome é obrigatório." }, 400);

  const id = await upsertPessoa(env.DB, body.nome, { apelidos: body.apelidos, papeisPadrao: body.papeis_padrao });
  return json({ id });
}

async function handleUpdatePessoa(request, env) {
  const body = await request.json();
  if (!body.id || !body.nome?.trim()) return json({ error: "id e nome são obrigatórios." }, 400);

  await updatePessoa(env.DB, body.id, {
    nome: body.nome.trim(),
    apelidos: body.apelidos,
    papeisPadrao: body.papeis_padrao,
  });
  return json({ ok: true });
}

async function handleDeletePessoa(request, env) {
  const body = await request.json();
  if (!body.id) return json({ error: "id é obrigatório." }, 400);

  await deletePessoa(env.DB, body.id);
  return json({ ok: true });
}

// ---------- competições cadastradas (lista de referência) ----------

async function handleListCompeticoes(env) {
  const competicoes = await listCompeticoesCadastradas(env.DB);
  return json({ competicoes });
}

async function handleCreateCompeticao(request, env) {
  const body = await request.json();
  if (!body.nome?.trim()) return json({ error: "nome é obrigatório." }, 400);

  const id = await createCompeticaoCadastrada(env.DB, body.nome);
  return json({ id });
}

async function handleUpdateCompeticao(request, env) {
  const body = await request.json();
  if (!body.id || !body.nome?.trim()) return json({ error: "id e nome são obrigatórios." }, 400);

  await updateCompeticaoCadastrada(env.DB, body.id, body.nome);
  return json({ ok: true });
}

async function handleDeleteCompeticao(request, env) {
  const body = await request.json();
  if (!body.id) return json({ error: "id é obrigatório." }, 400);

  await deleteCompeticaoCadastrada(env.DB, body.id);
  return json({ ok: true });
}

// ---------- tipos de conteúdo (lista editável, com arquivamento) ----------

async function handleListTiposConteudo(env) {
  const tipos = await listTiposConteudo(env.DB, { incluirArquivados: true });
  return json({ tipos, papeis: PAPEIS });
}

// body: { nome }
async function handleCreateTipoConteudo(request, env) {
  const body = await request.json();
  if (!body.nome?.trim()) return json({ error: "nome é obrigatório." }, 400);

  const id = await createTipoConteudo(env.DB, body.nome);
  return json({ id });
}

// body: { id, arquivado: true|false }
async function handleArquivarTipoConteudo(request, env) {
  const body = await request.json();
  if (!body.id) return json({ error: "id é obrigatório." }, 400);

  await arquivarTipoConteudo(env.DB, body.id, body.arquivado);
  return json({ ok: true });
}

// ---------- sugestão de classificação (tipo de conteúdo/competição/programa/elenco) via IA ----------

async function handleAiSugerir(request, env) {
  const body = await request.json();
  const videoIds = (body.videoIds || []).slice(0, 5);

  if (!videoIds.length) return json({ error: "videoIds vazio." }, 400);
  if (!env.AI) return json({ error: "IA (Workers AI) não está configurada neste Worker." }, 500);

  const competicoesConhecidas = await getCompeticoesConhecidas(env.DB);
  const programasConhecidas = await getProgramasConhecidos(env.DB);
  const pessoasConhecidas = await listPessoas(env.DB);
  const tiposConteudoConhecidos = (await listTiposConteudo(env.DB, { incluirArquivados: false }))
    .map((t) => t.nome);
  const titles = await getVideoTitlesUrls(env.DB, videoIds);
  const rows = await env.DB
    .prepare(`SELECT video_id, titulo, descricao, transcricao_completa FROM videos WHERE video_id IN (${videoIds.map(() => "?").join(",")})`)
    .bind(...videoIds)
    .all();

  const results = [];

  for (const video of rows.results) {
    const { tipoConteudo, competicao, programa, confianca, participantes, erro } = await sugerirClassificacao(env.AI, {
      titulo: video.titulo,
      descricao: video.descricao,
      transcricao: video.transcricao_completa,
      competicoesConhecidas,
      programasConhecidas,
      pessoasConhecidas,
      tiposConteudoConhecidos,
    });

    if (tipoConteudo || competicao || programa) {
      await saveClassificacaoSugerida(env.DB, video.video_id, { tipoConteudo, competicao, programa, confianca });
    }

    results.push({
      video_id: video.video_id,
      titulo: titles[video.video_id]?.titulo || video.titulo,
      tipo_conteudo_sugerido: tipoConteudo,
      competicao_sugerida: competicao,
      programa_sugerido: programa,
      confianca,
      participantes_sugeridos: participantes || [],
      erro,
    });
  }

  return json({ results });
}

async function handleAiAplicarSugestao(request, env) {
  const body = await request.json();
  if (!body.video_id) return json({ error: "video_id é obrigatório." }, 400);

  await aplicarClassificacaoSugerida(env.DB, body.video_id);
  return json({ ok: true });
}

async function handleAiDescartarSugestao(request, env) {
  const body = await request.json();
  if (!body.video_id) return json({ error: "video_id é obrigatório." }, 400);

  await descartarClassificacaoSugerida(env.DB, body.video_id);
  return json({ ok: true });
}

async function autoCollect(env, days = 2) {
  const handle = env.CHANNEL_HANDLE;
  if (!handle || !env.YOUTUBE_API_KEY) return;

  const channelId = await getChannelId(handle, env.YOUTUBE_API_KEY);
  const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();

  let pageToken;
  const allIds = [];

  do {
    const page = await searchVideoIdsPage(channelId, publishedAfter, null, env.YOUTUBE_API_KEY, pageToken);
    allIds.push(...page.videoIds);
    pageToken = page.nextPageToken;
  } while (pageToken);

  for (let i = 0; i < allIds.length; i += 50) {
    const batch = allIds.slice(i, i + 50);
    const videos = await getVideoDetails(batch, handle, env.YOUTUBE_API_KEY);

    for (const video of videos) {
      let mensagensChat = null;
      if (video._live_chat_id) {
        const chatResult = await getLiveChatMessageCount(video._live_chat_id, env.YOUTUBE_API_KEY);
        mensagensChat = chatResult.total;
      }

      await upsertVideoMetadata(env.DB, {
        video_id: video.video_id,
        canal: video.canal,
        tipo_video: video.tipo_video,
        titulo: video.titulo,
        descricao: video.descricao,
        data_publicacao: video.data_publicacao,
        duracao_segundos: video.duracao_segundos,
        views: video.views,
        comentarios: video.comentarios,
        mensagens_chat: mensagensChat,
        url: video.url,
        thumbnail_url: video.thumbnail_url,
        coletado_em: new Date().toISOString(),
      });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/channel" && request.method === "GET") {
        return await handleChannel(url, env);
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        return await handleSearch(url, env);
      }
      if (url.pathname === "/api/details" && request.method === "POST") {
        return await handleDetails(request, env);
      }
      if (url.pathname === "/api/transcripts" && request.method === "POST") {
        return await handleTranscripts(request, env);
      }
      if (url.pathname === "/api/transcripts/pending" && request.method === "GET") {
        return await handlePendingTranscripts(url, env);
      }
      if (url.pathname === "/api/videos" && request.method === "GET") {
        return await handleVideos(url, env);
      }
      if (url.pathname === "/api/export.csv" && request.method === "GET") {
        return await handleExportCsv(url, env);
      }
      if (url.pathname === "/api/enrich" && request.method === "POST") {
        return await handleEnrich(request, env);
      }
      if (url.pathname === "/api/enrich/import" && request.method === "POST") {
        return await handleEnrichImport(request, env);
      }
      if (url.pathname === "/api/pessoas" && request.method === "GET") {
        return await handleListPessoas(env);
      }
      if (url.pathname === "/api/pessoas" && request.method === "POST") {
        return await handleCreatePessoa(request, env);
      }
      if (url.pathname === "/api/pessoas/update" && request.method === "POST") {
        return await handleUpdatePessoa(request, env);
      }
      if (url.pathname === "/api/pessoas/delete" && request.method === "POST") {
        return await handleDeletePessoa(request, env);
      }
      if (url.pathname === "/api/competicoes" && request.method === "GET") {
        return await handleListCompeticoes(env);
      }
      if (url.pathname === "/api/competicoes" && request.method === "POST") {
        return await handleCreateCompeticao(request, env);
      }
      if (url.pathname === "/api/competicoes/update" && request.method === "POST") {
        return await handleUpdateCompeticao(request, env);
      }
      if (url.pathname === "/api/competicoes/delete" && request.method === "POST") {
        return await handleDeleteCompeticao(request, env);
      }
      if (url.pathname === "/api/tipos-conteudo" && request.method === "GET") {
        return await handleListTiposConteudo(env);
      }
      if (url.pathname === "/api/tipos-conteudo" && request.method === "POST") {
        return await handleCreateTipoConteudo(request, env);
      }
      if (url.pathname === "/api/tipos-conteudo/arquivar" && request.method === "POST") {
        return await handleArquivarTipoConteudo(request, env);
      }
      if (url.pathname === "/api/ai/sugerir" && request.method === "POST") {
        return await handleAiSugerir(request, env);
      }
      if (url.pathname === "/api/ai/aplicar-sugestao" && request.method === "POST") {
        return await handleAiAplicarSugestao(request, env);
      }
      if (url.pathname === "/api/ai/descartar-sugestao" && request.method === "POST") {
        return await handleAiDescartarSugestao(request, env);
      }
    } catch (error) {
      return json({ error: String(error?.message || error) }, 500);
    }

    // Qualquer outra rota cai nos arquivos estáticos em /public (binding "ASSETS").
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(autoCollect(env));
  },
};
