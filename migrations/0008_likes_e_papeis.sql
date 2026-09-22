-- Curtidas (likeCount) da API do YouTube, coletadas junto com views e
-- comentários — refinam o engajamento além de views/comentários/chat.
ALTER TABLE videos ADD COLUMN likes INTEGER;

-- Papel deixa de ser uma lista fixa no código e vira uma lista editável
-- (igual tipos_conteudo): dá pra adicionar novos papéis e arquivar (nunca
-- excluir) os que não devem mais aparecer no menu de elenco da aba
-- Vídeos. Um papel arquivado continua valendo para as participações que
-- já foram gravadas com ele. Os 4 papéis abaixo mantêm exatamente a
-- grafia já usada em participacoes.papel, pra não quebrar nada existente.
CREATE TABLE IF NOT EXISTS papeis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL UNIQUE,
  arquivado INTEGER DEFAULT 0,
  criado_em TEXT
);

INSERT OR IGNORE INTO papeis (nome, criado_em) VALUES
  ('narrador', datetime('now')),
  ('comentarista', datetime('now')),
  ('reporter', datetime('now')),
  ('apresentador', datetime('now'));
