// Sugestões via Workers AI (IA da própria Cloudflare, sem chave extra):
// classificação do vídeo (tipo de conteúdo + competição/programa) e quem
// participou. O resultado é sempre uma SUGESTÃO — quem confirma e grava
// como dado oficial do vídeo é a pessoa usando a interface.

// Llama 3.1 8B "puro" saiu do catálogo da Workers AI (descontinuado em
// 2026-05-30). Usamos o Llama 3.3 70B (variante fp8 rápida), confirmado
// ativo no catálogo atual: https://developers.cloudflare.com/workers-ai/models/
// Se a Cloudflare aposentar este também no futuro, troque aqui (e só aqui).
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TRANSCRICAO_CHARS = 2000;

function truncar(texto, max) {
  if (!texto) return "";
  return texto.length > max ? `${texto.slice(0, max)}...` : texto;
}

// Extrai o primeiro objeto JSON de um texto, tolerando prosa ao redor
// (modelos de instrução às vezes respondem "Aqui está: {...}").
function extrairJson(texto) {
  const match = texto?.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Retorna { tipoConteudo, competicao, programa, confianca, participantes, erro }
// tipoConteudo: um dos nomes em tiposConteudoConhecidos, ou null.
// participantes: [{ nome, papel }], só com nomes que baterem com a lista de
// pessoas já cadastradas (evita a IA inventar gente que não existe no elenco).
export async function sugerirClassificacao(
  ai,
  { titulo, descricao, transcricao, competicoesConhecidas, programasConhecidas, pessoasConhecidas, tiposConteudoConhecidos }
) {
  // Cada pessoa pode ter vários apelidos/grafias — todos contam como
  // "nomes conhecidos" para a IA reconhecer, mas sempre voltam ao nome
  // canônico (pessoa.nome) na hora de gravar a participação.
  const nomeCanonicoPorVariante = new Map();
  const variantesParaExibir = [];
  for (const pessoa of pessoasConhecidas || []) {
    nomeCanonicoPorVariante.set(pessoa.nome.toLowerCase(), pessoa.nome);
    variantesParaExibir.push(pessoa.nome);
    for (const apelido of pessoa.apelidos || []) {
      nomeCanonicoPorVariante.set(apelido.toLowerCase(), pessoa.nome);
      variantesParaExibir.push(`${apelido} (= ${pessoa.nome})`);
    }
  }

  const tiposConteudoLower = new Map((tiposConteudoConhecidos || []).map((t) => [t.nome.toLowerCase(), t.nome]));
  const listaTiposConteudo = (tiposConteudoConhecidos || [])
    .map((t) => (t.papeisPermitidos?.length ? `${t.nome} (papéis: ${t.papeisPermitidos.join(", ")})` : t.nome))
    .join(", ");

  const prompt = `Você analisa um vídeo de um canal de TV/YouTube esportivo a partir do título, descrição e um trecho da transcrição, e devolve uma classificação em JSON.

Primeiro decida o TIPO DE CONTEÚDO do vídeo, escolhendo EXATAMENTE um destes nomes cadastrados (ou nenhum, se não tiver certeza): ${listaTiposConteudo || "nenhum tipo cadastrado ainda"}.

Se o tipo escolhido tiver a ver com transmissão de uma competição/jogo/evento esportivo, identifique também a COMPETIÇÃO (ex.: "Brasileirão Série A", "Premier League"). Competições já usadas neste canal, para manter nomes consistentes (reaproveite uma se o vídeo pertencer a ela): ${competicoesConhecidas?.length ? competicoesConhecidas.join(", ") : "nenhuma cadastrada ainda"}.

Se o tipo escolhido tiver a ver com um programa de estúdio, identifique o nome do PROGRAMA. Programas já usados neste canal: ${programasConhecidas?.length ? programasConhecidas.join(", ") : "nenhum cadastrado ainda"}.

Depois, veja se alguma destas pessoas já cadastradas no elenco do canal é claramente mencionada no título, descrição ou transcrição, e qual papel ela teve NESTE vídeo (narrador, comentarista, reporter ou apresentador — use "reporter" sem acento). A lista abaixo mostra "apelido (= nome oficial)" quando a pessoa tem apelido — se reconhecer o apelido no texto, responda com o NOME OFICIAL, não o apelido. Só inclua pessoas desta lista, nunca invente nomes novos: ${variantesParaExibir.length ? variantesParaExibir.join(", ") : "nenhuma pessoa cadastrada ainda"}.

Responda SOMENTE com um objeto JSON, sem nenhum texto antes ou depois, no formato:
{"tipo_conteudo": "um dos nomes cadastrados, exatamente como escrito, ou null", "competicao": "nome ou null", "programa": "nome ou null", "confianca": 0.0 a 1.0, "participantes": [{"nome": "...(nome oficial)", "papel": "narrador|comentarista|reporter|apresentador"}]}

Título: ${titulo || ""}
Descrição: ${truncar(descricao, 800)}
Trecho da transcrição: ${truncar(transcricao, MAX_TRANSCRICAO_CHARS)}`;

  let response;
  try {
    response = await ai.run(MODEL, { messages: [{ role: "user", content: prompt }] });
  } catch (error) {
    return { erro: `Falha ao chamar a IA: ${error}` };
  }

  const parsed = extrairJson(response?.response);

  if (!parsed) {
    return { erro: "A IA não devolveu uma resposta interpretável." };
  }

  const papeisValidos = new Set(["narrador", "comentarista", "reporter", "apresentador"]);

  const participantes = (Array.isArray(parsed.participantes) ? parsed.participantes : [])
    .filter((p) => p?.nome && nomeCanonicoPorVariante.has(String(p.nome).toLowerCase()) && papeisValidos.has(p.papel))
    .map((p) => ({ nome: nomeCanonicoPorVariante.get(p.nome.toLowerCase()), papel: p.papel }));

  const tipoConteudo = parsed.tipo_conteudo ? tiposConteudoLower.get(String(parsed.tipo_conteudo).toLowerCase()) || null : null;

  return {
    tipoConteudo,
    competicao: parsed.competicao ? String(parsed.competicao).trim() : null,
    programa: parsed.programa ? String(parsed.programa).trim() : null,
    confianca: Number(parsed.confianca) || null,
    participantes,
    erro: null,
  };
}
