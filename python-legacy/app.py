"""
Interface do mapeador/transcritor de vídeos da Cazé TV.

Como usar:
  1. Instale as dependências (uma vez só):
       pip install -r requirements.txt
  2. Rode (se "streamlit" sozinho não funcionar no seu terminal, use
     "python -m streamlit run app.py" ou "py -m streamlit run app.py"):
       streamlit run app.py
  3. O navegador abre sozinho com a interface.

O processo tem dois momentos separados, cada um com seu próprio botão:
  1. Mapeamento — lista todos os vídeos do canal no período escolhido
     (lives, shorts e/ou vídeos normais) e busca os dados de cada um
     (título, descrição, duração, views, comentários, chat). Rápido.
  2. Transcrição — busca a transcrição de cada vídeo já mapeado.
     Mais lento (por isso é uma etapa separada), e por padrão pula
     vídeos que já têm transcrição salva de uma execução anterior.

Durante os dois, a tela principal mostra em tempo real: barra de
progresso, tempo estimado restante (ETA) e um log com o que está
sendo tentado em cada vídeo.
"""

import io
import json
import os
import time
from datetime import date, datetime, timedelta

import pandas as pd
import streamlit as st

import coletor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")


# =========================================================
# CONFIGURAÇÃO PERSISTIDA LOCALMENTE (chave de API, canal)
# =========================================================

def load_config() -> dict:

    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as file:
            return json.load(file)

    return {}


def save_config(config: dict):

    with open(CONFIG_PATH, "w", encoding="utf-8") as file:
        json.dump(config, file, ensure_ascii=False, indent=2)


def format_seconds(seconds: float) -> str:

    seconds = max(0, int(seconds))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)

    if hours:
        return f"{hours}h{minutes:02d}m"

    return f"{minutes}m{seconds:02d}s"


# =========================================================
# COMPONENTES DE ACOMPANHAMENTO EM TEMPO REAL (tela principal)
# =========================================================

def make_progress_cb(progress_placeholder, phase_label: str):

    start_time = time.time()

    def progress_cb(index: int, total: int):

        fraction = index / total if total else 1.0
        elapsed = time.time() - start_time
        avg_per_item = elapsed / index if index else 0
        eta_seconds = avg_per_item * max(0, total - index)

        progress_placeholder.progress(
            fraction,
            text=f"{phase_label}: {index}/{total} — tempo restante estimado: {format_seconds(eta_seconds)}",
        )

    return progress_cb


def make_log_cb(log_placeholder, session_key: str):

    if session_key not in st.session_state:
        st.session_state[session_key] = []

    def log_cb(message: str):

        timestamp = datetime.now().strftime("%H:%M:%S")
        st.session_state[session_key].append(f"[{timestamp}] {message}")
        st.session_state[session_key] = st.session_state[session_key][-500:]

        log_placeholder.code("\n".join(st.session_state[session_key]), language=None)

    return log_cb


# =========================================================
# INTERFACE
# =========================================================

st.set_page_config(page_title="Cazé TV — Mapeador de Vídeos", layout="wide")
st.title("Cazé TV — Mapeador de Vídeos")

coletor.init_db()
saved_config = load_config()

