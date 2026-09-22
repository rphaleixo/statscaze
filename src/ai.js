// Sugestões via Workers AI (IA da própria Cloudflare, sem chave extra):
// classificação do vídeo (tipo de conteúdo + competição/programa) e quem
// participou. O resultado é sempre uma SUGESTÃO — quem confirma e grava
// como dado oficial do vídeo é a pessoa usando a interface.

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
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
// participantes: [{ nome, papel }], só com nomes que baterem com a lista de
// pessoas já cadastradas (evita a IA inventar gente que não existe no elenco).
export async function sugerirClassificacao(ai, { titulo, descricao, transcricao, competicoesConhecidas, programasConhecidas, pessoasConhecidas }) {
  const nomesConhecidos = (pessoasConhecidas || []).map((p) => p.nome);

  const prompt = `Você analisa um vídeo de um canal de TV/YouTube esportivo a partir do título, descrição e um trecho da transcrição, e devolve uma classificação em JSON.

Primeiro decida o TIPO DE CONTEÚDO, que só pode ser um destes três:
- "transmissao": cobertura ao vivo ou gravada de uma competição/jogo/evento esportivo. Pode ter narrador, comentarista(s) e/ou repórter.
- "programa": um programa de estúdio (debate, análise, entrevista). Tem apresentador(es).
- "especial": qualquer outra coisa que não se encaixe bem nos dois anteriores.

Se for "transmissao", identifique a COMPETIÇÃO (ex.: "Brasileirão Série A", "Premier League"). Competições já usadas neste canal, para manter nomes consistentes (reaproveite uma se o vídeo pertencer a ela): ${competicoesConhecidas?.length ? competicoesConhecidas.join(", ") : "nenhuma cadastrada ainda"}.

Se for "programa", identifique o nome do PROGRAMA. Programas já usados neste canal: ${programasConhecidas?.length ? programasConhecidas.join(", ") : "nenhum cadastrado ainda"}.

Depois, veja se alguma destas pessoas já cadastradas no elenco do canal é claramente mencionada no título, descrição ou transcrição, e qual papel ela teve NESTE vídeo (narrador, comentarista, reporter ou apresentador — use "reporter" sem acento). Só inclua pessoas desta lista, nunca invente nomes novos: ${nomesConhecidos.length ? nomesConhecidos.join(", ") : "nenhuma pessoa cadastrada ainda"}.

Responda SOMENTE com um objeto JSON, sem nenhum texto antes ou depois, no formato:
{"tipo_conteudo": "transmissao" | "programa" | "especial" | null, "competicao": "nome ou null", "programa": "nome ou null", "confianca": 0.0 a 1.0, "participantes": [{"nome": "...", "papel": "narrador|comentarista|reporter|apresentador"}]}

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

  const nomesConhecidosLower = new Set(nomesConhecidos.map((n) => n.toLowerCase()));
  const papeisValidos = new Set(["narrador", "comentarista", "reporter", "apresentador"]);

  const participantes = (Array.isArray(parsed.participantes) ? parsed.participantes : [])
    .filter((p) => p?.nome && nomesConhecidosLower.has(String(p.nome).toLowerCase()) && papeisValidos.has(p.papel))
    .map((p) => ({ nome: nomesConhecidos.find((n) => n.toLowerCase() === p.nome.toLowerCase()), papel: p.papel }));

  return {
    tipoConteudo: ["transmissao", "programa", "especial"].includes(parsed.tipo_conteudo) ? parsed.tipo_conteudo : null,
    competicao: parsed.competicao ? String(parsed.competicao).trim() : null,
    programa: parsed.programa ? String(parsed.programa).trim() : null,
    confianca: Number(parsed.confianca) || null,
    participantes,
    erro: null,
  };
}
