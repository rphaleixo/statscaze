// Acesso ao banco D1 — equivalente às funções de banco de coletor.py

export async function upsertVideoMetadata(db, row) {
  await db
    .prepare(
      `INSERT INTO videos (
        video_id, canal, tipo_video, titulo, descricao,
        data_publicacao, duracao_segundos, views, comentarios,
        mensagens_chat, url, coletado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        canal=excluded.canal,
        tipo_video=excluded.tipo_video,
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
      row.tipo_video,
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

export const PAPEIS = {
  narrador: "Narrador",
  comentarista: "Comentarista",
  reporter: "Repórter",
  apresentador: "Apresentador",
};

// Classificação editorial do vídeo (diferente do tipo técnico
// live/short/video). Cada uma libera um conjunto diferente de papéis:
// uma transmissão tem narrador/comentaristas/repórter; um programa tem
// apresentador(es); um especial não tem restrição.
export const TIPOS_CONTEUDO = {
  transmissao: "Transmissão",
  programa: "Programa",
  especial: "Especial",
};

export const PAPEIS_POR_TIPO_CONTEUDO = {
  transmissao: ["narrador", "comentarista", "reporter"],
  programa: ["apresentador"],
  especial: Object.keys(PAPEIS),
};

// Atualiza só os campos presentes no objeto (chave existe, mesmo que valor
// seja null para limpar o campo). Um campo omitido (undefined/ausente)
// mantém o valor que já estava salvo — importante para a importação por
// CSV, onde uma linha pode trazer só o programa e não a competição, sem
// apagar o que já tinha sido preenchido antes.
export async function updateClassificacao(db, videoId, campos) {
  const colunaPorChave = { competicao: "competicao", programa: "programa", tipoConteudo: "tipo_conteudo" };
  const sets = [];
  const params = [];

  for (const [chave, coluna] of Object.entries(colunaPorChave)) {
    if (chave in campos) {
      sets.push(`${coluna} = ?`);
      params.push(campos[chave] || null);
    }
  }

  if (!sets.length) return;

  sets.push("enriquecido_em = ?");
  params.push(new Date().toISOString(), videoId);

  await db.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE video_id = ?`).bind(...params).run();
}

// ---------- pessoas (elenco) ----------

export async function listPessoas(db) {
  const result = await db.prepare(`SELECT * FROM pessoas ORDER BY nome`).all();
  return result.results;
}

export async function upsertPessoa(db, nome, papelPadrao) {
  const nomeLimpo = nome.trim();

  await db
    .prepare(`INSERT INTO pessoas (nome, papel_padrao, criado_em) VALUES (?, ?, ?) ON CONFLICT(nome) DO NOTHING`)
    .bind(nomeLimpo, papelPadrao || null, new Date().toISOString())
    .run();

  const row = await db.prepare(`SELECT id FROM pessoas WHERE nome = ?`).bind(nomeLimpo).first();
  return row.id;
}

export async function updatePessoa(db, id, { nome, papelPadrao }) {
  await db
    .prepare(`UPDATE pessoas SET nome = ?, papel_padrao = ? WHERE id = ?`)
    .bind(nome, papelPadrao || null, id)
    .run();
}

export async function deletePessoa(db, id) {
  await db.prepare(`DELETE FROM participacoes WHERE pessoa_id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM pessoas WHERE id = ?`).bind(id).run();
}

// ---------- participações (elenco por vídeo) ----------

// participacoes: [{ nome, papel }]
export async function setParticipacoes(db, videoId, participacoes) {
  await db.prepare(`DELETE FROM participacoes WHERE video_id = ?`).bind(videoId).run();

  for (const { nome, papel } of participacoes) {
    if (!nome?.trim() || !papel) continue;

    const pessoaId = await upsertPessoa(db, nome, papel);

    await db
      .prepare(`INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel) VALUES (?, ?, ?)`)
      .bind(videoId, pessoaId, papel)
      .run();
  }

  await db
    .prepare(`UPDATE videos SET enriquecido_em = ? WHERE video_id = ?`)
    .bind(new Date().toISOString(), videoId)
    .run();
}

