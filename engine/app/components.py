"""단계 구현을 바꿔 끼우는 형식. 청킹·임베딩(나중에 리랭크·답변)마다 로컬과 외부 구현을 같은 모양으로 둔다.

- 구현마다 Spec(이름, 로컬/외부, 파라미터 목록, 상태)을 갖는다. 웹은 catalog()로 받은 Spec을 보고 선택지와 입력칸을 그린다.
- 단계 설정은 {"id": 구현 이름, "params": {...}} 모양의 dict로 주고받는다. normalize()가 기본값을 채우고 값을 검사한다.
- 외부로 나가는 구현(external)에 외부 전송 불가 문서를 넣지 않게 하는 검사는 check_external() 한 곳에서만 한다.

OpenAI 임베딩 사양 (2026-11-09 공식 문서 확인):
  https://developers.openai.com/api/docs/guides/embeddings
  https://developers.openai.com/api/reference/resources/embeddings/methods/create
  - text-embedding-3-small 1536차원, text-embedding-3-large 3072차원. dimensions로 줄일 수 있다.
  - 입력 하나 최대 8192토큰, 토크나이저 cl100k_base. 한 요청에 최대 2048개, 합계 300,000토큰.
  - 돌려주는 벡터는 길이 1로 정규화돼 있다 (코사인 거리 검색에 그대로 쓴다).

TEI 리랭커 (2026-11-10 공식 문서 확인):
  https://huggingface.co/docs/text-embeddings-inference/quick_tour  (POST /rerank: query, texts → [{index, score}])
  https://huggingface.co/docs/text-embeddings-inference/supported_models  (XLM-RoBERTa 리랭커 지원)
  - bge-reranker-v2-m3는 XLM-RoBERTa 구조라 지원 대상. 띄워서 /info로 확인함 (max_client_batch_size 32).
  - raw_scores=false면 0~1 점수(시그모이드). 쌍마다 따로 매기므로 나눠 보내도 점수가 바뀌지 않는다.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Callable

from ingest import MAX_TOKENS, count_tokens, embed, embed_url, make_embed_text, split_sections, tei_post


# 구현이 받을 수 있는 설정값 하나. kind는 지금 'choice'만 쓴다 (잘못된 값을 넣을 수 없게 선택지로만 받는다).
@dataclass(frozen=True)
class Param:
    name: str
    label: str
    default: str
    choices: tuple[tuple[str, str], ...]  # (값, 화면에 보일 이름)
    help: str = ""
    kind: str = "choice"
    always_shown: bool = False   # 기본값이어도 짧은 이름(describe)에 넣는다 (예: 모델 이름)


# 구현 하나의 설명. provider: local(이 서버 안) / external(외부 API로 글이 나간다). status: ready / planned(준비 중).
@dataclass(frozen=True)
class Spec:
    id: str
    stage: str
    label: str
    description: str
    provider: str
    vendor: str
    params: tuple[Param, ...] = ()
    status: str = "ready"

    @property
    def external(self) -> bool:
        return self.provider == "external"


class ComponentError(Exception):
    """사용자에게 보여 줄 단계 구현 오류 (설정값이 틀림, API 실패 등). 비밀값은 메시지에 넣지 않는다."""


# 청킹 결과 조각 하나. content는 답변 근거로 보여 줄 원문, embed_text는 실제로 임베딩할 글.
@dataclass
class Chunk:
    heading_path: list[str]
    content: str
    embed_text: str


# ---------- 청킹 ----------

class HeadingChunker:
    spec = Spec(
        id="heading", stage="chunker", label="Heading sections",
        description="Split at ## and ### headings. One section becomes one chunk.",
        provider="local", vendor="rag-ops",
        params=(Param("prefix", "Text that gets embedded", "path",
                      (("path", "Heading path + section"), ("none", "Section only")),
                      help="Heading path adds the ## > ### titles in front of each section before embedding."),),
    )

    def __init__(self, params: dict[str, str]):
        self.prefix = params["prefix"]

    def split(self, text: str, title: str) -> list[Chunk]:
        out = []
        for s in split_sections(text, title):
            embed_text = make_embed_text(s.heading_path, s.body) if self.prefix == "path" else s.body
            out.append(Chunk(s.heading_path, s.body, embed_text))
        return out


# ---------- 임베딩 ----------

class TeiEmbedder:
    spec = Spec(
        id="tei-bge-m3", stage="embedder", label="bge-m3",
        description="Runs on the local TEI server. Multilingual, 1024 dimensions, up to 2048 tokens per chunk.",
        provider="local", vendor="BAAI · TEI",
    )

    def __init__(self, params: dict[str, str], env: dict[str, str]):
        self.base = embed_url(env)
        self.dims = 1024
        self.max_tokens = MAX_TOKENS
        self.usage_tokens = 0

    @staticmethod
    def availability(env: dict[str, str]) -> tuple[bool, str]:
        return True, ""

    @staticmethod
    def dims_for(params: dict[str, str]) -> int:
        return 1024

    def count_tokens(self, texts: list[str]) -> list[int]:
        return count_tokens(self.base, texts)

    def embed(self, texts: list[str], on_batch: Callable[[int, int], None] | None = None) -> list[list[float]]:
        return embed(self.base, texts, on_batch)

    def embed_query(self, text: str) -> list[float]:
        return tei_post(f"{self.base}/embed", {"inputs": text})[0]


OPENAI_MODELS = {"text-embedding-3-small": 1536, "text-embedding-3-large": 3072}
OPENAI_BATCH = 64          # 한 요청에 보낼 조각 수 (API 한도 2048개·300,000토큰보다 한참 작게)
_cl100k = None             # tiktoken 인코딩은 불러오는 데 시간이 걸려서 한 번만 만든다


# OpenAI 단가 (USD, 100만 토큰당, Standard). API가 단가를 알려 주지 않으므로 바뀌면 여기를 고친다.
# 출처: https://developers.openai.com/api/docs/pricing (확인 PRICE_CHECKED). 캐시 단가가 없는 모델은 입력 단가로 계산한다(많게 잡힘).
PRICE_CHECKED = "2026-11-10"
PRICES = {
    "gpt-6-luna": {"input": 0.10, "cached": 0.01, "output": 0.50},
    "gpt-6.1-terra": {"input": 1.00, "output": 5.00},
    "text-embedding-3-small": {"input": 0.02},
    "text-embedding-3-large": {"input": 0.13},
}


# 토큰 수로 금액(USD)을 계산한다. 단가를 모르는 모델이면 None.
def cost_usd(model: str, input_tokens: int, output_tokens: int = 0, cached_tokens: int = 0) -> float | None:
    p = PRICES.get(model)
    if p is None:
        return None
    usd = ((input_tokens - cached_tokens) * p["input"] + cached_tokens * p.get("cached", p["input"])
           + output_tokens * p.get("output", 0)) / 1_000_000
    return round(usd, 8)


def openai_base(env: dict[str, str]) -> str:
    return env.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")


# OpenAI API에 JSON을 보내고 JSON을 받는다. 요청 한도 초과(429)·서버 오류(5xx)·연결 실패는 잠깐 기다렸다 다시 보낸다 (최대 4번).
def openai_post(base: str, path: str, key: str, body: dict, timeout: float = 120) -> dict:
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if (e.code == 429 or e.code >= 500) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            try:
                message = json.load(e).get("error", {}).get("message", "")
            except (ValueError, AttributeError):
                message = ""
            raise ComponentError(f"OpenAI API {e.code}: {message or e.reason}") from None
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise ComponentError(f"OpenAI API unreachable: {e.reason}") from None
    raise ComponentError("OpenAI API failed after retries")


class OpenAIEmbedder:
    spec = Spec(
        id="openai", stage="embedder", label="OpenAI embeddings",
        description="Sends chunk text to the OpenAI API. Up to 8192 tokens per chunk.",
        provider="external", vendor="OpenAI",
        params=(
            Param("model", "Model", "text-embedding-3-small",
                  (("text-embedding-3-small", "text-embedding-3-small · 1536"), ("text-embedding-3-large", "text-embedding-3-large · 3072")),
                  always_shown=True),
            Param("dimensions", "Dimensions", "default",
                  (("default", "Model default"), ("1024", "1024"), ("512", "512"), ("256", "256")),
                  help="Fewer dimensions are smaller and faster to compare, and may lose some quality."),
        ),
    )

    def __init__(self, params: dict[str, str], env: dict[str, str]):
        ok, reason = self.availability(env)
        if not ok:
            raise ComponentError(reason)
        self.key = env["OPENAI_API_KEY"]
        self.base = openai_base(env)
        self.model = params["model"]
        self.dims = self.dims_for(params)
        self.payload_dims = None if params["dimensions"] == "default" else self.dims
        self.max_tokens = 8192
        self.usage_tokens = 0   # API가 알려 준 실제 토큰 수 합계 (비용 확인용)

    @staticmethod
    def availability(env: dict[str, str]) -> tuple[bool, str]:
        if not env.get("OPENAI_API_KEY"):
            return False, "OPENAI_API_KEY is not set in .env"
        return True, ""

    @staticmethod
    def dims_for(params: dict[str, str]) -> int:
        return OPENAI_MODELS[params["model"]] if params["dimensions"] == "default" else int(params["dimensions"])

    def count_tokens(self, texts: list[str]) -> list[int]:
        global _cl100k
        if _cl100k is None:
            import tiktoken
            _cl100k = tiktoken.get_encoding("cl100k_base")
        return [len(_cl100k.encode(t)) for t in texts]

    def _post(self, inputs: list[str]) -> list[list[float]]:
        body = {"model": self.model, "input": inputs}
        if self.payload_dims:
            body["dimensions"] = self.payload_dims
        data = openai_post(self.base, "/embeddings", self.key, body)
        self.usage_tokens += data.get("usage", {}).get("total_tokens", 0)
        return [d["embedding"] for d in sorted(data["data"], key=lambda d: d["index"])]

    def embed(self, texts: list[str], on_batch: Callable[[int, int], None] | None = None) -> list[list[float]]:
        vecs: list[list[float]] = []
        for i in range(0, len(texts), OPENAI_BATCH):
            vecs.extend(self._post(texts[i:i + OPENAI_BATCH]))
            if on_batch:
                on_batch(len(vecs), len(texts))
        return vecs

    def embed_query(self, text: str) -> list[float]:
        return self._post([text])[0]


# ---------- 리랭크 ----------

# 한 요청에 보낼 조각 수. TEI 한도는 32개지만, Mac Docker(CPU)에서는 조각 1개에 평균 3.4초라 32개면 2분을 넘는다.
# 작게 나눠 보내 요청 하나가 제한 시간(RERANK_TIMEOUT)을 넘지 않게 한다. 쌍마다 따로 점수를 매기므로 나눠도 점수는 같다.
RERANK_BATCH = 8
RERANK_TIMEOUT = 300


def rerank_url(env: dict[str, str]) -> str:
    return env.get("RERANK_URL") or f"http://127.0.0.1:{env.get('RERANK_PORT', '8081')}"


class TeiReranker:
    spec = Spec(
        id="tei-bge-reranker", stage="reranker", label="bge-reranker-v2-m3",
        description="Reads the question and each candidate chunk together on the local TEI server and scores them 0–1.",
        provider="local", vendor="BAAI · TEI",
        params=(Param("candidates", "Candidates from vector search", "50", (("10", "10"), ("20", "20"), ("50", "50")),
                      help="Vector search hands this many chunks to the reranker. More finds more answers, but reranking takes longer.",
                      always_shown=True),),
    )

    def __init__(self, params: dict[str, str], env: dict[str, str]):
        self.base = rerank_url(env)
        self.candidates = int(params["candidates"])

    # 리랭커 컨테이너가 떠 있는지. /health는 모델을 한 번 돌려 봐서 리랭크 중에는 몇 초씩 늦으므로, 모델을 쓰지 않는 /info로 본다.
    @staticmethod
    def availability(env: dict[str, str]) -> tuple[bool, str]:
        try:
            with urllib.request.urlopen(f"{rerank_url(env)}/info", timeout=1.5):
                return True, ""
        except (urllib.error.URLError, OSError):
            return False, "Reranker server is not running (docker compose up -d rerank)"

    # texts와 같은 순서로 점수를 돌려준다. TEI는 점수 순으로 정렬해 돌려주므로 index로 제자리에 놓는다.
    def score(self, query: str, texts: list[str]) -> list[float]:
        scores = [0.0] * len(texts)
        for start in range(0, len(texts), RERANK_BATCH):
            part = texts[start:start + RERANK_BATCH]
            try:
                out = tei_post(f"{self.base}/rerank", {"query": query, "texts": part, "raw_scores": False}, RERANK_TIMEOUT)
            except (urllib.error.URLError, OSError) as e:
                raise ComponentError(f"Reranker request failed: {e}") from None
            for item in out:
                scores[start + item["index"]] = float(item["score"])
        return scores


# ---------- 목록 ----------

# ---------- 답변 생성 ----------

# LLM에 주는 규칙. 답변 보류 기준은 아직 정하지 않았다(사용자가 정함). 지금은 "근거에 없으면 없다고 말하기"만 둔다.
ANSWER_RULES = (
    "Answer the question using only the numbered sources. Reply in the language of the question, briefly.\n"
    "Cite the sources you used inline as [1], [2].\n"
    "If the sources do not contain the answer, say it is not in the documents. Do not guess.\n"
    "Sources describe configuration as written; do not claim it is currently running."
)


# OpenAI Responses API로 답을 쓴다. 출처: https://developers.openai.com/api/docs/models (gpt-6-luna 가격·용도),
# 요청·응답 모양(instructions, input, max_output_tokens, reasoning.effort, store, output[].content[].text, usage)은 2026-11-10 실제 호출로 확인.
# 토큰 절약: 생각 단계 끔(effort none), 조각은 원문(content)만, 보낼 조각 수와 답 길이를 파라미터로 제한, 응답 저장 안 함(store false).
class OpenAIGenerator:
    spec = Spec(
        id="openai-llm", stage="generator", label="OpenAI LLM",
        description="Sends the question and the top chunks to the OpenAI API and writes a short answer with [n] citations.",
        provider="external", vendor="OpenAI",
        params=(
            Param("model", "Model", "gpt-6-luna",
                  (("gpt-6-luna", "gpt-6-luna · cheapest"), ("gpt-6.1-terra", "gpt-6.1-terra · 10x price")), always_shown=True),
            Param("sources", "Chunks sent", "3", (("3", "Top 3"), ("5", "Top 5")),
                  help="Fewer chunks means fewer tokens. In the evaluation the right chunk was in the top 3 for every question."),
            Param("max_output", "Answer length", "400",
                  (("200", "Short · up to 200 tokens"), ("400", "Normal · up to 400 tokens"), ("800", "Long · up to 800 tokens"))),
        ),
    )

    def __init__(self, params: dict[str, str], env: dict[str, str]):
        ok, reason = self.availability(env)
        if not ok:
            raise ComponentError(reason)
        self.key, self.base = env["OPENAI_API_KEY"], openai_base(env)
        self.model, self.sources, self.max_output = params["model"], int(params["sources"]), int(params["max_output"])

    availability = staticmethod(OpenAIEmbedder.availability)

    # sources: [(번호, 제목 줄, 원문)]. 번호는 화면의 근거 순위와 같게 넘겨받는다.
    def generate(self, question: str, sources: list[tuple[int, str, str]]) -> dict:
        text = "\n\n".join(f"[{n}] {head}\n{body}" for n, head, body in sources)
        body = {"model": self.model, "instructions": ANSWER_RULES, "input": f"Question: {question}\n\nSources:\n{text}",
                "max_output_tokens": self.max_output, "reasoning": {"effort": "none"}, "store": False}
        data = openai_post(self.base, "/responses", self.key, body, timeout=90)
        answer = "".join(c.get("text", "") for o in data.get("output", []) if o.get("type") == "message"
                         for c in o.get("content", []) if c.get("type") == "output_text")
        usage = data.get("usage", {})
        tin, tout = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
        return {"text": answer.strip(), "status": data.get("status"), "model": self.model,
                "input_tokens": tin, "output_tokens": tout, "cached_tokens": cached,
                "cost_usd": cost_usd(self.model, tin, tout, cached)}


CHUNKERS = {c.spec.id: c for c in (HeadingChunker,)}
EMBEDDERS = {e.spec.id: e for e in (TeiEmbedder, OpenAIEmbedder)}
RERANKERS = {r.spec.id: r for r in (TeiReranker,)}
GENERATORS = {g.spec.id: g for g in (OpenAIGenerator,)}

# 아직 구현하지 않은 단계. 화면에 "준비 중"으로 보여 줘서 앞으로 무엇이 들어올 자리인지 알 수 있게 한다.
PLANNED = (
    Spec("external-reranker", "reranker", "External reranker", "Re-scores the retrieved chunks with an external API.", "external", "—", status="planned"),
    Spec("local-llm", "generator", "Local LLM", "Writes the answer on this machine.", "local", "—", status="planned"),
)


def _registry(stage: str) -> dict:
    return {"chunker": CHUNKERS, "embedder": EMBEDDERS, "reranker": RERANKERS, "generator": GENERATORS}.get(stage, {})


# 단계 설정을 검사하고 기본값을 채운다. 모르는 구현·파라미터·선택지에 없는 값이면 ComponentError.
def normalize(stage: str, setting: dict[str, Any] | None) -> dict[str, Any]:
    registry = _registry(stage)
    setting = setting or {}
    impl = registry.get(setting.get("id", ""))
    if impl is None:
        raise ComponentError(f"Unknown {stage}: {setting.get('id')!r}")
    given = setting.get("params") or {}
    unknown = set(given) - {p.name for p in impl.spec.params}
    if unknown:
        raise ComponentError(f"Unknown {stage} parameter: {', '.join(sorted(unknown))}")
    params = {}
    for p in impl.spec.params:
        value = str(given.get(p.name, p.default))
        if value not in {v for v, _ in p.choices}:
            raise ComponentError(f"{impl.spec.label}: {p.label} cannot be {value!r}")
        params[p.name] = value
    return {"id": impl.spec.id, "params": params}


# 색인을 구분하는 키. 기본값까지 채운 설정을 정렬해서 만들기 때문에 같은 조합은 늘 같은 키가 된다.
def index_key(chunker: dict, embedder: dict) -> str:
    part = lambda s: f"{s['id']}[{','.join(f'{k}={v}' for k, v in sorted(s['params'].items()))}]"
    return f"{part(chunker)}|{part(embedder)}"


def make_chunker(setting: dict) -> HeadingChunker:
    return CHUNKERS[setting["id"]](setting["params"])


def make_embedder(setting: dict, env: dict[str, str]):
    return EMBEDDERS[setting["id"]](setting["params"], env)


def make_reranker(setting: dict, env: dict[str, str]) -> TeiReranker:
    return RERANKERS[setting["id"]](setting["params"], env)


def make_generator(setting: dict, env: dict[str, str]) -> OpenAIGenerator:
    return GENERATORS[setting["id"]](setting["params"], env)


def embedder_dims(setting: dict) -> int:
    return EMBEDDERS[setting["id"]].dims_for(setting["params"])


def is_external(stage: str, setting: dict) -> bool:
    return _registry(stage)[setting["id"]].spec.external


# 외부로 나가는 구현이면 외부 전송 불가 문서를 거절한다. 색인 만들기·추정·검색이 모두 이 함수를 거친다.
def check_external(embedder: dict, title: str, external_ok: bool, stage: str = "embedder") -> None:
    if is_external(stage, embedder) and not external_ok:
        raise ComponentError(f"'{title}' is not allowed to be sent outside (external_ok is off)")


# 사람이 읽을 짧은 이름. 예: "Heading sections · Section only", "OpenAI embeddings · text-embedding-3-small · 512"
def describe(stage: str, setting: dict) -> str:
    impl = _registry(stage)[setting["id"]]
    shown = [dict(p.choices)[setting["params"][p.name]].split(" · ")[0]
             for p in impl.spec.params if p.always_shown or setting["params"][p.name] != p.default]
    return " · ".join([impl.spec.label, *shown])


# 화면용 목록: 단계마다 구현 설명, 파라미터, 지금 쓸 수 있는지와 이유. 비밀값은 넣지 않는다 (키는 있음/없음만).
def catalog(env: dict[str, str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"chunker": [], "embedder": [], "reranker": [], "generator": []}
    for stage, registry in (("chunker", CHUNKERS), ("embedder", EMBEDDERS), ("reranker", RERANKERS), ("generator", GENERATORS)):
        for impl in registry.values():
            item = asdict(impl.spec) | {"external": impl.spec.external, "available": True, "reason": ""}
            if stage in ("reranker", "generator"):
                item["available"], item["reason"] = impl.availability(env)
            if stage == "embedder":
                item["available"], item["reason"] = impl.availability(env)
                item["max_tokens"] = 8192 if impl is OpenAIEmbedder else MAX_TOKENS
            out[stage].append(item)
    for spec in PLANNED:
        out[spec.stage].append(asdict(spec) | {"external": spec.external, "available": False, "reason": "Coming later"})
    return out
