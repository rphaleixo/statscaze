-- Cada pessoa pode ter vários apelidos/grafias (para a IA e a busca
-- reconhecerem que é a mesma pessoa, sem criar duplicata) e vários papéis
-- padrão (o papel específico de cada vídeo continua em participacoes.papel
-- — isso aqui é só um "sugerido" pré-preenchido ao adicionar a pessoa).

ALTER TABLE pessoas ADD COLUMN apelidos TEXT;      -- JSON: ["Cazé"]
ALTER TABLE pessoas ADD COLUMN papeis_padrao TEXT; -- JSON: ["apresentador","comentarista"]

UPDATE pessoas
SET papeis_padrao = '["' || papel_padrao || '"]'
WHERE papel_padrao IS NOT NULL AND papel_padrao != '';

ALTER TABLE pessoas DROP COLUMN papel_padrao;

-- Lista de competições conhecidas, para preencher o campo de competição
-- (autocompletar) mesmo antes de qualquer vídeo usá-la.
CREATE TABLE IF NOT EXISTS competicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL UNIQUE,
  criado_em TEXT
);