with st.sidebar:

    st.header("Configuração")

    api_key = st.text_input(
        "Chave da API do YouTube",
        value=saved_config.get("api_key", ""),
        type="password",
    )

    channel_handle = st.text_input(
        "Canal (handle, sem @)",
        value=saved_config.get("channel_handle", "CazeTV"),
    )

    save_key = st.checkbox("Lembrar essas informações neste computador", value=True)

    st.divider()
    st.header("Período e tipo")

    default_start = date.today() - timedelta(days=30)
    date_range = st.date_input(
        "Período",
        value=(default_start, date.today()),
        max_value=date.today(),
    )

    tipo_labels = {v: k for k, v in coletor.CONTENT_TYPES.items()}
    tipos_selecionados_labels = st.multiselect(
        "Tipo de conteúdo",
        options=list(coletor.CONTENT_TYPES.values()),
        default=list(coletor.CONTENT_TYPES.values()),
    )
    content_types = [tipo_labels[label] for label in tipos_selecionados_labels]

    st.divider()
    st.header("Etapa 1 — Mapeamento")
    st.caption("Lista os vídeos do período e busca título, descrição, duração, views, comentários e chat.")
    mapear_clicked = st.button("Mapear vídeos", use_container_width=True)

    st.divider()
    st.header("Etapa 2 — Transcrição")
    reprocess_transcripts = st.checkbox(
        "Reprocessar vídeos que já têm transcrição",
        value=False,
        help="Deixe desmarcado para não repetir trabalho já feito.",
    )
    transcrever_clicked = st.button("Buscar transcrições", use_container_width=True)

    if len(date_range) == 2:
        date_from, date_to = date_range
    else:
        date_from, date_to = default_start, date.today()

    if save_key and api_key.strip():
        save_config({"api_key": api_key, "channel_handle": channel_handle})


st.subheader("Execução")
execucao_progress = st.empty()
execucao_log = st.empty()
execucao_status = st.empty()


def validar_config() -> bool:

    if not api_key.strip():
        st.error("Cole sua chave da API do YouTube na barra lateral antes de continuar.")
        return False

    if len(date_range) != 2:
        st.error("Selecione um período completo (data inicial e final) na barra lateral.")
        return False

    if not content_types:
        st.error("Selecione pelo menos um tipo de conteúdo na barra lateral.")
        return False

    return True


if mapear_clicked and validar_config():

    log_cb = make_log_cb(execucao_log, "log_mapeamento")
    progress_cb = make_progress_cb(execucao_progress, "Mapeamento")

    try:
        total = coletor.collect_metadata(
            api_key=api_key,
            channel_handle=channel_handle,
            date_from=date_from,
            date_to=date_to,
            content_types=content_types,
            progress_cb=progress_cb,
            log_cb=log_cb,
        )
        execucao_status.success(f"Mapeamento concluído: {total} vídeo(s).")
    except Exception as error:  # noqa: BLE001
        execucao_status.error(f"Erro durante o mapeamento: {error}")


if transcrever_clicked and validar_config():

    pendentes = coletor.get_video_ids_pending_transcript(
        date_from=date_from, date_to=date_to, content_types=content_types,
    )

    alvo = pendentes if not reprocess_transcripts else None

    if alvo is None:
        # reprocessar tudo do período/tipo, não só os pendentes
        df_periodo = coletor.get_videos_df(date_from=date_from, date_to=date_to, content_types=content_types)
        alvo = df_periodo["video_id"].tolist()

    if not alvo:
        execucao_status.info(
            "Nenhum vídeo pendente de transcrição nesse período/tipo. "
            "Rode o mapeamento primeiro, ou marque 'Reprocessar' para refazer."
        )
    else:

        log_cb = make_log_cb(execucao_log, "log_transcricao")
        progress_cb = make_progress_cb(execucao_progress, "Transcrição")

        try:
            total = coletor.collect_transcripts(
                video_ids=alvo,
                reprocess_transcripts=reprocess_transcripts,
                progress_cb=progress_cb,
                log_cb=log_cb,
            )
            execucao_status.success(f"Transcrição concluída: {total} vídeo(s) processados.")
        except Exception as error:  # noqa: BLE001
            execucao_status.error(f"Erro durante a transcrição: {error}")


# ---------- Área principal: consumir os dados ----------

st.divider()

tab_videos, tab_dashboards, tab_enriquecimento = st.tabs(
    ["Vídeos", "Dashboards", "Enriquecimento (IA)"]
)

df = coletor.get_videos_df(
    date_from=date_from,
    date_to=date_to,
    content_types=content_types or list(coletor.CONTENT_TYPES.keys()),
)

