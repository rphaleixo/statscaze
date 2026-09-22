// Transcrição via legendas públicas do YouTube (mesmo mecanismo do método
// "rápido" do script Python original). Sem fallback via yt-dlp — isso não
// roda dentro de um Cloudflare Worker.

const PREFERRED_LANGUAGES = ["pt", "pt-BR", "en"];

export function formatTimestamp(totalSeconds) {
  const safe = Math.max(0, totalSeconds || 0);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;

  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function pickCaptionTrack(tracks) {
  if (!tracks || tracks.length === 0) return null;

  for (const lang of PREFERRED_LANGUAGES) {
    const found = tracks.find((t) => t.languageCode === lang);
    if (found) return found;
  }

  return tracks[0];
}

function parseJson3(jsonText) {
  const data = JSON.parse(jsonText);
  const segments = [];

  for (const event of data.events || []) {
    if (event.tStartMs == null) continue;

    const text = (event.segs || []).map((seg) => seg.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!text) continue;

    segments.push({ timestamp: formatTimestamp(event.tStartMs / 1000), text });
  }

  return segments;
}

// Retorna { segments, method, error }
export async function extractTranscript(videoId) {
  let watchRes;

  try {
    watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
    });
  } catch (error) {
    return { segments: null, method: null, error: `Falha ao acessar a página do vídeo: ${error}` };
  }

  if (!watchRes.ok) {
    return { segments: null, method: null, error: `Página do vídeo retornou HTTP ${watchRes.status}.` };
  }

  const html = await watchRes.text();
  const match = html.match(/"captionTracks":(\[.*?\])/);

  if (!match) {
    return { segments: null, method: null, error: "Nenhuma legenda encontrada para este vídeo." };
  }

  let tracks;
  try {
    tracks = JSON.parse(match[1]);
  } catch (error) {
    return { segments: null, method: null, error: `Não consegui interpretar a lista de legendas: ${error}` };
  }

  const track = pickCaptionTrack(tracks);
  if (!track || !track.baseUrl) {
    return { segments: null, method: null, error: "Lista de legendas veio vazia." };
  }

  const captionUrl = track.baseUrl.includes("fmt=") ? track.baseUrl : `${track.baseUrl}&fmt=json3`;

  let captionRes;
  try {
    captionRes = await fetch(captionUrl);
  } catch (error) {
    return { segments: null, method: null, error: `Falha ao baixar a legenda: ${error}` };
  }

  if (!captionRes.ok) {
    return { segments: null, method: null, error: `Download da legenda retornou HTTP ${captionRes.status}.` };
  }

  const captionText = await captionRes.text();

  let segments;
  try {
    segments = parseJson3(captionText);
  } catch (error) {
    return { segments: null, method: null, error: `Falha ao interpretar a legenda: ${error}` };
  }

  if (!segments || segments.length === 0) {
    return { segments: null, method: null, error: "A legenda baixada estava vazia após a leitura." };
  }

  return { segments, method: `legenda-${track.languageCode || "?"}`, error: null };
}
