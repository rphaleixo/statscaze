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

export async function updateEnrichment(db, videoId, competicao, elenco) {
  await db
    .prepare(
      `UPDATE videos
       SET competicao = ?, elenco = ?, enriquecido_em = ?
       WHERE video_id = ?`
    )
    .bind(
      competicao || null,
      elenco && elenco.length ? JSON.stringify(elenco) : null,
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

  return result.results.map((row) => ({
    ...row,
    elenco: row.elenco ? JSON.parse(row.elenco) : [],
  }));
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
