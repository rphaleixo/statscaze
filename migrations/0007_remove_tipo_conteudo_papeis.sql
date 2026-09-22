-- Tipo de conteúdo não restringe mais quais papéis podem ser usados no
-- elenco do vídeo (isso complicava o cadastro sem trazer benefício real).
-- O papel de cada participação continua livre, escolhido por vídeo.

ALTER TABLE tipos_conteudo DROP COLUMN papeis_permitidos;