async function getParticipacoesPorVideo(db, videoIds) {
  if (!videoIds.length) return {};

  const placeholders = videoIds.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT part.video_id, part.papel, p.nome
     FROM participacoes part JOIN pessoas p ON p.id = part.pessoa_id
     WHERE part.video_id IN (${placeholders})
     ORDER BY p.nome`
  );
  const result = await stmt.bind(...videoIds).all();

  const map = {};
  for (const row of result.results) {
    if (!map[row.video_id]) map[row.video_id] = [];
    map[row.video_id].push({ nome: row.nome, papel: row.papel });
  }
  return map;
}

// ---------- sugestão de classificação (tipo de conteúdo/competição/programa) via IA ----------

export async function saveClassificacaoSugerida(db, videoId, { tipoConteudo, competicao, programa, confianca }) {
  await db
    .prepare(
      `UPDATE videos
       SET tipo_conteudo_sugerido = ?, competicao_sugerida = ?, programa_sugerido = ?,
           competicao_confianca = ?, competicao_sugestao_em = ?
       WHERE video_id = ?`
    )
    .bind(
      tipoConteudo || null,
      competicao || null,
      programa || null,
      confianca ?? null,
      new Date().toISOString(),
      videoId
    )
    .run();
}

export async function aplicarClassificacaoSugerida(db, videoId) {
  await db
    .prepare(
      `UPDATE videos
       SET tipo_conteudo = COALESCE(tipo_conteudo_sugerido, tipo_conteudo),
           competicao = COALESCE(competicao_sugerida, competicao),
           programa = COALESCE(programa_sugerido, programa),
           enriquecido_em = ?
       WHERE video_id = ?`
    )
    .bind(new Date().toISOString(), videoId)
    .run();
}

export async function getCompeticoesConhecidas(db) {
  const result = await db
    .prepare(`SELECT DISTINCT competicao FROM videos WHERE competicao IS NOT NULL AND competicao != ''`)
    .all();
  return result.results.map((r) => r.competicao);
}

export async function getProgramasConhecidos(db) {
  const result = await db
    .prepare(`SELECT DISTINCT programa FROM videos WHERE programa IS NOT NULL AND programa != ''`)
    .all();
  return result.results.map((r) => r.programa);
}

function buildFilterClause(dateFrom, dateTo, tiposVideo) {
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
  if (tiposVideo && tiposVideo.length) {
    clauses.push(`tipo_video IN (${tiposVideo.map(() => "?").join(",")})`);
    params.push(...tiposVideo);
  }

  return { clauses, params };
}

export async function getVideos(db, { dateFrom, dateTo, contentTypes } = {}) {
  const { clauses, params } = buildFilterClause(dateFrom, dateTo, contentTypes);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const stmt = db.prepare(`SELECT * FROM videos ${where} ORDER BY data_publicacao DESC`);
  const result = await stmt.bind(...params).all();

  const videoIds = result.results.map((r) => r.video_id);
  const participacoesPorVideo = await getParticipacoesPorVideo(db, videoIds);

  return result.results.map((row) => addElencoFields(row, participacoesPorVideo[row.video_id] || []));
}

// Deriva campos convenientes para o frontend a partir das participações
// (pessoa + papel): lista de nomes e uma chave de combinação (mesmo
// conjunto de pessoas+papéis, ordem alfabética) para agrupar vídeos que
// têm exatamente a mesma escalação.
function addElencoFields(row, participacoes) {
  const elenco = participacoes.map((p) => p.nome);
  const combinacao = [...participacoes]
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map((p) => `${p.nome} (${PAPEIS[p.papel] || p.papel})`)
    .join(" + ");

  return { ...row, participacoes, elenco, combinacao_elenco: combinacao || null };
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
