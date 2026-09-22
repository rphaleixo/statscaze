"""
Núcleo de coleta de dados do YouTube — usado pela interface (app.py).

Responsabilidades deste módulo:
  - Buscar vídeos de um canal (lives, shorts e vídeos normais) num
    período, classificando o tipo de conteúdo de cada um.
  - Buscar título, descrição, data de publicação, views, comentários e
    (quando disponível) mensagens de chat.
  - Extrair a transcrição de cada vídeo, em dois níveis (rápido e
    reserva), igual ao script anterior.
  - Guardar tudo em um banco SQLite local (youtube_data.db), para que
    os dados fiquem salvos entre execuções e possam ser atualizados aos
    poucos (sem perder o que já foi coletado).
  - Expor uma função (update_enrichment) para receber, depois, a
    competição e o elenco de cada vídeo — informação que será extraída
    por uma IA a partir da descrição e da transcrição. O banco já tem
    colunas prontas para isso; elas só ficam vazias até serem
    preenchidas.
"""

import json
import os
import re
import sqlite3
import tempfile
import time
from datetime import datetime, timezone

import requests

API_BASE = "https://www.googleapis.com/youtube/v3"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "youtube_data.db")
TRANSCRIPTS_DIR = os.path.join(BASE_DIR, "transcricoes")

PREFERRED_LANGUAGES = ["pt", "pt-BR", "en"]

CONTENT_TYPES = {
    "live": "Live",
    "short": "Short",
    "video": "Vídeo normal",
}


# =========================================================
# BANCO DE DADOS
# =========================================================

