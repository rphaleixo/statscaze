// Acesso ao banco D1 — equivalente às funções de banco de coletor.py

export async function upsertVideoMetadata(db, row) {
  await db
    .prepare(
      `INSERT INTO videos (
        video_id, canal, tipo_conteudo, titulo, descricao,
        data_publicacao, duracao_segundos, views, comentarios,
        mensagens_chat, url, coletado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        coletado_em=excluded.coletado_em`
    )
    .bind(
      row.video_id,
      row.canal,
      row.tipo_conteudo,
      row.titulo,
      row.descricao,
      row.data_publicacao,
      row.duracao_segundos,
      row.views,
      row.comentarios,
      row.mensagens_chat,
      row.url,
      row.coletado_em
    )
    .run();
}

export async function updateVideoTranscript(db, videoId, fields) {
  await db
    .prepare(
      `UPDATE videos
       SET transcricao_sucesso = ?, transcricao_metodo = ?,
           transcricao_trechos = ?, transcricao_completa = ?,
           log_transcricao = ?
       WHERE video_id = ?`
    )
    .bind(
      fields.transcricao_sucesso,
      fields.transcricao_metodo,
      fields.transcricao_trechos,
      fields.transcricao_completa,
      fields.log_transcricao,
      videoId
    )
    .run();
}

// elenco: { narrador, comentaristas: [até 5 nomes] }
export async function updateEnrichment(db, videoId, competicao, elenco) {
  const comentaristas = (elenco?.comentaristas || []).slice(0, 5);

  await db
    .prepare(
      `UPDATE videos
       SET competicao = ?, narrador = ?,
           comentarista_1 = ?, comentarista_2 = ?, comentarista_3 = ?,
           comentarista_4 = ?, comentarista_5 = ?,
           enriquecido_em = ?
       WHERE video_id = ?`
    )
    .bind(
      competicao || null,
      elenco?.narrador || null,
      comentaristas[0] || null,
      comentaristas[1] || null,
      comentaristas[2] || null,
      comentaristas[3] || null,
      comentaristas[4] || null,
      new Date().toISOString(),
      videoId
    )
    .run();
}

function buildFilterClause(dateFrom, dateTo, contentTypes) {
  const clauses = [];
  const params = [];

  if (dateFrom) {
    clauses.push("date(data_publicacao) >= date(?)");
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("date(data_publicacao) <= date(?)");
    params.push(dateTo);
  }
  if (contentTypes && contentTypes.length) {
    clauses.push(`tipo_conteudo IN (${contentTypes.map(() => "?").join(",")})`);
    params.push(...contentTypes);
  }

  return { clauses, params };
}

export async function getVideos(db, { dateFrom, dateTo, contentTypes } = {}) {
  const { clauses, params } = buildFilterClause(dateFrom, dateTo, contentTypes);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const stmt = db.prepare(`SELECT * FROM videos ${where} ORDER BY data_publicacao DESC`);
  const result = await stmt.bind(...params).all();

  return result.results.map(addElencoFields);
}

// Deriva campos convenientes para o frontend a partir de
// narrador + comentarista_1..5: lista do elenco e uma chave de combinação
// (mesmo conjunto de pessoas, ordem alfabética) para agrupar vídeos que têm
// exatamente a mesma escalação.
function addElencoFields(row) {
  const comentaristas = [
    row.comentarista_1, row.comentarista_2, row.comentarista_3,
    row.comentarista_4, row.comentarista_5,
  ].filter(Boolean);

  const elenco = [row.narrador, ...comentaristas].filter(Boolean);
  const combinacao = [...elenco].sort((a, b) => a.localeCompare(b)).join(" + ");

  return { ...row, comentaristas, elenco, combinacao_elenco: combinacao || null };
}

export async function getVideoIdsPendingTranscript(db, { dateFrom, dateTo, contentTypes } = {}) {
  const { clauses, params } = buildFilterClause(dateFrom, dateTo, contentTypes);
  const conditions = ["(transcricao_sucesso IS NULL OR transcricao_sucesso = 0)", ...clauses];

  const stmt = db.prepare(
    `SELECT video_id FROM videos WHERE ${conditions.join(" AND ")}`
  );
  const result = await stmt.bind(...params).all();

  return result.results.map((row) => row.video_id);
}

export async function getVideoTitlesUrls(db, videoIds) {
  if (!videoIds.length) return {};

  const placeholders = videoIds.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT video_id, titulo, url FROM videos WHERE video_id IN (${placeholders})`);
  const result = await stmt.bind(...videoIds).all();

  const map = {};
  for (const row of result.results) {
    map[row.video_id] = { titulo: row.titulo, url: row.url };
  }
  return map;
}
