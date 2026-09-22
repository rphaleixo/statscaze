// Acesso ao banco D1 — equivalente às funções de banco de coletor.py

// Vídeo novo: grava tudo. Vídeo já existente (mapeamento rodado de novo):
// só atualiza o que pode mudar de fato com o tempo (views, comentários,
// contagem de chat, quando foi coletado) — título, descrição, duração,
// tipo e data de publicação de um vídeo já mapeado nunca são sobrescritos,
// para não desfazer nada.
export async function upsertVideoMetadata(db, row) {
  await db
    .prepare(
      `INSERT INTO videos (
        video_id, canal, tipo_video, titulo, descricao,
        data_publicacao, duracao_segundos, views, comentarios,
        mensagens_chat, url, thumbnail_url, coletado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        views=excluded.views,
        comentarios=excluded.comentarios,
        mensagens_chat=excluded.mensagens_chat,
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
      row.thumbnail_url || null,
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

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePessoaRow(row) {
  return { ...row, apelidos: parseJsonArray(row.apelidos), papeis_padrao: parseJsonArray(row.papeis_padrao) };
}

export async function listPessoas(db) {
  const result = await db.prepare(`SELECT * FROM pessoas ORDER BY nome`).all();
  return result.results.map(parsePessoaRow);
}

// Acha uma pessoa já cadastrada cujo nome OU algum apelido bata (sem
// diferenciar maiúsculas/minúsculas) com o texto informado. É o que evita
// duplicata: se alguém digitar "Cazé" (apelido), isso resolve para a
// pessoa "Casimiro Miguel" em vez de criar um cadastro novo.
export async function resolvePessoaPorNome(db, nomeDigitado) {
  const nomeLimpo = nomeDigitado.trim();
  if (!nomeLimpo) return null;

  const porNome = await db.prepare(`SELECT * FROM pessoas WHERE LOWER(nome) = LOWER(?)`).bind(nomeLimpo).first();
  if (porNome) return parsePessoaRow(porNome);

  const porApelido = await db
    .prepare(
      `SELECT p.* FROM pessoas p, json_each(p.apelidos) je
       WHERE LOWER(je.value) = LOWER(?) LIMIT 1`
    )
    .bind(nomeLimpo)
    .first();

  return porApelido ? parsePessoaRow(porApelido) : null;
}

// Cria a pessoa se "nome" (ou um apelido já cadastrado) não bater com
// ninguém; caso já exista, devolve o id da pessoa existente sem
// sobrescrever os dados dela (apelidos/papéis já curados não se perdem).
export async function upsertPessoa(db, nome, { apelidos, papeisPadrao } = {}) {
  const existente = await resolvePessoaPorNome(db, nome);
  if (existente) return existente.id;

  const result = await db
    .prepare(`INSERT INTO pessoas (nome, apelidos, papeis_padrao, criado_em) VALUES (?, ?, ?, ?)`)
    .bind(
      nome.trim(),
      JSON.stringify(apelidos || []),
      JSON.stringify(papeisPadrao || []),
      new Date().toISOString()
    )
    .run();

  return result.meta.last_row_id;
}

export async function updatePessoa(db, id, { nome, apelidos, papeisPadrao }) {
  await db
    .prepare(`UPDATE pessoas SET nome = ?, apelidos = ?, papeis_padrao = ? WHERE id = ?`)
    .bind(nome, JSON.stringify(apelidos || []), JSON.stringify(papeisPadrao || []), id)
    .run();
}

export async function deletePessoa(db, id) {
  await db.prepare(`DELETE FROM participacoes WHERE pessoa_id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM pessoas WHERE id = ?`).bind(id).run();
}

// ---------- competições conhecidas (lista de referência) ----------

export async function listCompeticoesCadastradas(db) {
  const result = await db.prepare(`SELECT * FROM competicoes ORDER BY nome`).all();
  return result.results;
}

export async function createCompeticaoCadastrada(db, nome) {
  const result = await db
    .prepare(`INSERT INTO competicoes (nome, criado_em) VALUES (?, ?) ON CONFLICT(nome) DO NOTHING`)
    .bind(nome.trim(), new Date().toISOString())
    .run();
  return result.meta.last_row_id;
}

export async function updateCompeticaoCadastrada(db, id, nome) {
  await db.prepare(`UPDATE competicoes SET nome = ? WHERE id = ?`).bind(nome.trim(), id).run();
}

export async function deleteCompeticaoCadastrada(db, id) {
  await db.prepare(`DELETE FROM competicoes WHERE id = ?`).bind(id).run();
}

// ---------- tipos de conteúdo (lista editável, com arquivamento) ----------

// incluirArquivados=false (padrão) é o que deve alimentar o menu da aba
// Vídeos — uma opção arquivada nunca aparece lá, mas continua existindo
// para os vídeos que já foram classificados com ela.
export async function listTiposConteudo(db, { incluirArquivados = true } = {}) {
  const where = incluirArquivados ? "" : "WHERE arquivado = 0";
  const result = await db.prepare(`SELECT * FROM tipos_conteudo ${where} ORDER BY nome`).all();
  return result.results;
}

export async function createTipoConteudo(db, nome) {
  const result = await db
    .prepare(`INSERT INTO tipos_conteudo (nome, arquivado, criado_em) VALUES (?, 0, ?) ON CONFLICT(nome) DO NOTHING`)
    .bind(nome.trim(), new Date().toISOString())
    .run();
  return result.meta.last_row_id;
}

export async function arquivarTipoConteudo(db, id, arquivado) {
  await db.prepare(`UPDATE tipos_conteudo SET arquivado = ? WHERE id = ?`).bind(arquivado ? 1 : 0, id).run();
}

// ---------- participações (elenco por vídeo) ----------

// participacoes: [{ nome, papel }]
export async function setParticipacoes(db, videoId, participacoes) {
  await db.prepare(`DELETE FROM participacoes WHERE video_id = ?`).bind(videoId).run();

  for (const { nome, papel } of participacoes) {
    if (!nome?.trim() || !papel) continue;

    const pessoaId = await upsertPessoa(db, nome, { papeisPadrao: [papel] });

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

// O D1 tem um limite de parâmetros por consulta (bem abaixo do total de
// vídeos que já temos mapeados), então uma lista de IDs precisa ser
// dividida em lotes menores — senão a consulta falha inteira e a tela de
// vídeos aparenta estar "zerada" sem nenhum aviso claro do motivo.
const TAMANHO_LOTE_SQL = 90;

function dividirEmLotes(itens, tamanho) {
  const lotes = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

async function getParticipacoesPorVideo(db, videoIds) {
  if (!videoIds.length) return {};

  const map = {};

  for (const lote of dividirEmLotes(videoIds, TAMANHO_LOTE_SQL)) {
    const placeholders = lote.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT part.video_id, part.papel, p.nome
       FROM participacoes part JOIN pessoas p ON p.id = part.pessoa_id
       WHERE part.video_id IN (${placeholders})
       ORDER BY p.nome`
    );
    const result = await stmt.bind(...lote).all();

    for (const row of result.results) {
      if (!map[row.video_id]) map[row.video_id] = [];
      map[row.video_id].push({ nome: row.nome, papel: row.papel });
    }
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

export async function descartarClassificacaoSugerida(db, videoId) {
  await db
    .prepare(
      `UPDATE videos
       SET tipo_conteudo_sugerido = NULL, competicao_sugerida = NULL, programa_sugerido = NULL,
           competicao_confianca = NULL
       WHERE video_id = ?`
    )
    .bind(videoId)
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

// Une a lista de referência cadastrada com o que já apareceu em vídeos
// (pode ter competição digitada num vídeo que ainda não está na lista
// de referência).
export async function getCompeticoesConhecidas(db) {
  const result = await db
    .prepare(
      `SELECT nome FROM competicoes
       UNION
       SELECT competicao AS nome FROM videos WHERE competicao IS NOT NULL AND competicao != ''
       ORDER BY nome`
    )
    .all();
  return result.results.map((r) => r.nome);
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

  const map = {};

  for (const lote of dividirEmLotes(videoIds, TAMANHO_LOTE_SQL)) {
    const placeholders = lote.map(() => "?").join(",");
    const stmt = db.prepare(`SELECT video_id, titulo, url FROM videos WHERE video_id IN (${placeholders})`);
    const result = await stmt.bind(...lote).all();

    for (const row of result.results) {
      map[row.video_id] = { titulo: row.titulo, url: row.url };
    }
  }

  return map;
}