if not df.empty:
    df["duracao"] = df["duracao_segundos"].apply(
        lambda v: coletor.format_timestamp(v) if pd.notna(v) else ""
    )


with tab_videos:

    st.subheader(f"{len(df)} vídeo(s) no período/tipo selecionado")

    if df.empty:
        st.info("Nenhum dado salvo ainda para esse período/tipo. Rode o mapeamento na barra lateral.")
    else:

        colunas_exibicao = [
            "tipo_conteudo", "titulo", "data_publicacao", "duracao", "views",
            "comentarios", "mensagens_chat", "competicao", "elenco",
            "transcricao_sucesso", "url",
        ]

        st.dataframe(df[colunas_exibicao], use_container_width=True, hide_index=True)

        col1, col2 = st.columns(2)

        with col1:
            st.download_button(
                "Baixar como CSV",
                data=df.to_csv(index=False).encode("utf-8-sig"),
                file_name="videos_cazetv.csv",
                mime="text/csv",
                use_container_width=True,
            )

        with col2:
            excel_buffer = io.BytesIO()
            df_excel = df.copy()
            df_excel["elenco"] = df_excel["elenco"].apply(lambda v: ", ".join(v) if isinstance(v, list) else v)
            df_excel.to_excel(excel_buffer, index=False, engine="openpyxl")

            st.download_button(
                "Baixar como Excel (.xlsx)",
                data=excel_buffer.getvalue(),
                file_name="videos_cazetv.xlsx",
                mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                use_container_width=True,
            )


with tab_dashboards:

    if df.empty:
        st.info("Sem dados para mostrar ainda. Rode o mapeamento na barra lateral primeiro.")
    else:

        col1, col2, col3, col4 = st.columns(4)
        col1.metric("Vídeos", len(df))
        col2.metric("Views (soma)", f"{int(df['views'].fillna(0).sum()):,}".replace(",", "."))
        col3.metric("Comentários (soma)", f"{int(df['comentarios'].fillna(0).sum()):,}".replace(",", "."))
        col4.metric("Com transcrição", f"{int(df['transcricao_sucesso'].fillna(0).sum())}/{len(df)}")

        st.markdown("**Vídeos por tipo de conteúdo**")
        st.bar_chart(df["tipo_conteudo"].map(coletor.CONTENT_TYPES).value_counts())

        st.markdown("**Views por dia de publicação**")
        df_por_dia = (
            df.assign(dia=pd.to_datetime(df["data_publicacao"]).dt.date)
            .groupby("dia")["views"]
            .sum()
        )
        st.bar_chart(df_por_dia)

        st.markdown("**Top 10 vídeos por views**")
        top10 = df.nlargest(10, "views")[["titulo", "tipo_conteudo", "duracao", "views", "url"]]
        st.dataframe(top10, use_container_width=True, hide_index=True)

        st.divider()
        st.markdown("**Por competição / elenco**")

        com_competicao = df[df["competicao"].notna() & (df["competicao"] != "")]

        if com_competicao.empty:
            st.info(
                "Nenhum vídeo tem competição/elenco identificados ainda. "
                "Essa seção preenche automaticamente assim que essa informação "
                "for adicionada (pela IA ou na aba 'Enriquecimento')."
            )
        else:
            st.markdown("Vídeos por competição")
            st.bar_chart(com_competicao["competicao"].value_counts())

            st.markdown("Views somadas por competição")
            st.bar_chart(com_competicao.groupby("competicao")["views"].sum())


