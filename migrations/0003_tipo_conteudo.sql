-- Separa duas coisas que estavam misturadas em "tipo_conteudo":
--   tipo_video       -> live | short | video (formato técnico, vindo da API do YouTube)
--   tipo_conteudo    -> transmissao | programa | especial (classificação editorial)
-- E adiciona "programa" como campo separado de "competicao" (competição só
-- se aplica a transmissão; programa só se aplica a conteúdo tipo programa).

ALTER TABLE videos RENAME COLUMN tipo_conteudo TO tipo_video;
ALTER TABLE videos ADD COLUMN tipo_conteudo TEXT;
ALTER TABLE videos ADD COLUMN programa TEXT;

CREATE INDEX IF NOT EXISTS idx_videos_tipo_conteudo_editorial ON videos (tipo_conteudo);
CREATE INDEX IF NOT EXISTS idx_videos_programa ON videos (programa);

-- Sugestões da IA para programa e tipo de conteúdo (a sugestão de
-- competição já tinha suas próprias colunas desde a migração anterior).
ALTER TABLE videos ADD COLUMN programa_sugerido TEXT;
ALTER TABLE videos ADD COLUMN tipo_conteudo_sugerido TEXT;
