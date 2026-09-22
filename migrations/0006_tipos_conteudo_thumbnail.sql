-- Tipo de conteúdo deixa de ser uma lista fixa no código e vira uma
-- lista editável: dá pra adicionar novas opções e arquivar (nunca
-- excluir) as que não devem mais aparecer no menu de classificação da
-- aba Vídeos. Uma opção arquivada continua valendo para os vídeos que
-- já foram classificados com ela.

CREATE TABLE IF NOT EXISTS tipos_conteudo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL UNIQUE,
  papeis_permitidos TEXT,   -- JSON: ["narrador","comentarista",...] ou NULL = qualquer papel
  arquivado INTEGER DEFAULT 0,
  criado_em TEXT
);

INSERT OR IGNORE INTO tipos_conteudo (nome, papeis_permitidos, criado_em) VALUES
  ('Transmissão', '["narrador","comentarista","reporter"]', datetime('now')),
  ('Programa', '["apresentador"]', datetime('now')),
  ('Especial', NULL, datetime('now'));

-- Miniatura do vídeo, vinda da própria API do YouTube (nunca sobrescrita
-- depois de gravada, mesmo mapeamento rodado de novo).
ALTER TABLE videos ADD COLUMN thumbnail_url TEXT;