with tab_enriquecimento:

    st.markdown(
        "Aqui entra a informação complementar de cada vídeo — **competição** "
        "e **elenco envolvido** — extraída por uma IA a partir da descrição e "
        "da transcrição. Três formas de preencher: editar direto na tabela "
        "abaixo, importar um CSV, ou (para uma IA externa) chamar "
        "`coletor.update_enrichment(video_id, competicao, elenco)` diretamente."
    )

    if df.empty:
        st.info("Sem vídeos para enriquecer ainda.")
    else:

        st.markdown("#### Exportar dados para a IA processar")
        st.caption(
            "Inclui descrição e transcrição completa de cada vídeo — o que a "
            "IA precisa para identificar competição e elenco."
        )

        df_para_ia = df[["video_id", "titulo", "url", "descricao", "transcricao_completa", "competicao", "elenco"]].copy()
        df_para_ia["elenco"] = df_para_ia["elenco"].apply(lambda v: ", ".join(v) if isinstance(v, list) else v)

        st.download_button(
            "Baixar CSV para preenchimento (com descrição + transcrição)",
            data=df_para_ia.to_csv(index=False).encode("utf-8-sig"),
            file_name="videos_para_enriquecimento.csv",
            mime="text/csv",
        )

        st.divider()
        st.markdown("#### Importar CSV preenchido")
        st.caption(
            "O CSV precisa ter as colunas `video_id`, `competicao` e `elenco` "
            "(elenco com nomes separados por vírgula). Outras colunas são ignoradas."
        )

        uploaded_csv = st.file_uploader("Selecionar CSV", type=["csv"])

        if uploaded_csv is not None:

            try:
                df_import = pd.read_csv(uploaded_csv, dtype=str).fillna("")
            except Exception as error:  # noqa: BLE001
                st.error(f"Não consegui ler esse CSV: {error}")
                df_import = None

            if df_import is not None:

                colunas_necessarias = {"video_id", "competicao", "elenco"}

                if not colunas_necessarias.issubset(df_import.columns):
                    st.error(
                        f"O CSV precisa ter as colunas {sorted(colunas_necessarias)}. "
                        f"Encontrei: {list(df_import.columns)}."
                    )
                else:

                    ids_conhecidos = set(df["video_id"])
                    atualizados, nao_encontrados = 0, []

                    if st.button("Aplicar importação"):

                        for _, linha in df_import.iterrows():

                            video_id = linha["video_id"].strip()

                            if video_id not in ids_conhecidos:
                                nao_encontrados.append(video_id)
                                continue

                            elenco_lista = [
                                nome.strip() for nome in linha["elenco"].split(",") if nome.strip()
                            ]

                            coletor.update_enrichment(
                                video_id,
                                linha["competicao"].strip() or None,
                                elenco_lista or None,
                            )
                            atualizados += 1

                        st.success(f"{atualizados} vídeo(s) atualizado(s) a partir do CSV.")

                        if nao_encontrados:
                            st.warning(
                                f"{len(nao_encontrados)} video_id(s) do CSV não foram encontrados "
                                f"no período/tipo selecionado: {', '.join(nao_encontrados[:10])}"
                                + ("..." if len(nao_encontrados) > 10 else "")
                            )

                        st.rerun()

        st.divider()
        st.markdown("#### Editar manualmente")

        df_editor = df[["video_id", "titulo", "competicao", "elenco"]].copy()
        df_editor["elenco"] = df_editor["elenco"].apply(
            lambda v: ", ".join(v) if isinstance(v, list) else (v or "")
        )

        edited = st.data_editor(
            df_editor,
            use_container_width=True,
            hide_index=True,
            disabled=["video_id", "titulo"],
            column_config={"elenco": st.column_config.TextColumn("elenco (separado por vírgula)")},
            key="editor_enriquecimento",
        )

        if st.button("Salvar alterações manuais"):

            alteracoes = 0

            for _, row in edited.iterrows():

                elenco_lista = [
                    nome.strip() for nome in (row["elenco"] or "").split(",") if nome.strip()
                ]

                coletor.update_enrichment(row["video_id"], row["competicao"] or None, elenco_lista or None)
                alteracoes += 1

            st.success(f"{alteracoes} vídeo(s) atualizado(s).")
            st.rerun()
