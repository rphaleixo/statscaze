-- Substitui as colunas fixas (narrador, comentarista_1..5) por um modelo
-- flexível: uma lista de pessoas reutilizável (pessoas) e uma tabela de
-- participações por vídeo com papel livre (participacoes). Também adiciona
-- as colunas de sugestão de competição/programa feita por IA.

CREATE TABLE IF NOT EXISTS pessoas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL UNIQUE,
  papel_padrao TEXT,
  criado_em TEXT
);

CREATE TABLE IF NOT EXISTS participacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(video_id),
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id),
  papel TEXT NOT NULL,
  UNIQUE(video_id, pessoa_id, papel)
);

CREATE INDEX IF NOT EXISTS idx_participacoes_video ON participacoes (video_id);
CREATE INDEX IF NOT EXISTS idx_participacoes_pessoa ON participacoes (pessoa_id);

-- Migra dados já cadastrados nas colunas antigas para o novo modelo.
INSERT OR IGNORE INTO pessoas (nome, papel_padrao, criado_em)
SELECT DISTINCT narrador, 'narrador', datetime('now') FROM videos WHERE narrador IS NOT NULL AND narrador != '';

INSERT OR IGNORE INTO pessoas (nome, papel_padrao, criado_em)
SELECT DISTINCT comentarista_1, 'comentarista', datetime('now') FROM videos WHERE comentarista_1 IS NOT NULL AND comentarista_1 != '';

INSERT OR IGNORE INTO pessoas (nome, papel_padrao, criado_em)
SELECT DISTINCT comentarista_2, 'comentarista', datetime('now') FROM videos WHERE comentarista_2 IS NOT NULL AND comentarista_2 != '';

INSERT OR IGNORE INTO pessoas (nome, papel_padrao, criado_em)
SELECT DISTINCT comentarista_3, 'comentarista', datetime('now') FROM videos WHERE comentarista_3 IS NOT NULL AND comentarista_3 != '';

INSERT OR IGNORE INTO pessoas (nome, papel_padrao, criado_em)
SELECT DISTINCT comentarista_4, 'comentarista', datetime('now') FROM videos WHERE comentarista_4 IS NOT NULL AND comentarista_4 != '';

INSERT OR IGNORE INTO pessoas (nome, papel_padrao, criado_em)
SELECT DISTINCT comentarista_5, 'comentarista', datetime('now') FROM videos WHERE comentarista_5 IS NOT NULL AND comentarista_5 != '';

INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel)
SELECT v.video_id, p.id, 'narrador' FROM videos v JOIN pessoas p ON p.nome = v.narrador
WHERE v.narrador IS NOT NULL AND v.narrador != '';

INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel)
SELECT v.video_id, p.id, 'comentarista' FROM videos v JOIN pessoas p ON p.nome = v.comentarista_1
WHERE v.comentarista_1 IS NOT NULL AND v.comentarista_1 != '';

INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel)
SELECT v.video_id, p.id, 'comentarista' FROM videos v JOIN pessoas p ON p.nome = v.comentarista_2
WHERE v.comentarista_2 IS NOT NULL AND v.comentarista_2 != '';

INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel)
SELECT v.video_id, p.id, 'comentarista' FROM videos v JOIN pessoas p ON p.nome = v.comentarista_3
WHERE v.comentarista_3 IS NOT NULL AND v.comentarista_3 != '';

INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel)
SELECT v.video_id, p.id, 'comentarista' FROM videos v JOIN pessoas p ON p.nome = v.comentarista_4
WHERE v.comentarista_4 IS NOT NULL AND v.comentarista_4 != '';

INSERT OR IGNORE INTO participacoes (video_id, pessoa_id, papel)
SELECT v.video_id, p.id, 'comentarista' FROM videos v JOIN pessoas p ON p.nome = v.comentarista_5
WHERE v.comentarista_5 IS NOT NULL AND v.comentarista_5 != '';

ALTER TABLE videos DROP COLUMN narrador;
ALTER TABLE videos DROP COLUMN comentarista_1;
ALTER TABLE videos DROP COLUMN comentarista_2;
ALTER TABLE videos DROP COLUMN comentarista_3;
ALTER TABLE videos DROP COLUMN comentarista_4;
ALTER TABLE videos DROP COLUMN comentarista_5;

ALTER TABLE videos ADD COLUMN competicao_sugerida TEXT;
ALTER TABLE videos ADD COLUMN competicao_confianca REAL;
ALTER TABLE videos ADD COLUMN competicao_sugestao_em TEXT;
