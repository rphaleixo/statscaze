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
  log_transcricao TEXT,
  competicao TEXT,
  elenco TEXT,
  enriquecido_em TEXT,
  coletado_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_data_publicacao ON videos (data_publicacao);
CREATE INDEX IF NOT EXISTS idx_videos_tipo_conteudo ON videos (tipo_conteudo);
