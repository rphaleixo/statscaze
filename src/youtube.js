// Chamadas à YouTube Data API v3 — equivalente ao topo de coletor.py

const API_BASE = "https://www.googleapis.com/youtube/v3";

// Formato técnico do vídeo (vindo da própria API do YouTube) — não confundir
// com a classificação editorial (transmissão/programa/especial), que é
// escolhida manualmente ou sugerida pela IA.
export const TIPOS_VIDEO = {
  live: "Live",
  short: "Short",
  video: "Vídeo normal",
};

export async function getChannelId(handle, apiKey) {
  const url = `${API_BASE}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Erro ao buscar canal: ${data.error?.message || res.statusText}`);
  }

  const items = data.items || [];
  if (items.length === 0) {
    throw new Error(`Não encontrei nenhum canal com o handle '@${handle}'.`);
  }

  return items[0].id;
}

// Uma página de busca por vídeos do canal no período. Retorna { videoIds, nextPageToken }.
export async function searchVideoIdsPage(channelId, publishedAfter, publishedBefore, apiKey, pageToken) {
  const params = new URLSearchParams({
    part: "id",
    channelId,
    type: "video",
    order: "date",
    publishedAfter,
    maxResults: "50",
    key: apiKey,
  });

  if (publishedBefore) params.set("publishedBefore", publishedBefore);
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(`${API_BASE}/search?${params.toString()}`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Erro na busca de vídeos: ${data.error?.message || res.statusText}`);
  }

  const videoIds = (data.items || []).map((item) => item.id.videoId);
  return { videoIds, nextPageToken: data.nextPageToken || null };
}

export function parseIso8601Duration(duration) {
  if (!duration) return 0;

  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);

  return hours * 3600 + minutes * 60 + seconds;
}

export function classifyContentType(snippet, contentDetails, liveDetails) {
  const isLiveNow = snippet.liveBroadcastContent === "live";
  const wasLive = Boolean(liveDetails?.actualStartTime || liveDetails?.actualEndTime);

  if (isLiveNow || wasLive) return "live";

  const durationSeconds = parseIso8601Duration(contentDetails?.duration);
  if (durationSeconds && durationSeconds <= 60) return "short";

  return "video";
}

// Detalhes de até 50 vídeos por chamada (limite da API).
export async function getVideoDetails(videoIds, channelHandle, apiKey) {
  const params = new URLSearchParams({
    part: "snippet,statistics,contentDetails,liveStreamingDetails",
    id: videoIds.join(","),
    key: apiKey,
  });

  const res = await fetch(`${API_BASE}/videos?${params.toString()}`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Erro ao buscar detalhes dos vídeos: ${data.error?.message || res.statusText}`);
  }

  return (data.items || []).map((item) => {
    const snippet = item.snippet || {};
    const statistics = item.statistics || {};
    const contentDetails = item.contentDetails || {};
    const liveDetails = item.liveStreamingDetails || {};

    const publishedAt = liveDetails.actualStartTime || snippet.publishedAt;
    const tipoVideo = classifyContentType(snippet, contentDetails, liveDetails);

    return {
      video_id: item.id,
      canal: channelHandle,
      tipo_video: tipoVideo,
      titulo: snippet.title || "",
      descricao: snippet.description || "",
      data_publicacao: publishedAt,
      duracao_segundos: parseIso8601Duration(contentDetails.duration),
      views: parseInt(statistics.viewCount || "0", 10),
      comentarios: statistics.commentCount != null ? parseInt(statistics.commentCount, 10) : null,
      url: `https://www.youtube.com/watch?v=${item.id}`,
      _live_chat_id: liveDetails.activeLiveChatId || null,
    };
  });
}

// Só funciona enquanto a live está acontecendo. Limitado a poucas páginas
// por chamada para não estourar o limite de subrequests do Worker.
export async function getLiveChatMessageCount(liveChatId, apiKey, maxPages = 20) {
  let total = 0;
  let pageToken = null;

  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      liveChatId,
      part: "id",
      maxResults: "200",
      key: apiKey,
    });
    if (pageToken) params.set("pageToken", pageToken);

    try {
      const res = await fetch(`${API_BASE}/liveChat/messages?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        return { total: total || null, error: data.error?.message || res.statusText };
      }
      total += (data.items || []).length;
      pageToken = data.nextPageToken || null;
      if (!pageToken) return { total, error: null };
    } catch (error) {
      return { total: total || null, error: String(error) };
    }
  }

  return { total, error: `Contagem parcial (parou em ${maxPages} páginas por chamada).` };
}