def get_connection() -> sqlite3.Connection:

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():

    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS videos (
                video_id TEXT PRIMARY KEY,
                canal TEXT,
                tipo_conteudo TEXT,
                titulo TEXT,
                descricao TEXT,
                data_publicacao TEXT,
                duracao_segundos INTEGER,
                views INTEGER,
                comentarios INTEGER,
                mensagens_chat INTEGER,
                url TEXT,
                transcricao_sucesso INTEGER,
                transcricao_metodo TEXT,
                transcricao_trechos INTEGER,
                transcricao_completa TEXT,
                arquivo_transcricao TEXT,
                log_transcricao TEXT,
                competicao TEXT,
                elenco TEXT,
                enriquecido_em TEXT,
                coletado_em TEXT
            )
        """)
        conn.commit()


def upsert_video_metadata(row: dict):
    """
    Fase 1 (mapeamento): grava só os dados básicos do vídeo — título,
    descrição, data, duração, views, comentários, chat, tipo.

    Nunca toca nas colunas de transcrição nem nas de enriquecimento
    (competicao/elenco), sejam elas novas ou já existentes — essas
    ficam por conta de update_video_transcript e update_enrichment,
    respectivamente. Assim, rodar o mapeamento de novo (para atualizar
    views, por exemplo) nunca apaga uma transcrição já extraída.
    """

    with get_connection() as conn:

        conn.execute("""
            INSERT INTO videos (
                video_id, canal, tipo_conteudo, titulo, descricao,
                data_publicacao, duracao_segundos, views, comentarios,
                mensagens_chat, url, coletado_em
            ) VALUES (
                :video_id, :canal, :tipo_conteudo, :titulo, :descricao,
                :data_publicacao, :duracao_segundos, :views, :comentarios,
                :mensagens_chat, :url, :coletado_em
            )
            ON CONFLICT(video_id) DO UPDATE SET
                canal=excluded.canal,
                tipo_conteudo=excluded.tipo_conteudo,
                titulo=excluded.titulo,
                descricao=excluded.descricao,
                data_publicacao=excluded.data_publicacao,
                duracao_segundos=excluded.duracao_segundos,
                views=excluded.views,
                comentarios=excluded.comentarios,
                mensagens_chat=excluded.mensagens_chat,
                url=excluded.url,
                coletado_em=excluded.coletado_em
        """, row)

        conn.commit()


def update_video_transcript(
    video_id: str,
    transcricao_sucesso: int,
    transcricao_metodo: str | None,
    transcricao_trechos: int,
    transcricao_completa: str | None,
    arquivo_transcricao: str | None,
    log_transcricao: str | None,
):
    """Fase 2 (transcrição): grava só as colunas de transcrição de um vídeo."""

    with get_connection() as conn:
        conn.execute(
            """
            UPDATE videos
            SET transcricao_sucesso = ?, transcricao_metodo = ?,
                transcricao_trechos = ?, transcricao_completa = ?,
                arquivo_transcricao = ?, log_transcricao = ?
            WHERE video_id = ?
            """,
            (
                transcricao_sucesso, transcricao_metodo, transcricao_trechos,
                transcricao_completa, arquivo_transcricao, log_transcricao,
                video_id,
            ),
        )
        conn.commit()


def update_enrichment(video_id: str, competicao: str | None, elenco: list[str] | None):
    """
    Ponto de entrada para gravar a informação complementar (competição
    e elenco) de um vídeo, depois de processada por uma IA (ou editada
    manualmente pela aba "Enriquecimento" da interface).

    elenco é uma lista de nomes (ex.: ["Fulano", "Time X", "Time Y"]);
    é guardada como JSON no banco e desserializada ao ler.
    """

    with get_connection() as conn:
        conn.execute(
            """
            UPDATE videos
            SET competicao = ?, elenco = ?, enriquecido_em = ?
            WHERE video_id = ?
            """,
            (
                competicao,
                json.dumps(elenco, ensure_ascii=False) if elenco else None,
                datetime.now(timezone.utc).isoformat(),
                video_id,
            ),
        )
        conn.commit()


def get_videos_df(date_from=None, date_to=None, content_types=None):
    """Devolve os vídeos salvos no banco, já filtrados, como DataFrame pandas."""

    import pandas as pd

    query = "SELECT * FROM videos WHERE 1=1"
    params = []

    if date_from:
        query += " AND date(data_publicacao) >= date(?)"
        params.append(str(date_from))

    if date_to:
        query += " AND date(data_publicacao) <= date(?)"
        params.append(str(date_to))

    if content_types:
        placeholders = ",".join("?" for _ in content_types)
        query += f" AND tipo_conteudo IN ({placeholders})"
        params.extend(content_types)

    query += " ORDER BY data_publicacao DESC"

    with get_connection() as conn:
        df = pd.read_sql_query(query, conn, params=params)

    if not df.empty:
        df["elenco"] = df["elenco"].apply(
            lambda value: json.loads(value) if value else []
        )

    return df


# =========================================================
# YOUTUBE DATA API — canal, busca e detalhes
# =========================================================

def get_channel_id(handle: str, api_key: str) -> str:

    response = requests.get(
        f"{API_BASE}/channels",
        params={"part": "id", "forHandle": handle, "key": api_key},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()

    items = data.get("items", [])
    if not items:
        raise RuntimeError(
            f"Não encontrei nenhum canal com o handle '@{handle}'. "
            "Confira se o nome está certo (é o que aparece depois do @ na URL)."
        )

    return items[0]["id"]


def search_video_ids(channel_id, published_after, published_before, api_key) -> list[str]:
    """
    Busca TODOS os vídeos do canal no período (lives, shorts e vídeos
    normais juntos) — a classificação por tipo acontece depois, com
    os detalhes de cada vídeo (get_video_details).
    """

    video_ids = []
    page_token = None

    while True:

        params = {
            "part": "id",
            "channelId": channel_id,
            "type": "video",
            "order": "date",
            "publishedAfter": published_after,
            "maxResults": 50,
            "key": api_key,
        }

        if published_before:
            params["publishedBefore"] = published_before

        if page_token:
            params["pageToken"] = page_token

        response = requests.get(f"{API_BASE}/search", params=params, timeout=30)
        response.raise_for_status()
        data = response.json()

        for item in data.get("items", []):
            video_ids.append(item["id"]["videoId"])

        page_token = data.get("nextPageToken")

        if not page_token:
            break

    return video_ids


def parse_iso8601_duration(duration: str) -> int:
    """Converte 'PT1H2M3S' em segundos totais."""

    if not duration:
        return 0

    match = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration)

    if not match:
        return 0

    hours, minutes, seconds = (int(value) if value else 0 for value in match.groups())

    return hours * 3600 + minutes * 60 + seconds


def classify_content_type(snippet: dict, content_details: dict, live_details: dict) -> str:
    """
    Decide o tipo do vídeo:
      - "live": tem (ou teve) transmissão ao vivo associada.
      - "short": não é live e dura 60 segundos ou menos.
      - "video": qualquer outro vídeo normal.
    """

    is_live_now = snippet.get("liveBroadcastContent") == "live"
    was_live = bool(live_details.get("actualStartTime") or live_details.get("actualEndTime"))

    if is_live_now or was_live:
        return "live"

    duration_seconds = parse_iso8601_duration(content_details.get("duration"))

    if duration_seconds and duration_seconds <= 60:
        return "short"

    return "video"


def get_video_details(video_ids: list[str], channel_handle: str, api_key: str) -> list[dict]:

    results = []

    for start in range(0, len(video_ids), 50):

        batch = video_ids[start:start + 50]

        response = requests.get(
            f"{API_BASE}/videos",
            params={
                "part": "snippet,statistics,contentDetails,liveStreamingDetails",
                "id": ",".join(batch),
                "key": api_key,
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()

        for item in data.get("items", []):

            snippet = item.get("snippet", {})
            statistics = item.get("statistics", {})
            content_details = item.get("contentDetails", {})
            live_details = item.get("liveStreamingDetails", {})

            published_at = (
                live_details.get("actualStartTime")
                or snippet.get("publishedAt")
            )

            tipo_conteudo = classify_content_type(snippet, content_details, live_details)

            results.append({
                "video_id": item["id"],
                "canal": channel_handle,
                "tipo_conteudo": tipo_conteudo,
                "titulo": snippet.get("title", ""),
                "descricao": snippet.get("description", ""),
                "data_publicacao": published_at,
                "duracao_segundos": parse_iso8601_duration(content_details.get("duration")),
                "views": int(statistics.get("viewCount", 0) or 0),
                "comentarios": int(statistics["commentCount"]) if "commentCount" in statistics else None,
                "url": f"https://www.youtube.com/watch?v={item['id']}",
                "_live_chat_id": live_details.get("activeLiveChatId"),
            })

    return results


def get_live_chat_message_count(live_chat_id: str, api_key: str) -> tuple[int | None, str | None]:
    """
    Só funciona enquanto a transmissão está ACONTECENDO — a API do
    YouTube não expõe o replay do chat depois que a live termina.
    """

    MAX_PAGES = 300

    total = 0
    page_token = None

    for _ in range(MAX_PAGES):

        params = {
            "liveChatId": live_chat_id,
            "part": "id",
            "maxResults": 200,
            "key": api_key,
        }

        if page_token:
            params["pageToken"] = page_token

        try:
            response = requests.get(f"{API_BASE}/liveChat/messages", params=params, timeout=30)
            response.raise_for_status()
        except requests.RequestException as error:
            return (total or None), f"Parou de contar por erro na API: {error}"

        data = response.json()
        total += len(data.get("items", []))
        page_token = data.get("nextPageToken")

        if not page_token:
            return total, None

    return total, f"Contagem parcial (parou em {MAX_PAGES} páginas)."


# =========================================================
# TRANSCRIÇÃO — mesmo esquema de 2 níveis do script anterior
# =========================================================

def sanitize_filename(name: str) -> str:

    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = cleaned.rstrip(".")

    return cleaned[:180] or "Transcricao YouTube"


def format_timestamp(total_seconds: float) -> str:

    safe_seconds = max(0, total_seconds) if total_seconds else 0
    whole = int(safe_seconds)

    hours, remainder = divmod(whole, 3600)
    minutes, seconds = divmod(remainder, 60)

    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"

    return f"{minutes}:{seconds:02d}"


def try_fast_transcript(video_id: str) -> tuple[list[dict] | None, str | None]:

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled,
            NoTranscriptFound,
            VideoUnavailable,
        )
    except ImportError:
        return None, "Biblioteca youtube-transcript-api não instalada."

    try:
        raw_segments = YouTubeTranscriptApi.get_transcript(video_id, languages=PREFERRED_LANGUAGES)
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable) as error:
        return None, f"{type(error).__name__}: {error}"
    except Exception as error:  # noqa: BLE001
        return None, f"Erro inesperado: {error}"

    if not raw_segments:
        return None, "A API retornou uma lista vazia de segmentos."

    segments = [
        {"timestamp": format_timestamp(item["start"]), "text": item["text"].replace("\n", " ").strip()}
        for item in raw_segments
        if item.get("text", "").strip()
    ]

    if not segments:
        return None, "Todos os segmentos vieram vazios após a limpeza."

    return segments, None


def parse_json3(json_text: str) -> list[dict]:

    data = json.loads(json_text)
    segments = []

    for event in data.get("events", []):

        start_ms = event.get("tStartMs")

        if start_ms is None:
            continue

        text = "".join(seg.get("utf8", "") for seg in event.get("segs", []) or [])
        text = text.replace("\n", " ").strip()

        if not text:
            continue

        segments.append({"timestamp": format_timestamp(start_ms / 1000), "text": text})

    return segments


def parse_vtt(vtt_text: str) -> list[dict]:

    segments = []
    blocks = re.split(r"\n\s*\n", vtt_text.strip())

    time_pattern = re.compile(
        r"(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*"
        r"(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})"
    )

    for block in blocks:

        lines = block.splitlines()
        start_seconds = None
        text_lines = []

        for line in lines:

            match = time_pattern.search(line)

            if match:
                start_seconds = _vtt_time_to_seconds(match.group(1))
                continue

            if line.strip().isdigit() or line.strip().startswith("WEBVTT"):
                continue

            clean_line = re.sub(r"<[^>]+>", "", line).strip()

            if clean_line:
                text_lines.append(clean_line)

        if start_seconds is not None and text_lines:
            segments.append({"timestamp": format_timestamp(start_seconds), "text": " ".join(text_lines).strip()})

    deduped = []
    last_text = None

    for segment in segments:
        if segment["text"] != last_text:
            deduped.append(segment)
            last_text = segment["text"]

    return deduped


def _vtt_time_to_seconds(time_str: str) -> float:

    parts = time_str.split(":")

    if len(parts) == 3:
        hours, minutes, seconds = parts
    else:
        hours = "0"
        minutes, seconds = parts

    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def try_ytdlp_transcript(video_id: str) -> tuple[list[dict] | None, str | None]:
    """
    Método de reserva via yt-dlp. Inclui:
      - throttling embutido (sleep_interval_subtitles) para não
        disparar muitas requisições seguidas ao YouTube;
      - uma nova tentativa automática, com pausa mais longa, se o
        YouTube responder com HTTP 429 ("Too Many Requests") — o que
        acontece quando o script processa muitos vídeos em sequência.
    """

    try:
        import yt_dlp
    except ImportError:
        return None, "Biblioteca yt-dlp não instalada."

    MAX_ATTEMPTS = 3
    RETRY_WAIT_SECONDS = 45

    for attempt in range(1, MAX_ATTEMPTS + 1):

        with tempfile.TemporaryDirectory() as tmp_dir:

            output_template = os.path.join(tmp_dir, "%(id)s.%(ext)s")

            ydl_opts = {
                "skip_download": True,
                "writesubtitles": True,
                "writeautomaticsub": True,
                "subtitleslangs": PREFERRED_LANGUAGES,
                "subtitlesformat": "json3/vtt",
                "outtmpl": output_template,
                "quiet": True,
                "no_warnings": True,
                # dá um respiro entre as requisições que o próprio
                # yt-dlp faz, para reduzir a chance de sermos limitados
                "sleep_interval_subtitles": 3,
                "sleep_interval": 1,
                "max_sleep_interval": 4,
            }

            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            except Exception as error:  # noqa: BLE001

                error_text = str(error)

                if "429" in error_text and attempt < MAX_ATTEMPTS:
                    time.sleep(RETRY_WAIT_SECONDS)
                    continue

                return None, f"yt-dlp falhou ao baixar a legenda: {error}"

            subtitle_files = _collect_subtitle_files(tmp_dir)

            if subtitle_files:
                return _read_subtitle_segments(tmp_dir, subtitle_files)

            return None, "yt-dlp não encontrou nenhuma legenda para este vídeo."

    return None, "yt-dlp falhou repetidamente por limite de requisições (HTTP 429)."


def _collect_subtitle_files(tmp_dir: str) -> list[str]:

    return [
        file_name for file_name in os.listdir(tmp_dir)
        if file_name.endswith((".json3", ".vtt"))
    ]


def _read_subtitle_segments(tmp_dir: str, subtitle_files: list[str]) -> tuple[list[dict] | None, str | None]:

    def sort_key(name: str):
        lang_rank = next(
            (i for i, lang in enumerate(PREFERRED_LANGUAGES) if f".{lang}." in name),
            len(PREFERRED_LANGUAGES),
        )
        format_rank = 0 if name.endswith(".json3") else 1
        return (lang_rank, format_rank)

    subtitle_files.sort(key=sort_key)
    subtitle_path = os.path.join(tmp_dir, subtitle_files[0])

    with open(subtitle_path, "r", encoding="utf-8") as file:
        content = file.read()

    segments = parse_json3(content) if subtitle_path.endswith(".json3") else parse_vtt(content)

    if not segments:
        return None, "O arquivo de legenda baixado estava vazio após a leitura."

    return segments, None


def create_markdown(title: str, url: str, segments: list[dict]) -> str:

    lines = [f"# {title}", "", f"**Vídeo:** {title}", f"**URL:** {url}", "", "---", ""]

    for segment in segments:
        lines.append(f"**{segment['timestamp']}** {segment['text']}")
        lines.append("")

    return "\n".join(lines)


def extract_transcript(video_id: str, title: str) -> dict:

    log = [f"Método 1/2 (rápido): tentando extrair transcrição de '{title}'."]
    segments, reason = try_fast_transcript(video_id)

    if segments:
        log.append(f"Sucesso no método rápido: {len(segments)} trechos.")
        return {"segments": segments, "method": "rapido", "log": log}

    log.append(f"Método rápido falhou: {reason}")
    log.append("Método 2/2 (reserva — yt-dlp): tentando.")

    segments, reason = try_ytdlp_transcript(video_id)

    if segments:
        log.append(f"Sucesso no método de reserva (yt-dlp): {len(segments)} trechos.")
        return {"segments": segments, "method": "ytdlp", "log": log}

    log.append(f"Método de reserva também falhou: {reason}")

    return {"segments": None, "method": None, "log": log}


# =========================================================
# ORQUESTRAÇÃO — usado pela interface (app.py)
# =========================================================

def _already_has_transcript(video_id: str) -> bool:

    with get_connection() as conn:
        row = conn.execute(
            "SELECT transcricao_sucesso FROM videos WHERE video_id = ?",
            (video_id,),
        ).fetchone()

    return bool(row and row["transcricao_sucesso"])


def get_video_ids_pending_transcript(date_from=None, date_to=None, content_types=None) -> list[str]:
    """IDs dos vídeos, já salvos no banco, que ainda não têm transcrição de sucesso."""

    query = "SELECT video_id FROM videos WHERE (transcricao_sucesso IS NULL OR transcricao_sucesso = 0)"
    params = []

    if date_from:
        query += " AND date(data_publicacao) >= date(?)"
        params.append(str(date_from))

    if date_to:
        query += " AND date(data_publicacao) <= date(?)"
        params.append(str(date_to))

    if content_types:
        placeholders = ",".join("?" for _ in content_types)
        query += f" AND tipo_conteudo IN ({placeholders})"
        params.extend(content_types)

    with get_connection() as conn:
        rows = conn.execute(query, params).fetchall()

    return [row["video_id"] for row in rows]


# ---------- Fase 1: mapeamento (lista + metadados, sem transcrição) ----------

def collect_metadata(
    api_key: str,
    channel_handle: str,
    date_from,
    date_to,
    content_types: list[str],
    progress_cb=None,
    log_cb=None,
):
    """
    Fase 1: lista todos os vídeos do canal no período via API, busca os
    detalhes de cada um (título, descrição, duração, views, comentários,
    mensagens de chat quando aplicável) e classifica o tipo de
    conteúdo. NÃO extrai transcrição — isso fica para collect_transcripts.

    progress_cb(indice, total, mensagem) e log_cb(mensagem) são
    chamados ao longo do processo para a interface acompanhar em
    tempo real (barra de progresso + log de ações).
    """

    def log(message):
        if log_cb:
            log_cb(message)

    init_db()

    published_after = f"{date_from}T00:00:00Z"
    published_before = f"{date_to}T23:59:59Z"

    log(f"Buscando canal @{channel_handle}...")
    channel_id = get_channel_id(channel_handle, api_key)
    log(f"Canal encontrado: {channel_id}")

    log(f"Listando vídeos publicados entre {date_from} e {date_to}...")
    video_ids = search_video_ids(channel_id, published_after, published_before, api_key)
    log(f"{len(video_ids)} vídeo(s) encontrado(s) no período (todos os tipos).")

    if not video_ids:
        return 0

    log("Buscando detalhes de cada vídeo (título, duração, views, comentários)...")
    videos = get_video_details(video_ids, channel_handle, api_key)

    videos = [video for video in videos if video["tipo_conteudo"] in content_types]
    total = len(videos)
    log(f"{total} vídeo(s) após filtrar por tipo de conteúdo selecionado.")

    for index, video in enumerate(videos, start=1):

        rotulo_tipo = CONTENT_TYPES.get(video["tipo_conteudo"], video["tipo_conteudo"])

        if progress_cb:
            progress_cb(index, total)

        log(f"[{index}/{total}] ({rotulo_tipo}) {video['titulo']}")

        mensagens_chat = None

        if video.get("_live_chat_id"):
            log(f"  vídeo ainda ao vivo — contando mensagens do chat...")
            chat_count, chat_error = get_live_chat_message_count(video["_live_chat_id"], api_key)
            mensagens_chat = chat_count
            if chat_error:
                log(f"  aviso na contagem do chat: {chat_error}")

        row = {
            "video_id": video["video_id"],
            "canal": video["canal"],
            "tipo_conteudo": video["tipo_conteudo"],
            "titulo": video["titulo"],
            "descricao": video["descricao"],
            "data_publicacao": video["data_publicacao"],
            "duracao_segundos": video["duracao_segundos"],
            "views": video["views"],
            "comentarios": video["comentarios"],
            "mensagens_chat": mensagens_chat,
            "url": video["url"],
            "coletado_em": datetime.now(timezone.utc).isoformat(),
        }

        upsert_video_metadata(row)
        log(f"  salvo no banco (duração: {format_timestamp(video['duracao_segundos'])}).")

    log(f"Mapeamento concluído: {total} vídeo(s) salvos/atualizados.")

    return total


# ---------- Fase 2: transcrição (roda depois, sobre vídeos já mapeados) ----------

def collect_transcripts(
    video_ids: list[str],
    reprocess_transcripts: bool = False,
    progress_cb=None,
    log_cb=None,
):
    """
    Fase 2: para cada video_id (já mapeado na fase 1), tenta extrair a
    transcrição nos dois níveis (rápido / reserva) e grava só as
    colunas de transcrição. Por padrão pula vídeos que já têm
    transcrição de sucesso salva (reprocess_transcripts=False).
    """

    def log(message):
        if log_cb:
            log_cb(message)

    init_db()
    os.makedirs(TRANSCRIPTS_DIR, exist_ok=True)

    if not reprocess_transcripts:
        video_ids = [vid for vid in video_ids if not _already_has_transcript(vid)]

    total = len(video_ids)
    log(f"{total} vídeo(s) para buscar transcrição.")

    if not total:
        return 0

    with get_connection() as conn:
        titles = {
            row["video_id"]: (row["titulo"], row["url"])
            for row in conn.execute(
                f"SELECT video_id, titulo, url FROM videos WHERE video_id IN "
                f"({','.join('?' for _ in video_ids)})",
                video_ids,
            ).fetchall()
        }

    for index, video_id in enumerate(video_ids, start=1):

        titulo, url = titles.get(video_id, (video_id, ""))

        if progress_cb:
            progress_cb(index, total)

        log(f"[{index}/{total}] {titulo}")
        log("  método 1/2 (rápido): tentando...")

        result = extract_transcript(video_id, titulo)
        segments = result["segments"] or []

        for line in result["log"]:
            log(f"  {line}")

        file_path = None

        if segments:
            file_name = sanitize_filename(titulo) + ".md"
            file_path = os.path.join(TRANSCRIPTS_DIR, file_name)

            with open(file_path, "w", encoding="utf-8") as file:
                file.write(create_markdown(titulo, url, segments))

            log(f"  transcrição salva em {file_path} ({len(segments)} trechos, método: {result['method']}).")

        else:
            log("  não foi possível transcrever este vídeo.")

        update_video_transcript(
            video_id=video_id,
            transcricao_sucesso=1 if segments else 0,
            transcricao_metodo=result["method"],
            transcricao_trechos=len(segments),
            transcricao_completa=" ".join(s["text"] for s in segments) if segments else None,
            arquivo_transcricao=file_path,
            log_transcricao=" | ".join(result["log"]),
        )

        # pausa entre vídeos para não sobrecarregar a API/YouTube
        time.sleep(3)

    log(f"Extração de transcrições concluída: {total} vídeo(s) processados.")

    return total
