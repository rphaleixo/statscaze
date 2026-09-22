import {
  getChannelId,
  searchVideoIdsPage,
  getVideoDetails,
  getLiveChatMessageCount,
  CONTENT_TYPES,
} from "./youtube.js";
import { extractTranscript } from "./transcript.js";
import {
  upsertVideoMetadata,
  updateVideoTranscript,
  updateEnrichment,
  getVideos,
  getVideoIdsPendingTranscript,
  getVideoTitlesUrls,
} from "./db.js";

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
  const contentTypes = body.contentTypes || Object.keys(CONTENT_TYPES);

  if (!videoIds.length) return json({ error: "videoIds vazio." }, 400);

  const videos = await getVideoDetails(videoIds, channelHandle, env.YOUTUBE_API_KEY);
  const saved = [];

  for (const video of videos) {
    if (!contentTypes.includes(video.tipo_conteudo)) continue;

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
      tipo_conteudo: video.tipo_conteudo,
      titulo: video.titulo,
      descricao: video.descricao,
      data_publicacao: video.data_publicacao,
      duracao_segundos: video.duracao_segundos,
      views: video.views,
      comentarios: video.comentarios,
      mensagens_chat: mensagensChat,
      url: video.url,
      coletado_em: new Date().toISOString(),
    };

    await upsertVideoMetadata(env.DB, row);
    saved.push({ video_id: video.video_id, titulo: video.titulo, tipo_conteudo: video.tipo_conteudo, chat_error: chatError });
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
    "video_id", "canal", "tipo_conteudo", "titulo", "data_publicacao",
    "duracao_segundos", "views", "comentarios", "mensagens_chat",
    "competicao", "narrador",
    "comentarista_1", "comentarista_2", "comentarista_3", "comentarista_4", "comentarista_5",
    "transcricao_sucesso", "url",
  ];

  const lines = [columns.join(",")];
  for (const video of videos) {
    const row = columns.map((col) => csvEscape(video[col]));
    lines.push(row.join(","));
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="videos_cazetv.csv"',
    },
  });
}

async function handleEnrich(request, env) {
  const body = await request.json();
  const { video_id: videoId, competicao, narrador, comentaristas } = body;

  if (!videoId) return json({ error: "video_id é obrigatório." }, 400);

  await updateEnrichment(env.DB, videoId, competicao, { narrador, comentaristas });
  return json({ ok: true });
}

// Importação em lote por CSV. Colunas esperadas: video_id, competicao,
// narrador, comentarista_1, comentarista_2, comentarista_3, comentarista_4,
// comentarista_5. Outras colunas são ignoradas. Linhas com video_id
// desconhecido são reportadas mas não travam o restante da importação.
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

  let atualizados = 0;
  const naoEncontrados = [];

  for (const row of rows) {
    const videoId = row.video_id;
    if (!videoId) continue;

    const exists = await env.DB.prepare("SELECT 1 FROM videos WHERE video_id = ?").bind(videoId).first();
    if (!exists) {
      naoEncontrados.push(videoId);
      continue;
    }

    const comentaristas = [1, 2, 3, 4, 5]
      .map((n) => row[`comentarista_${n}`])
      .filter(Boolean);

    await updateEnrichment(env.DB, videoId, row.competicao || null, {
      narrador: row.narrador || null,
      comentaristas,
    });
    atualizados++;
  }

  return json({ atualizados, naoEncontrados });
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
        tipo_conteudo: video.tipo_conteudo,
        titulo: video.titulo,
        descricao: video.descricao,
        data_publicacao: video.data_publicacao,
        duracao_segundos: video.duracao_segundos,
        views: video.views,
        comentarios: video.comentarios,
        mensagens_chat: mensagensChat,
        url: video.url,
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
